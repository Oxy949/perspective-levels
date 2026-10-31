import { MODULE_ID } from "./constants.js";
import { getRuntimeLevelConfig as getLevelConfig } from "./config.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { getPerspectiveCellScreenHeightAtRow, getCachedPerspectiveGridModel as getPerspectiveGridModel, scaleForPerspectiveToken, screenPointToElevationGroundPoint, screenPointToPerspectiveGrid } from "./projection.js";
import { positionTokenPerspectiveFrameInfo, resetTokenPerspectiveFrameInfo } from "./token-hit-testing.js";
import { clamp } from "./utils.js";
import { getTokenArtMultiplier } from "./token-art.js";
import { buildTokenPreviewIndex, getIndexedTokenPreviews } from "./token-previews.js";
import { clearTokenOutline, updateTokenOutline, withTokenVisualsSuspended, refreshTokenRulerAlignment } from "./token-visuals.js";

const ORIGINAL_TOKEN_STATE = new WeakMap();
const TOKEN_BASE_SCALE_BY_DOCUMENT = new Map();
const TOKEN_BASE_RETRY_COUNT = new WeakMap();
const TOKEN_BASE_RETRIES = new Map();
const TOKEN_SHADOW_PREVIEWS = new WeakMap();
const TOKEN_FLIGHT_SHADOWS = new WeakMap();
const ENDED_TOKEN_SHADOW_PREVIEWS = new WeakSet();
const PERSPECTIVE_SORT_STEP = 100000;
const PERSPECTIVE_SORT_DEBOUNCE_MS = 90;
const FLIGHT_SHADOW_NAME = "PerspectiveLevels.FlightShadow";
const FLIGHT_SHADOW_COLOR = 0x000000;

let PERSPECTIVE_SORT_RAF = null;
let PERSPECTIVE_SORT_PERSIST_TIMEOUT = null;
let PERSPECTIVE_SORT_PERSIST_REQUESTED = false;
let PERSPECTIVE_SORT_PERSISTING = null;
let PERSPECTIVE_SORT_PERSIST_AGAIN = false;
let LAST_LOCAL_SORT_SIGNATURE = "";
let LAST_PERSISTED_SORT_SIGNATURE = "";
let PERSPECTIVE_SORT_FORCE_FULL = true;

const PERSPECTIVE_SORT_DIRTY_TOKENS = new Set();
const PERSPECTIVE_SORT_CACHE = new Map();

export function isTokenObject(object) {
  return object?.document?.documentName === "Token" || object?.constructor?.name === "Token";
}

export function getTokenDocumentKey(token) {
  return token?.document?.uuid
    ?? token?.document?.id
    ?? token?.id
    ?? null;
}

function getTokenSortCacheKey(token) {
  const id = token?._original?.document?.id
    ?? token?.document?.id
    ?? token?._original?.id
    ?? token?.id;
  return id === undefined || id === null ? null : String(id);
}

export function forEachToken(callback) {
  const placeables = globalThis.canvas?.tokens?.placeables ?? [];
  for (const token of placeables) callback(token);
}

function getTokenSignature(token) {
  const texture = token.document?.texture ?? {};
  return [
    texture.src ?? "",
    texture.fit ?? "",
    token.document?.width ?? "",
    token.document?.height ?? "",
    texture.scaleX ?? "",
    texture.scaleY ?? "",
    texture.anchorX ?? "",
    texture.anchorY ?? "",
    texture.offsetX ?? "",
    texture.offsetY ?? "",
    texture.rotation ?? "",
    texture.tint ?? ""
  ].join("|");
}

function getFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && Math.abs(n) > 0.000001) return n;
  }
  return null;
}

function getTextureDimension(mesh, axis) {
  const texture = mesh?.texture ?? mesh?._texture;
  const orig = texture?.orig;
  const frame = texture?.frame;
  const baseTexture = texture?.baseTexture;
  const isX = axis === "x";

  return getFiniteNumber(
    isX ? orig?.width : orig?.height,
    isX ? frame?.width : frame?.height,
    isX ? texture?.width : texture?.height,
    isX ? baseTexture?.realWidth : baseTexture?.realHeight,
    isX ? baseTexture?.width : baseTexture?.height
  );
}

function getDocumentTextureScale(token, axis) {
  const texture = token?.document?.texture ?? {};
  const raw = axis === "x" ? texture.scaleX : texture.scaleY;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
}

function getTokenLogicalSize(token, axis, rect = getSceneRect()) {
  const isX = axis === "x";
  const documentUnits = Number(isX ? token?.document?.width : token?.document?.height);
  return getFiniteNumber(
    isX ? token?.w : token?.h,
    Number.isFinite(documentUnits) ? documentUnits * rect.gridSize : null,
    isX ? token?.width : token?.height,
    rect.gridSize
  );
}

function nearlyEqual(a, b, epsilon = 1) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
}

function getMeshAnchorY(mesh) {
  const y = Number(mesh?.anchor?.y);
  return Number.isFinite(y) ? y : null;
}

function setMeshAnchorY(mesh, y) {
  if (!mesh || mesh.destroyed || !mesh.anchor) return false;

  const x = Number(mesh.anchor.x);
  const anchorX = Number.isFinite(x) ? x : 0.5;
  if (typeof mesh.anchor.set === "function") {
    mesh.anchor.set(anchorX, y);
    return true;
  }

  try {
    mesh.anchor.y = y;
    return true;
  } catch (_err) {
    return false;
  }
}

function resolveTokenBaseMeshAnchorY(token, mesh, state = null) {
  const documentAnchor = token?.document?.texture?.anchorY;
  if (documentAnchor !== undefined && documentAnchor !== null && Number.isFinite(Number(documentAnchor))) return Number(documentAnchor);

  const current = getMeshAnchorY(mesh);
  if (current === null) return null;

  const previousOffset = Number(state?.lastAnchorOffsetY ?? 0) || 0;
  if (!state || state.meshRef !== mesh || Math.abs(previousOffset) < 0.000001) return current;

  const previousBase = Number(state.baseAnchorY);
  if (Number.isFinite(previousBase) && nearlyEqual(current, previousBase + previousOffset, 0.0001)) {
    return current - previousOffset;
  }

  return current;
}

function updateTokenBaseMeshAnchorY(token, mesh, state) {
  const baseAnchorY = resolveTokenBaseMeshAnchorY(token, mesh, state);
  state.baseAnchorY = baseAnchorY;
  return baseAnchorY;
}

function restoreTokenBaseMeshAnchor(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  const mesh = token?.mesh;
  if (!state || !mesh || mesh.destroyed || state.meshRef !== mesh) return false;

  const baseAnchorY = updateTokenBaseMeshAnchorY(token, mesh, state);
  if (baseAnchorY === null) return false;

  const restored = setMeshAnchorY(mesh, baseAnchorY);
  if (restored) {
    state.lastAnchorOffsetY = 0;
    delete mesh._perspectiveLevelsAnchorOffsetY;
  }
  return restored;
}

function calculateDocumentBaseScale(token, mesh, rect = getSceneRect()) {
  const textureWidth = getTextureDimension(mesh, "x");
  const textureHeight = getTextureDimension(mesh, "y");
  const logicalWidth = getTokenLogicalSize(token, "x", rect);
  const logicalHeight = getTokenLogicalSize(token, "y", rect);

  if (!textureWidth || !textureHeight || !logicalWidth || !logicalHeight) return null;

  const widthScale = logicalWidth / textureWidth;
  const heightScale = logicalHeight / textureHeight;
  const fit = token?.document?.texture?.fit ?? "contain";
  const fitScale = fit === "cover" ? Math.max(widthScale, heightScale)
    : fit === "width" ? widthScale : fit === "height" ? heightScale : Math.min(widthScale, heightScale);

  return {
    baseScaleX: (fit === "fill" ? widthScale : fitScale) * getDocumentTextureScale(token, "x"),
    baseScaleY: (fit === "fill" ? heightScale : fitScale) * getDocumentTextureScale(token, "y"),
    baseSource: "document"
  };
}

function getAppliedMeshScale(mesh) {
  const scale = mesh?._perspectiveLevelsAppliedScale;
  return Number.isFinite(Number(scale)) && Math.abs(Number(scale)) > 0.000001 ? Number(scale) : null;
}

function calculateFallbackBaseScale(mesh) {
  const applied = getAppliedMeshScale(mesh) ?? 1;
  return {
    baseScaleX: (Number(mesh?.scale?.x) || 1) / applied,
    baseScaleY: (Number(mesh?.scale?.y) || 1) / applied,
    baseSource: "mesh"
  };
}

function scheduleBaseScaleRetry(token) {
  if (TOKEN_BASE_RETRIES.has(token) || !globalThis.canvas?.ready) return;
  const count = TOKEN_BASE_RETRY_COUNT.get(token) ?? 0;
  if (count >= 5) return;
  TOKEN_BASE_RETRY_COUNT.set(token, count + 1);

  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  const retry = { scene: globalThis.canvas.scene };
  TOKEN_BASE_RETRIES.set(token, retry);
  retry.id = raf(() => {
    if (TOKEN_BASE_RETRIES.get(token) !== retry) return;
    TOKEN_BASE_RETRIES.delete(token);
    try {
      if (!token?.destroyed && globalThis.canvas?.ready && retry.scene === globalThis.canvas.scene
        && (!token.document?.parent || token.document.parent === retry.scene)) applyPerspectiveToToken(token);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to retry token perspective base scale`, err);
    }
  });
}

function cancelBaseScaleRetry(token) {
  const retry = TOKEN_BASE_RETRIES.get(token);
  if (!retry) return;
  TOKEN_BASE_RETRIES.delete(token);
  const caf = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
  try { caf(retry.id); } catch (_err) { /* noop */ }
}

function getCurrentUser() {
  return globalThis.game?.user ?? null;
}

function canPersistSceneTokenSort() {
  return getCurrentUser()?.isGM === true;
}


function getTokenShadowKey(token) {
  return String(getTokenDocumentKey(token) ?? token?.id ?? "");
}

function isTokenShadowVisible(token) {
  return !token?.destroyed && token?.visible !== false && token?.renderable !== false
    && token?.mesh && !token.mesh.destroyed && token.mesh.visible !== false && token.mesh.renderable !== false;
}

function refreshTokenShadowVisibility(original) {
  const previews = TOKEN_SHADOW_PREVIEWS.get(original);
  let active = original;
  for (const preview of previews ?? []) {
    if (isTokenShadowVisible(preview)) active = preview;
  }
  // Foundry leaves the original visible (usually faded) during dragging. Only
  // one member of the original/preview family should cast a visible shadow.
  const enabled = getLevelConfig().enabled;
  for (const token of [original, ...(previews ?? [])]) {
    const shadow = ORIGINAL_TOKEN_STATE.get(token)?.flightShadow;
    if (shadow && !shadow.destroyed) shadow.visible = Boolean(enabled && token === active && isTokenShadowVisible(token));
  }
}

export function beginTokenShadowPreview(token) {
  ENDED_TOKEN_SHADOW_PREVIEWS.delete(token);
}

export function endTokenShadowPreview(token) {
  if (!token?._original) return;
  ENDED_TOKEN_SHADOW_PREVIEWS.add(token);
  destroyFlightShadow(token);
}

function collectFlightShadowCandidates(token, state = null) {
  // Keep ownership by token identity: a drag clone shares its document id with
  // the original, but must never adopt or destroy the original's shadow.
  const candidates = new Set();
  if (state?.flightShadow) candidates.add(state.flightShadow);
  const shadow = TOKEN_FLIGHT_SHADOWS.get(token);
  if (shadow) candidates.add(shadow);
  return candidates;
}

function destroyDisplayObject(object) {
  if (!object || object.destroyed) return;
  try { object.destroy({ children: true }); }
  catch (_err) {
    try { object.parent?.removeChild?.(object); }
    catch (_innerErr) { /* noop */ }
  }
}

function destroyFlightShadow(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  for (const candidate of collectFlightShadowCandidates(token, state)) destroyDisplayObject(candidate);
  TOKEN_FLIGHT_SHADOWS.delete(token);

  if (state) {
    state.flightShadow = null;
    state.flightShadowParent = null;
    state.flightShadowOrderParent = null;
    state.flightShadowOrderMesh = null;
  }
  const original = token?._original ?? token;
  const previews = TOKEN_SHADOW_PREVIEWS.get(original);
  previews?.delete(token);
  if (previews && !previews.size) TOKEN_SHADOW_PREVIEWS.delete(original);
  refreshTokenShadowVisibility(original);
}

function adoptFlightShadow(token, state, parent) {
  const key = getTokenShadowKey(token);
  const candidates = collectFlightShadowCandidates(token, state);
  let shadow = null;

  for (const candidate of candidates) {
    if (!candidate || candidate.destroyed || candidate._perspectiveLevelsTokenKey !== key || candidate._perspectiveLevelsToken !== token) continue;
    if (candidate === state?.flightShadow) {
      shadow = candidate;
      break;
    }
    if (!shadow || candidate.parent === parent) shadow = candidate;
  }

  for (const candidate of candidates) {
    if (candidate !== shadow) destroyDisplayObject(candidate);
  }

  if (shadow && state) state.flightShadow = shadow;
  return shadow;
}

function getFlightShadowParent(token) {
  for (const parent of [token?.mesh?.parent, globalThis.canvas?.primary, token?.parent, globalThis.canvas?.tokens?.objects, globalThis.canvas?.tokens]) {
    if (parent && !parent.destroyed && typeof parent.addChild === "function") return parent;
  }
  return null;
}

function placeFlightShadowBelowToken(token, state) {
  const shadow = state?.flightShadow;
  const parent = shadow?.parent;
  if (!shadow || !parent || shadow.destroyed) return;

  const baseSort = Number(token?.mesh?.sort ?? token?.mesh?.zIndex ?? token?.document?.sort ?? 0) || 0;
  const elevation = getTokenRenderElevation(token);
  const sortLayer = token?.mesh?.sortLayer ?? 0;
  const changed = shadow.elevation !== elevation || shadow.sortLayer !== sortLayer || shadow.sort !== baseSort - 1;
  shadow.elevation = elevation;
  shadow.sortLayer = sortLayer;
  shadow.sort = baseSort - 1;
  shadow.zIndex = baseSort - 1;

  if (changed) {
    try { parent.sortableChildren = true; parent.sortDirty = true; } catch (_err) { /* noop */ }
  }

  if ((state.flightShadowOrderParent !== parent || state.flightShadowOrderMesh !== token.mesh)
    && parent === token?.mesh?.parent && typeof parent.getChildIndex === "function" && typeof parent.addChildAt === "function") {
    try {
      const meshIndex = parent.getChildIndex(token.mesh);
      const shadowIndex = parent.getChildIndex(shadow);
      if (shadowIndex > meshIndex) {
        parent.removeChild(shadow);
        parent.addChildAt(shadow, Math.max(0, meshIndex));
      }
    } catch (_err) { /* sortableChildren usually handles this */ }
  }
  state.flightShadowOrderParent = parent;
  state.flightShadowOrderMesh = token.mesh;
}

function ensureFlightShadow(token, state) {
  const parent = getFlightShadowParent(token);
  if (!parent) return null;

  let shadow = adoptFlightShadow(token, state, parent);
  if (!shadow || shadow.destroyed) {
    const GraphicsClass = globalThis.foundry?.canvas?.primary?.PrimaryGraphics ?? PIXI.Graphics;
    shadow = new GraphicsClass();
    shadow.name = FLIGHT_SHADOW_NAME;
    shadow.eventMode = "none";
    shadow.interactive = false;
    shadow.interactiveChildren = false;
    shadow.cullable = false;
    shadow._perspectiveLevelsTokenKey = getTokenShadowKey(token);
    shadow._perspectiveLevelsToken = token;
    state.flightShadow = shadow;
    TOKEN_FLIGHT_SHADOWS.set(token, shadow);
  }

  if (shadow.parent !== parent) {
    try { shadow.parent?.removeChild?.(shadow); } catch (_err) { /* noop */ }
    try {
      if (parent === token?.mesh?.parent && token?.mesh && typeof parent.getChildIndex === "function" && typeof parent.addChildAt === "function") {
        parent.addChildAt(shadow, Math.max(0, parent.getChildIndex(token.mesh)));
      } else {
        parent.addChild(shadow);
      }
    } catch (_err) {
      parent.addChild(shadow);
    }
    state.flightShadowParent = parent;
  }

  placeFlightShadowBelowToken(token, state);
  return shadow;
}

function getPointInShadowParentSpace(parent, token, point) {
  if (parent === token) {
    const tokenX = Number(token?.position?.x ?? token?.x ?? token?.document?.x ?? 0) || 0;
    const tokenY = Number(token?.position?.y ?? token?.y ?? token?.document?.y ?? 0) || 0;
    return { x: point.x - tokenX, y: point.y - tokenY };
  }
  return { x: point.x, y: point.y };
}

function drawFilledEllipse(graphics, radiusX, radiusY, alpha) {
  if (!graphics) return;

  if (typeof graphics.beginFill === "function" && typeof graphics.drawEllipse === "function") {
    graphics.beginFill(FLIGHT_SHADOW_COLOR, alpha);
    graphics.drawEllipse(0, 0, radiusX, radiusY);
    graphics.endFill?.();
    return;
  }

  if (typeof graphics.ellipse === "function" && typeof graphics.fill === "function") {
    graphics.ellipse(0, 0, radiusX, radiusY);
    graphics.fill({ color: FLIGHT_SHADOW_COLOR, alpha });
  }
}

function drawFlightShadow(graphics, radiusX, radiusY, alpha) {
  graphics.clear?.();

  // Несколько вложенных эллипсов дают мягкую, но дешёвую тень без BlurFilter:
  // на больших сценах это безопаснее, чем отдельный filter на каждый токен.
  drawFilledEllipse(graphics, radiusX * 1.35, radiusY * 1.45, alpha * 0.16);
  drawFilledEllipse(graphics, radiusX * 1.08, radiusY * 1.12, alpha * 0.34);
  drawFilledEllipse(graphics, radiusX * 0.78, radiusY * 0.72, alpha * 0.52);
}

function updateFlightShadow(token, state, perspectiveScale, config, rect = getSceneRect(), model = null) {
  if (ENDED_TOKEN_SHADOW_PREVIEWS.has(token)) {
    destroyFlightShadow(token, state);
    return;
  }
  const elevation = getTokenElevation(token);

  const shadow = ensureFlightShadow(token, state);
  if (!shadow) return;

  const ground = getTokenGroundPoint(token, config, rect, model);
  const parentPoint = getPointInShadowParentSpace(shadow.parent, token, ground);

  const grid = screenPointToPerspectiveGrid({ x: ground.x, y: ground.y, elevation: 0 }, config, rect, model);
  const cellHeight = getPerspectiveCellScreenHeightAtRow(grid.j, config, rect, model);
  const gridDistance = Math.max(0.0001, getSceneGridDistance());
  const heightSpaces = Math.abs(elevation / gridDistance);

  const logicalWidth = getTokenLogicalSize(token, "x", rect);
  const logicalHeight = getTokenLogicalSize(token, "y", rect);
  const visualWidth = Math.max(4, logicalWidth * perspectiveScale);
  const visualHeight = Math.max(4, logicalHeight * perspectiveScale);
  const heightFade = clamp(1 - heightSpaces * 0.018, 0.58, 1);

  const radiusX = clamp(visualWidth * 0.34 * heightFade, 5, visualWidth * 0.72);
  const radiusY = clamp(Math.min(visualHeight * 0.11, cellHeight * 0.48) * heightFade, 2.5, radiusX * 0.34);
  const alpha = clamp(0.38 - heightSpaces * 0.018, 0.14, 0.38);

  shadow.alpha = clamp(token.mesh?.alpha ?? token.alpha ?? 1, 0, 1);
  shadow.rotation = 0;
  shadow.scale?.set?.(1, 1);
  shadow.position?.set?.(parentPoint.x, parentPoint.y);
  // Moving a token often changes only its position, not the shadow geometry.
  if (shadow._perspectiveLevelsRadiusX !== radiusX || shadow._perspectiveLevelsRadiusY !== radiusY
    || shadow._perspectiveLevelsFillAlpha !== alpha) {
    drawFlightShadow(shadow, radiusX, radiusY, alpha);
    shadow._perspectiveLevelsRadiusX = radiusX;
    shadow._perspectiveLevelsRadiusY = radiusY;
    shadow._perspectiveLevelsFillAlpha = alpha;
  }
  placeFlightShadowBelowToken(token, state);
  const original = token?._original ?? token;
  if (original !== token) {
    let previews = TOKEN_SHADOW_PREVIEWS.get(original);
    if (!previews) TOKEN_SHADOW_PREVIEWS.set(original, previews = new Set());
    previews.add(token);
  }
  refreshTokenShadowVisibility(original);
}
function cleanupTokenVisuals(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  destroyFlightShadow(token, state);
}

function getPerspectiveFrameSignature(token, config = getLevelConfig()) {
  const meshScale = Number(token?.mesh?._perspectiveLevelsAppliedScale);
  const scale = config?.enabled && config?.tokenScaling && Number.isFinite(meshScale) ? meshScale : 1;
  return [
    Boolean(config?.enabled),
    Boolean(config?.tokenScaling),
    Number(scale).toFixed(6),
    Number(config?.tokenArtVerticalAlign ?? 0.5).toFixed(4),
    Number(token?.position?.x ?? token?.x ?? token?.document?.x ?? 0).toFixed(2),
    Number(token?.position?.y ?? token?.y ?? token?.document?.y ?? 0).toFixed(2),
    Number(token?.w ?? token?.width ?? token?.document?.width ?? 0).toFixed(4),
    Number(token?.h ?? token?.height ?? token?.document?.height ?? 0).toFixed(4),
    Number(getTextureDimension(token?.mesh, "x") ?? 0).toFixed(2),
    Number(getTextureDimension(token?.mesh, "y") ?? 0).toFixed(2),
    Number(token?.mesh?.scale?.x ?? 0).toFixed(6),
    Number(token?.mesh?.scale?.y ?? 0).toFixed(6),
    Number(token?.mesh?.anchor?.x ?? 0.5).toFixed(6),
    Number(token?.mesh?.anchor?.y ?? 0.5).toFixed(6),
    Number(token?.mesh?.position?.x ?? 0).toFixed(2),
    Number(token?.mesh?.position?.y ?? 0).toFixed(2),
    token?.shape?.constructor?.name ?? ""
  ].join("|");
}

function refreshTokenPerspectiveFrame(token, config = getLevelConfig(), { force = false } = {}) {
  if (!isTokenObject(token) || token.destroyed) return;
  if (!globalThis.canvas?.ready) {
    delete token._perspectiveLevelsFrameSignature;
    return;
  }

  const signature = getPerspectiveFrameSignature(token, config);
  if (!force && token._perspectiveLevelsFrameSignature === signature) return;
  token._perspectiveLevelsFrameSignature = signature;

  try {
    if (typeof token._refreshShape === "function") token._refreshShape();
    else if (typeof token.getShape === "function") token.shape = token.getShape();
  } catch (_err) { /* noop */ }

  for (const method of ["_refreshBorder", "_refreshTarget", "_refreshRingVisuals", "_updateQuadtree"]) {
    try { token?.[method]?.(); } catch (_err) { /* noop */ }
  }
  if (config?.enabled && config?.tokenScaling) positionTokenPerspectiveFrameInfo(token);
  else resetTokenPerspectiveFrameInfo(token);
  try { refreshTokenRulerAlignment(token, config); } catch (_err) { /* noop */ }
}

export function removePerspectiveFromToken(token) {
  return withTokenVisualsSuspended(token, () => removeTokenPerspective(token));
}

function removeTokenPerspective(token) {
  clearTokenOutline(token);
  cancelBaseScaleRetry(token);
  const sortKey = getTokenSortCacheKey(token);
  if (sortKey) PERSPECTIVE_SORT_CACHE.delete(sortKey);
  PERSPECTIVE_SORT_DIRTY_TOKENS.delete(token);

  const state = ORIGINAL_TOKEN_STATE.get(token);
  if (!state) {
    cleanupTokenVisuals(token, null);
    restoreTokenRenderElevation(token);
    const documentKey = getTokenDocumentKey(token);
    if (documentKey) TOKEN_BASE_SCALE_BY_DOCUMENT.delete(documentKey);
    if (token?.mesh) {
      delete token.mesh._perspectiveLevelsAppliedScale;
      delete token.mesh._perspectiveLevelsAnchorOffsetY;
    }
    delete token._perspectiveLevelsFrameSignature;
    delete token._perspectiveLevelsFrameShape;
    delete token._perspectiveLevelsBaseFrameBounds;
    refreshTokenPerspectiveFrame(token, getLevelConfig(), { force: true });
    resetTokenPerspectiveFrameInfo(token);
    clearTokenOutline(token);
    return;
  }

  try {
    if (token.mesh && !token.mesh.destroyed) {
      const base = calculateDocumentBaseScale(token, token.mesh) ?? state;
      token.mesh.scale.set(base.baseScaleX, base.baseScaleY);
      restoreTokenBaseMeshAnchor(token, state);
      delete token.mesh._perspectiveLevelsAppliedScale;
    }
    restoreTokenRenderElevation(token);
    cleanupTokenVisuals(token, state);
    delete token._perspectiveLevelsFrameSignature;
    delete token._perspectiveLevelsFrameShape;
    delete token._perspectiveLevelsBaseFrameBounds;
    refreshTokenPerspectiveFrame(token, getLevelConfig(), { force: true });
    resetTokenPerspectiveFrameInfo(token);
  } finally {
    clearTokenOutline(token);
    ORIGINAL_TOKEN_STATE.delete(token);
    const documentKey = getTokenDocumentKey(token);
    if (documentKey) TOKEN_BASE_SCALE_BY_DOCUMENT.delete(documentKey);
  }
}

function getTokenState(token, mesh, rect = getSceneRect()) {
  const signature = getTokenSignature(token);
  const documentKey = getTokenDocumentKey(token);
  const documentBase = calculateDocumentBaseScale(token, mesh, rect);
  let state = ORIGINAL_TOKEN_STATE.get(token);

  // Если состояние существует и mesh не поменялся — вернуть его. Если раньше
  // пришлось взять fallback из текущего mesh.scale, но текстура уже прогрузилась,
  // заменить базу на вычисленную из документа токена.
  if (state && state.signature === signature && state.meshRef === mesh) {
    if (documentBase) {
      state.baseScaleX = documentBase.baseScaleX;
      state.baseScaleY = documentBase.baseScaleY;
      state.baseSource = documentBase.baseSource;
      if (documentKey) TOKEN_BASE_SCALE_BY_DOCUMENT.set(documentKey, {
        signature,
        baseScaleX: state.baseScaleX,
        baseScaleY: state.baseScaleY,
        baseSource: state.baseSource
      });
    }
    return state;
  }

  let base = documentBase;

  // Для старых уже отрисованных объектов в этой же canvas-сессии можно взять
  // сохранённую базу, но только если она совпадает с текущей сигнатурой токена.
  if (!base && documentKey && TOKEN_BASE_SCALE_BY_DOCUMENT.has(documentKey)) {
    const saved = TOKEN_BASE_SCALE_BY_DOCUMENT.get(documentKey);
    if (saved && saved.signature === signature) {
      base = {
        baseScaleX: saved.baseScaleX,
        baseScaleY: saved.baseScaleY,
        baseSource: saved.baseSource ?? "saved"
      };
    }
  }

  // Последний fallback: снять уже применённую перспективу с текущего mesh.scale.
  // Это не основной путь: после перезагрузки модуль теперь старается не считать
  // временный PIXI-scale Foundry базовым размером токена.
  if (!base) base = calculateFallbackBaseScale(mesh);

  cleanupTokenVisuals(token, state);
  const baseAnchorY = resolveTokenBaseMeshAnchorY(token, mesh, state);
  if (baseAnchorY !== null) setMeshAnchorY(mesh, baseAnchorY);

  state = {
    signature,
    meshRef: mesh,
    baseScaleX: base.baseScaleX,
    baseScaleY: base.baseScaleY,
    baseSource: base.baseSource,
    baseAnchorY,
    lastAnchorOffsetY: 0,
    lastPerspectiveScale: 1
  };

  ORIGINAL_TOKEN_STATE.set(token, state);
  if (documentKey) {
    TOKEN_BASE_SCALE_BY_DOCUMENT.set(documentKey, {
      signature,
      baseScaleX: state.baseScaleX,
      baseScaleY: state.baseScaleY,
      baseSource: state.baseSource
    });
  }

  return state;
}

export function restoreTokenBaseScale(token) {
  const state = ORIGINAL_TOKEN_STATE.get(token);
  const mesh = token?.mesh;
  if (!state || !mesh || mesh.destroyed || state.meshRef !== mesh) return false;

  mesh.scale.set(state.baseScaleX, state.baseScaleY);
  restoreTokenBaseMeshAnchor(token, state);
  delete mesh._perspectiveLevelsAppliedScale;
  state.lastPerspectiveScale = 1;
  refreshTokenPerspectiveFrame(token, getLevelConfig(), { force: true });
  return true;
}

function applyTokenVerticalAlignment(token, mesh, state, config, rect = getSceneRect()) {
  const baseAnchorY = updateTokenBaseMeshAnchorY(token, mesh, state);
  if (baseAnchorY === null) return;

  const align = clamp(config?.tokenArtVerticalAlign ?? 0.5, 0, 1);
  const logicalHeight = getTokenLogicalSize(token, "y", rect);
  const signedArtHeight = (getTextureDimension(mesh, "y") ?? 0) * (Number(mesh.scale?.y) || 0);
  const artHeight = Math.abs(signedArtHeight);
  if (!Number.isFinite(artHeight) || artHeight <= 0.0001) return;

  const tokenY = Number(token.position?.y ?? token.y ?? token.document?.y ?? 0) || 0;
  const meshY = Number(mesh.position?.y ?? tokenY + logicalHeight / 2) - tokenY;
  const artTop = (logicalHeight - artHeight) * (1 - align);
  // Align the actual art bounds, including tall textures, custom anchors and
  // vertical mirroring. Recompute absolutely so refreshes cannot accumulate drift.
  const anchorY = (meshY - artTop) / signedArtHeight + (signedArtHeight < 0 ? 1 : 0);
  if (setMeshAnchorY(mesh, anchorY)) {
    state.lastAnchorOffsetY = anchorY - baseAnchorY;
    mesh._perspectiveLevelsAnchorOffsetY = state.lastAnchorOffsetY;
  }
}

function getTokenVisualBottomPoint(token, rect = getSceneRect()) {
  const x = Number(token.position?.x ?? token.x ?? token.document?.x ?? 0) || 0;
  const y = Number(token.position?.y ?? token.y ?? token.document?.y ?? 0) || 0;
  const w = Number(token.w ?? ((token.document?.width || 1) * rect.gridSize) ?? rect.gridSize) || rect.gridSize;
  const h = Number(token.h ?? ((token.document?.height || 1) * rect.gridSize) ?? rect.gridSize) || rect.gridSize;
  return {
    x: x + (w / 2),
    y: y + h,
    elevation: getTokenElevation(token)
  };
}

export function getTokenGroundPoint(token, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  return screenPointToElevationGroundPoint(getTokenVisualBottomPoint(token, rect), config, rect, model);
}

export function getTokenGroundY(token) {
  return getTokenGroundPoint(token).y;
}

function getTokenElevation(token) {
  const elevation = Number(token?.document?.elevation ?? token?.elevation ?? 0);
  return Number.isFinite(elevation) ? elevation : 0;
}

function getTokenRenderElevation(token) {
  return Math.max(0, getTokenElevation(token));
}

function applyTokenRenderElevation(token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) return;

  const elevation = getTokenRenderElevation(token);
  for (const object of [mesh, mesh.primary, mesh.object, mesh.pixiObject]) {
    if (!object || object.destroyed) continue;
    try { object.elevation = elevation; } catch (_err) { /* noop */ }
  }
}

function restoreTokenRenderElevation(token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) return;

  const elevation = getTokenElevation(token);
  for (const object of [mesh, mesh.primary, mesh.object, mesh.pixiObject]) {
    if (!object || object.destroyed) continue;
    try { object.elevation = elevation; } catch (_err) { /* noop */ }
  }
}

function stableTokenTieBreaker(token) {
  const id = String(token?.document?.id ?? token?.id ?? "");
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash * 31) + id.charCodeAt(i)) >>> 0;
  // Маленькая добавка нужна только для стабильного порядка токенов на одной линии.
  return (hash % 1000) / 1000;
}

function getActiveLevelId() {
  const level = globalThis.canvas?.level;
  return level?.id ?? level?._id ?? null;
}

function tokenBelongsToActiveLevel(token) {
  const activeLevelId = getActiveLevelId();
  if (!activeLevelId) return true;

  const documentLevel = token?.document?.level;
  if (documentLevel === undefined || documentLevel === null || documentLevel === "") return true;

  if (typeof documentLevel === "object") {
    const candidates = [documentLevel.id, documentLevel._id, documentLevel.uuid, documentLevel.name];
    return candidates.some(candidate => candidate !== undefined && candidate !== null && String(candidate) === String(activeLevelId));
  }

  return String(documentLevel) === String(activeLevelId);
}

function getTokenSortProxy(token, previewIndex) {
  // Если есть drag-preview, у него позиция актуальнее, чем у исходного токена.
  for (const candidate of getIndexedTokenPreviews(token, previewIndex)) {
    if (candidate !== token && !candidate.destroyed) return candidate;
  }
  return token;
}

function getPerspectiveTokenDepthSortValue(token, config, rect, model, previewIndex) {
  const proxy = getTokenSortProxy(token, previewIndex);
  const coords = screenPointToPerspectiveGrid(getTokenVisualBottomPoint(proxy, rect), config, rect, model);

  const depthCells = Number.isFinite(Number(coords?.j)) ? Number(coords.j) : 0;

  // Sort only by the token's Y position on the rendered perspective grid.
  // Art bounds and elevation are intentionally ignored here so protruding art
  // does not reshuffle the layer order.
  const depthKey = Math.round(depthCells * 1000);
  return depthKey + stableTokenTieBreaker(token);
}

function getPerspectiveSortableTokens(config = getLevelConfig()) {
  if (!config?.enabled) return [];
  return (globalThis.canvas?.tokens?.placeables ?? [])
    .filter(token => isTokenObject(token) && !token.destroyed && token.document?.id && tokenBelongsToActiveLevel(token));
}

function buildPerspectiveSortEntriesFromCache() {
  const entries = [...PERSPECTIVE_SORT_CACHE.values()]
    .sort((a, b) => (a.depth - b.depth) || String(a.token.document.id).localeCompare(String(b.token.document.id)))
    .map((entry, index) => ({
      ...entry,
      sort: (index + 1) * PERSPECTIVE_SORT_STEP
    }));

  const signature = entries.map(entry => `${entry.token.document.id}:${entry.sort}`).join("|");
  return { entries, signature };
}

function rebuildPerspectiveSortCache(tokens, config, rect, model, previewIndex) {
  PERSPECTIVE_SORT_CACHE.clear();
  for (const token of tokens) {
    const key = getTokenSortCacheKey(token);
    if (!key) continue;
    PERSPECTIVE_SORT_CACHE.set(key, {
      token,
      depth: getPerspectiveTokenDepthSortValue(token, config, rect, model, previewIndex)
    });
  }
}

function isPerspectiveSortCacheCurrent(tokens) {
  if (PERSPECTIVE_SORT_CACHE.size !== tokens.length) return false;
  for (const token of tokens) {
    const key = getTokenSortCacheKey(token);
    if (!key || PERSPECTIVE_SORT_CACHE.get(key)?.token !== token) return false;
  }
  return true;
}

function buildPerspectiveSortSnapshot(config = getLevelConfig()) {
  const tokens = getPerspectiveSortableTokens(config);
  if (!tokens.length) {
    PERSPECTIVE_SORT_CACHE.clear();
    return { entries: [], signature: "" };
  }

  const rect = getSceneRect();
  const model = getPerspectiveGridModel(config, rect);
  rebuildPerspectiveSortCache(tokens, config, rect, model, buildTokenPreviewIndex(tokens, isTokenObject));
  return buildPerspectiveSortEntriesFromCache();
}

function buildIncrementalPerspectiveSortSnapshot(config, dirtyTokens) {
  const tokens = getPerspectiveSortableTokens(config);
  if (!tokens.length) {
    PERSPECTIVE_SORT_CACHE.clear();
    return { entries: [], signature: "" };
  }

  const rect = getSceneRect();
  const model = getPerspectiveGridModel(config, rect);
  const previewIndex = buildTokenPreviewIndex(tokens, isTokenObject);
  if (!isPerspectiveSortCacheCurrent(tokens)) {
    rebuildPerspectiveSortCache(tokens, config, rect, model, previewIndex);
    return buildPerspectiveSortEntriesFromCache();
  }

  const sortableByKey = new Map(tokens.map(token => [getTokenSortCacheKey(token), token]));
  for (const dirtyToken of dirtyTokens) {
    const key = getTokenSortCacheKey(dirtyToken);
    if (!key) continue;

    const token = sortableByKey.get(key);
    if (!token || token.destroyed || !tokenBelongsToActiveLevel(token)) {
      PERSPECTIVE_SORT_CACHE.delete(key);
      continue;
    }

    PERSPECTIVE_SORT_CACHE.set(key, {
      token,
      depth: getPerspectiveTokenDepthSortValue(token, config, rect, model, previewIndex)
    });
  }

  return buildPerspectiveSortEntriesFromCache();
}

function markFoundrySortDirty(token, dirtyContainers) {
  applyTokenRenderElevation(token);

  const objects = [
    token,
    token?.mesh,
    token?.layer?.objects,
    token?.layer,
    globalThis.canvas?.tokens?.objects,
    globalThis.canvas?.primary
  ];

  for (const object of objects) {
    if (!object || object.destroyed) continue;
    try { object.sortableChildren = true; } catch (_err) { /* noop */ }
    try { object.sortDirty = true; } catch (_err) { /* noop */ }
  }
  for (const container of [token?.layer?.objects, globalThis.canvas?.primary]) {
    if (container && !container.destroyed) dirtyContainers.add(container);
  }

  try { token?.renderFlags?.set?.({ refreshElevation: true }); } catch (_err) { /* noop */ }
  try { token?.applyRenderFlags?.(); } catch (_err) { /* noop */ }
  applyTokenRenderElevation(token);
}

function applyTokenDocumentSortLocally(token, sort, { markIfSame = true, dirtyContainers } = {}) {
  const document = token?.document;
  if (!document) return false;

  const current = Number(document.sort ?? 0);
  if (Number.isFinite(current) && current === sort) {
    if (markIfSame) markFoundrySortDirty(token, dirtyContainers);
    return false;
  }

  try { document.updateSource?.({ sort }, { _perspectiveLevelsSort: true }); }
  catch (_err) {
    try { document.sort = sort; }
    catch (_innerErr) { return false; }
  }

  // Не ставим token.zIndex: Foundry сортирует токены через TokenDocument.sort,
  // тот же механизм используется кнопкой HUD «расположить выше/ниже».
  try { if (token.mesh) token.mesh.sort = sort; } catch (_err) { /* noop */ }
  applyTokenRenderElevation(token);
  placeFlightShadowBelowToken(token, ORIGINAL_TOKEN_STATE.get(token));
  markFoundrySortDirty(token, dirtyContainers);
  return true;
}

function applyPerspectiveSortNow(config = getLevelConfig(), { persist = false, force = false, dirtyTokens = [] } = {}) {
  if (!config?.enabled) {
    PERSPECTIVE_SORT_CACHE.clear();
    LAST_LOCAL_SORT_SIGNATURE = "";
    return null;
  }
  const scopedDirtyTokens = [...dirtyTokens].filter(token => isTokenObject(token) && !token.destroyed);
  const fullRebuild = force || !scopedDirtyTokens.length;
  const snapshot = fullRebuild
    ? buildPerspectiveSortSnapshot(config)
    : buildIncrementalPerspectiveSortSnapshot(config, scopedDirtyTokens);
  if (!snapshot.entries.length) {
    LAST_LOCAL_SORT_SIGNATURE = "";
    return snapshot;
  }
  const dirtyContainers = new Set();

  if (snapshot.signature !== LAST_LOCAL_SORT_SIGNATURE) {
    for (const entry of snapshot.entries) applyTokenDocumentSortLocally(entry.token, entry.sort, { markIfSame: fullRebuild, dirtyContainers });
    LAST_LOCAL_SORT_SIGNATURE = snapshot.signature;
  } else {
    // A HUD/manual document update can change sort without changing the cached
    // depth order. Restore the actual values as well as marking containers dirty.
    for (const entry of snapshot.entries) {
      if (Number(entry.token.document.sort) !== entry.sort) applyTokenDocumentSortLocally(entry.token, entry.sort, { dirtyContainers });
    }
    const tokensToMark = fullRebuild ? snapshot.entries.map(entry => entry.token) : scopedDirtyTokens;
    for (const token of tokensToMark) markFoundrySortDirty(token, dirtyContainers);
  }
  // Sorting the same scene graph for every changed token made group dragging
  // increasingly expensive. Commit the display order once for the whole batch.
  for (const container of dirtyContainers) {
    try { container.sortChildren?.(); } catch (_err) { /* noop */ }
  }

  if (persist) persistPerspectiveSortSnapshot(snapshot);
  return snapshot;
}

async function persistPerspectiveSortSnapshot(snapshot) {
  if (!snapshot?.entries?.length) return;
  if (!canPersistSceneTokenSort()) return;
  if (snapshot.signature === LAST_PERSISTED_SORT_SIGNATURE) return;

  if (PERSPECTIVE_SORT_PERSISTING) {
    PERSPECTIVE_SORT_PERSIST_AGAIN = true;
    return;
  }

  const operation = { scene: globalThis.canvas?.scene };
  PERSPECTIVE_SORT_PERSISTING = operation;
  try {
    const scene = operation.scene;
    if (!scene?.updateEmbeddedDocuments) return;

    const updates = snapshot.entries.map(entry => ({ _id: entry.token.document.id, sort: entry.sort }));
    await scene.updateEmbeddedDocuments("Token", updates, {
      diff: false,
      animate: false,
      _perspectiveLevelsSort: true
    });
    if (PERSPECTIVE_SORT_PERSISTING === operation && scene === globalThis.canvas?.scene) {
      LAST_PERSISTED_SORT_SIGNATURE = snapshot.signature;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to persist perspective token sort`, err);
  } finally {
    // A teardown/new canvas starts an independent persistence generation.
    if (PERSPECTIVE_SORT_PERSISTING !== operation) return;
    PERSPECTIVE_SORT_PERSISTING = null;
    if (PERSPECTIVE_SORT_PERSIST_AGAIN) {
      PERSPECTIVE_SORT_PERSIST_AGAIN = false;
      schedulePerspectiveSort({ persist: true });
    }
  }
}

function flushPerspectiveSort() {
  PERSPECTIVE_SORT_RAF = null;
  const persist = PERSPECTIVE_SORT_PERSIST_REQUESTED;
  const force = PERSPECTIVE_SORT_FORCE_FULL;
  const dirtyTokens = [...PERSPECTIVE_SORT_DIRTY_TOKENS];
  PERSPECTIVE_SORT_PERSIST_REQUESTED = false;
  PERSPECTIVE_SORT_FORCE_FULL = false;
  PERSPECTIVE_SORT_DIRTY_TOKENS.clear();
  applyPerspectiveSortNow(getLevelConfig(), { persist, force, dirtyTokens });
}

function addPerspectiveSortToken(token) {
  if (!token || token.destroyed) return;
  PERSPECTIVE_SORT_DIRTY_TOKENS.add(token);
  const original = token?._original;
  if (original && original !== token && !original.destroyed) PERSPECTIVE_SORT_DIRTY_TOKENS.add(original);
}

export function schedulePerspectiveSort({ persist = false, debounce = false, token = null, tokens = null, force = false } = {}) {
  persist = Boolean(persist && canPersistSceneTokenSort());
  if (debounce && persist) {
    if (PERSPECTIVE_SORT_PERSIST_TIMEOUT) globalThis.clearTimeout(PERSPECTIVE_SORT_PERSIST_TIMEOUT);
    PERSPECTIVE_SORT_PERSIST_TIMEOUT = globalThis.setTimeout(() => {
      PERSPECTIVE_SORT_PERSIST_TIMEOUT = null;
      schedulePerspectiveSort({ persist: true });
    }, PERSPECTIVE_SORT_DEBOUNCE_MS);
    persist = false;
  }

  PERSPECTIVE_SORT_PERSIST_REQUESTED ||= persist;
  if (force || (!token && !tokens)) PERSPECTIVE_SORT_FORCE_FULL = true;
  if (token) addPerspectiveSortToken(token);
  if (tokens) {
    for (const entry of tokens) addPerspectiveSortToken(entry);
  }

  if (PERSPECTIVE_SORT_RAF) return;
  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  PERSPECTIVE_SORT_RAF = raf(flushPerspectiveSort);
}

export function clearPerspectiveSortState() {
  PERSPECTIVE_SORT_PERSISTING = null;
  LAST_LOCAL_SORT_SIGNATURE = "";
  LAST_PERSISTED_SORT_SIGNATURE = "";
  PERSPECTIVE_SORT_PERSIST_REQUESTED = false;
  PERSPECTIVE_SORT_PERSIST_AGAIN = false;
  PERSPECTIVE_SORT_FORCE_FULL = true;
  PERSPECTIVE_SORT_DIRTY_TOKENS.clear();
  PERSPECTIVE_SORT_CACHE.clear();
  if (PERSPECTIVE_SORT_RAF) {
    const caf = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
    try { caf(PERSPECTIVE_SORT_RAF); } catch (_err) { /* noop */ }
    PERSPECTIVE_SORT_RAF = null;
  }
  if (PERSPECTIVE_SORT_PERSIST_TIMEOUT) {
    globalThis.clearTimeout(PERSPECTIVE_SORT_PERSIST_TIMEOUT);
    PERSPECTIVE_SORT_PERSIST_TIMEOUT = null;
  }
}

export function applyPerspectiveToToken(token, { scheduleSort = true } = {}) {
  if (!isTokenObject(token) || token.destroyed) return;

  const config = getLevelConfig();
  if (!config.enabled) {
    removePerspectiveFromToken(token);
    return;
  }

  updateTokenOutline(token, config);

  const mesh = token.mesh;

  if (!mesh || mesh.destroyed) {
    destroyFlightShadow(token, ORIGINAL_TOKEN_STATE.get(token));
    refreshTokenPerspectiveFrame(token, config);
    if (scheduleSort) schedulePerspectiveSort({ token });
    return;
  }

  if (!config.tokenScaling) {
    const state = getTokenState(token, mesh);
    restoreTokenBaseScale(token);
    applyTokenRenderElevation(token);
    updateFlightShadow(token, state, 1, config);
    refreshTokenPerspectiveFrame(token, config);
    if (scheduleSort) schedulePerspectiveSort({ token });
    return;
  }

  const rect = getSceneRect();
  const state = getTokenState(token, mesh, rect);
  if (state.baseSource === "document") {
    TOKEN_BASE_RETRY_COUNT.delete(token);
    cancelBaseScaleRetry(token);
  }
  else scheduleBaseScaleRetry(token);

  const tokenScaleMultiplier = clamp(config.tokenScaleMultiplier ?? 1, 0.05, 8);
  const model = getPerspectiveGridModel(config, rect);
  const ground = getTokenGroundPoint(token, config, rect, model);
  const scale = scaleForPerspectiveToken(ground, config, rect, model) * tokenScaleMultiplier;

  const artMultiplier = getTokenArtMultiplier(token);
  mesh.scale.set(state.baseScaleX * scale * artMultiplier, state.baseScaleY * scale * artMultiplier);
  applyTokenRenderElevation(token);
  applyTokenVerticalAlignment(token, mesh, state, config, rect);
  mesh._perspectiveLevelsAppliedScale = scale * artMultiplier;
  state.lastPerspectiveScale = scale * artMultiplier;
  refreshTokenPerspectiveFrame(token, config);
  updateFlightShadow(token, state, scale, config, rect, model);

  if (scheduleSort) schedulePerspectiveSort({ token });
}

export function refreshTokens() {
  const tokens = [];
  forEachToken(token => {
    try {
      applyPerspectiveToToken(token, { scheduleSort: false });
      tokens.push(token);
    }
    catch (err) { console.warn(`${MODULE_ID} | Failed to update token perspective`, err); }
  });
  if (tokens.length) schedulePerspectiveSort({ tokens, force: true });
}

export function clearTokenScaleState() {
  for (const token of TOKEN_BASE_RETRIES.keys()) {
    cancelBaseScaleRetry(token);
    TOKEN_BASE_RETRY_COUNT.delete(token);
  }
  TOKEN_BASE_SCALE_BY_DOCUMENT.clear();
}
