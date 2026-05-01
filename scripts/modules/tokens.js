import { MODULE_ID } from "./constants.js";
import { getLevelConfig } from "./config.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { getPerspectiveCellScreenHeightAtRow, scaleForPerspectiveToken, screenPointToElevationGroundPoint, screenPointToPerspectiveGrid } from "./projection.js";
import { clamp } from "./utils.js";

const ORIGINAL_TOKEN_STATE = new WeakMap();
const TOKEN_BASE_SCALE_BY_DOCUMENT = new Map();
const TOKEN_BASE_RETRY_COUNT = new WeakMap();
const PERSPECTIVE_SORT_STEP = 100000;
const PERSPECTIVE_SORT_DEBOUNCE_MS = 90;
const FLIGHT_SHADOW_NAME = "PerspectiveLevels.FlightShadow";
const FLIGHT_SHADOW_COLOR = 0x000000;

let PERSPECTIVE_SORT_RAF = null;
let PERSPECTIVE_SORT_PERSIST_TIMEOUT = null;
let PERSPECTIVE_SORT_PERSIST_REQUESTED = false;
let PERSPECTIVE_SORT_PERSISTING = false;
let PERSPECTIVE_SORT_PERSIST_AGAIN = false;
let LAST_LOCAL_SORT_SIGNATURE = "";
let LAST_PERSISTED_SORT_SIGNATURE = "";

export function isTokenObject(object) {
  return object?.document?.documentName === "Token" || object?.constructor?.name === "Token";
}

export function getTokenDocumentKey(token) {
  return token?.document?.uuid
    ?? token?.document?.id
    ?? token?.id
    ?? null;
}

export function forEachToken(callback) {
  const placeables = globalThis.canvas?.tokens?.placeables ?? [];
  for (const token of placeables) callback(token);
}

function getTokenSignature(token) {
  const texture = token.document?.texture ?? {};
  return [
    texture.src ?? "",
    token.document?.width ?? "",
    token.document?.height ?? "",
    texture.scaleX ?? "",
    texture.scaleY ?? "",
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
  return Number.isFinite(n) && Math.abs(n) > 0.000001 ? n : 1;
}

function getTokenLogicalSize(token, axis) {
  const rect = getSceneRect();
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

function resolveTokenBaseMeshAnchorY(mesh, state = null) {
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

function updateTokenBaseMeshAnchorY(mesh, state) {
  const baseAnchorY = resolveTokenBaseMeshAnchorY(mesh, state);
  state.baseAnchorY = baseAnchorY;
  return baseAnchorY;
}

function restoreTokenBaseMeshAnchor(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  const mesh = token?.mesh;
  if (!state || !mesh || mesh.destroyed || state.meshRef !== mesh) return false;

  const baseAnchorY = updateTokenBaseMeshAnchorY(mesh, state);
  if (baseAnchorY === null) return false;

  const restored = setMeshAnchorY(mesh, baseAnchorY);
  if (restored) {
    state.lastAnchorOffsetY = 0;
    delete mesh._perspectiveLevelsAnchorOffsetY;
  }
  return restored;
}

function calculateDocumentBaseScale(token, mesh) {
  const textureWidth = getTextureDimension(mesh, "x");
  const textureHeight = getTextureDimension(mesh, "y");
  const logicalWidth = getTokenLogicalSize(token, "x");
  const logicalHeight = getTokenLogicalSize(token, "y");

  if (!textureWidth || !textureHeight || !logicalWidth || !logicalHeight) return null;

  // Нельзя растягивать изображение отдельно по X/Y до размеров токен-документа:
  // неквадратные арты после этого плющит в квадрат. Берём единый fit-scale,
  // как object-fit: contain, а texture.scaleX/Y оставляем пользовательской
  // настройкой Foundry.
  const fitScale = Math.min(logicalWidth / textureWidth, logicalHeight / textureHeight);

  return {
    baseScaleX: fitScale * getDocumentTextureScale(token, "x"),
    baseScaleY: fitScale * getDocumentTextureScale(token, "y"),
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
  const count = TOKEN_BASE_RETRY_COUNT.get(token) ?? 0;
  if (count >= 5) return;
  TOKEN_BASE_RETRY_COUNT.set(token, count + 1);

  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  raf(() => {
    try {
      if (!token?.destroyed) applyPerspectiveToToken(token);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to retry token perspective base scale`, err);
    }
  });
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

function isFlightShadowForToken(child, token) {
  return child?.name === FLIGHT_SHADOW_NAME && child?._perspectiveLevelsTokenKey === getTokenShadowKey(token);
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
  const candidates = new Set();
  if (state?.flightShadow) candidates.add(state.flightShadow);

  for (const parent of [token, token?.parent, token?.mesh?.parent, globalThis.canvas?.primary, globalThis.canvas?.tokens?.objects, globalThis.canvas?.tokens]) {
    const children = parent?.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (isFlightShadowForToken(child, token)) candidates.add(child);
    }
  }

  for (const candidate of candidates) destroyDisplayObject(candidate);

  if (state) {
    state.flightShadow = null;
    state.flightShadowParent = null;
  }
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
  shadow.sort = baseSort - 1;
  shadow.zIndex = baseSort - 1;

  try { parent.sortableChildren = true; } catch (_err) { /* noop */ }
  try { parent.sortDirty = true; } catch (_err) { /* noop */ }

  if (parent === token?.mesh?.parent && typeof parent.getChildIndex === "function" && typeof parent.addChildAt === "function") {
    try {
      const meshIndex = parent.getChildIndex(token.mesh);
      const shadowIndex = parent.getChildIndex(shadow);
      if (shadowIndex > meshIndex) {
        parent.removeChild(shadow);
        parent.addChildAt(shadow, Math.max(0, meshIndex));
      }
    } catch (_err) { /* sortableChildren usually handles this */ }
  }
}

function ensureFlightShadow(token, state) {
  const parent = getFlightShadowParent(token);
  if (!parent) return null;

  let shadow = state.flightShadow;
  if (!shadow || shadow.destroyed) {
    shadow = new PIXI.Graphics();
    shadow.name = FLIGHT_SHADOW_NAME;
    shadow.eventMode = "none";
    shadow.interactive = false;
    shadow.interactiveChildren = false;
    shadow.cullable = false;
    shadow._perspectiveLevelsTokenKey = getTokenShadowKey(token);
    state.flightShadow = shadow;
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
  // на больших сценах это безопаснее, чем отдельный filter на каждый летающий токен.
  drawFilledEllipse(graphics, radiusX * 1.35, radiusY * 1.45, alpha * 0.16);
  drawFilledEllipse(graphics, radiusX * 1.08, radiusY * 1.12, alpha * 0.34);
  drawFilledEllipse(graphics, radiusX * 0.78, radiusY * 0.72, alpha * 0.52);
}

function updateFlightShadow(token, state, perspectiveScale, config) {
  const elevation = getTokenElevation(token);
  if (!(elevation > 0.001)) {
    destroyFlightShadow(token, state);
    return;
  }

  const shadow = ensureFlightShadow(token, state);
  if (!shadow) return;

  const rect = getSceneRect();
  const ground = getTokenGroundPoint(token);
  const parentPoint = getPointInShadowParentSpace(shadow.parent, token, ground);

  const grid = screenPointToPerspectiveGrid({ x: ground.x, y: ground.y, elevation: 0 }, config, rect);
  const cellHeight = getPerspectiveCellScreenHeightAtRow(grid.j, config, rect);
  const gridDistance = Math.max(0.0001, getSceneGridDistance());
  const heightSpaces = Math.abs(elevation / gridDistance);

  const logicalWidth = getTokenLogicalSize(token, "x");
  const logicalHeight = getTokenLogicalSize(token, "y");
  const visualWidth = Math.max(4, logicalWidth * perspectiveScale);
  const visualHeight = Math.max(4, logicalHeight * perspectiveScale);
  const heightFade = clamp(1 - heightSpaces * 0.018, 0.58, 1);

  const radiusX = clamp(visualWidth * 0.34 * heightFade, 5, visualWidth * 0.72);
  const radiusY = clamp(Math.min(visualHeight * 0.11, cellHeight * 0.48) * heightFade, 2.5, radiusX * 0.34);
  const alpha = clamp(0.38 - heightSpaces * 0.018, 0.14, 0.38);

  shadow.visible = true;
  shadow.alpha = 1;
  shadow.rotation = 0;
  shadow.scale?.set?.(1, 1);
  shadow.position?.set?.(parentPoint.x, parentPoint.y);
  drawFlightShadow(shadow, radiusX, radiusY, alpha);
  placeFlightShadowBelowToken(token, state);
}
function cleanupTokenVisuals(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  destroyFlightShadow(token, state);
}

export function removePerspectiveFromToken(token) {
  const state = ORIGINAL_TOKEN_STATE.get(token);
  if (!state) {
    cleanupTokenVisuals(token, null);
    const documentKey = getTokenDocumentKey(token);
    if (documentKey) TOKEN_BASE_SCALE_BY_DOCUMENT.delete(documentKey);
    if (token?.mesh) {
      delete token.mesh._perspectiveLevelsAppliedScale;
      delete token.mesh._perspectiveLevelsAnchorOffsetY;
    }
    return;
  }

  try {
    if (token.mesh && !token.mesh.destroyed) {
      token.mesh.scale.set(state.baseScaleX, state.baseScaleY);
      restoreTokenBaseMeshAnchor(token, state);
      delete token.mesh._perspectiveLevelsAppliedScale;
    }
    cleanupTokenVisuals(token, state);
  } finally {
    ORIGINAL_TOKEN_STATE.delete(token);
    const documentKey = getTokenDocumentKey(token);
    if (documentKey) TOKEN_BASE_SCALE_BY_DOCUMENT.delete(documentKey);
  }
}

function getTokenState(token, mesh) {
  const signature = getTokenSignature(token);
  const documentKey = getTokenDocumentKey(token);
  const documentBase = calculateDocumentBaseScale(token, mesh);
  let state = ORIGINAL_TOKEN_STATE.get(token);

  // Если состояние существует и mesh не поменялся — вернуть его. Если раньше
  // пришлось взять fallback из текущего mesh.scale, но текстура уже прогрузилась,
  // заменить базу на вычисленную из документа токена.
  if (state && state.signature === signature && state.meshRef === mesh) {
    if (documentBase && state.baseSource !== "document") {
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
  const baseAnchorY = resolveTokenBaseMeshAnchorY(mesh, state);

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
  return true;
}

function calculateTokenVerticalAlignOffsetY(token, mesh, state, perspectiveScale, config) {
  const align = clamp(config?.tokenArtVerticalAlign ?? 0.5, 0, 1);
  const logicalHeight = getTokenLogicalSize(token, "y");
  const textureHeight = getTextureDimension(mesh, "y");
  const artHeight = Math.abs((Number(textureHeight) || 0) * (Number(state?.baseScaleY) || 0) * (Number(perspectiveScale) || 1));

  if (!Number.isFinite(logicalHeight) || logicalHeight <= 0 || !Number.isFinite(artHeight) || artHeight <= 0) return 0;
  return (0.5 - align) * (logicalHeight - artHeight);
}

function applyTokenVerticalAlignment(token, mesh, state, perspectiveScale, config) {
  const baseAnchorY = updateTokenBaseMeshAnchorY(mesh, state);
  if (baseAnchorY === null) return;

  const offsetY = calculateTokenVerticalAlignOffsetY(token, mesh, state, perspectiveScale, config);
  const textureHeight = getTextureDimension(mesh, "y");
  const artHeight = Math.abs((Number(textureHeight) || 0) * (Number(state?.baseScaleY) || 0) * (Number(perspectiveScale) || 1));
  if (!Number.isFinite(artHeight) || artHeight <= 0.0001) return;

  const anchorOffsetY = -offsetY / artHeight;
  if (setMeshAnchorY(mesh, baseAnchorY + anchorOffsetY)) {
    state.lastAnchorOffsetY = anchorOffsetY;
    mesh._perspectiveLevelsAnchorOffsetY = anchorOffsetY;
  }
}

function getTokenVisualBottomPoint(token) {
  const rect = getSceneRect();
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

export function getTokenGroundPoint(token) {
  const config = getLevelConfig();
  return screenPointToElevationGroundPoint(getTokenVisualBottomPoint(token), config, getSceneRect());
}

export function getTokenGroundY(token) {
  return getTokenGroundPoint(token).y;
}

function getTokenElevation(token) {
  const elevation = Number(token?.document?.elevation ?? token?.elevation ?? 0);
  return Number.isFinite(elevation) ? elevation : 0;
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

function addTokenSortCandidate(value, token, set, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (isTokenObject(value)) {
    const sameOriginal = value === token || value?._original === token;
    const sameDocument = value?.document?.id && value.document.id === token?.document?.id;
    const sameSource = value?.sourceId && token?.sourceId && value.sourceId === token.sourceId;
    if (sameOriginal || sameDocument || sameSource) set.add(value);
    return;
  }

  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) addTokenSortCandidate(entry, token, set, seen);
    return;
  }

  if (value instanceof Map) {
    for (const entry of value.values()) addTokenSortCandidate(entry, token, set, seen);
    return;
  }

  for (const key of ["children", "placeables", "objects"]) {
    const children = value?.[key];
    if (Array.isArray(children)) {
      for (const child of children) addTokenSortCandidate(child, token, set, seen);
    }
  }
}

function getTokenSortProxy(token) {
  const candidates = new Set([token]);
  const layer = token?.layer ?? globalThis.canvas?.tokens;

  for (const key of ["_preview", "preview", "_dragPreview", "_movementPreview", "_previewObject"]) {
    try { addTokenSortCandidate(token?.[key], token, candidates); }
    catch (_err) { /* private access may throw in some builds */ }
  }

  for (const source of [
    layer?.preview,
    layer?._preview,
    layer?.previews,
    layer?._previews,
    layer?.objects?.preview,
    globalThis.canvas?.tokens?.preview,
    globalThis.canvas?.tokens?._preview
  ]) {
    addTokenSortCandidate(source, token, candidates);
  }

  // Если есть drag-preview, у него позиция актуальнее, чем у исходного токена.
  for (const candidate of candidates) {
    if (candidate !== token && !candidate.destroyed) return candidate;
  }
  return token;
}

function getPerspectiveTokenDepthSortValue(token, config) {
  const proxy = getTokenSortProxy(token);
  const coords = screenPointToPerspectiveGrid(getTokenVisualBottomPoint(proxy), config, getSceneRect());

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

function buildPerspectiveSortSnapshot(config = getLevelConfig()) {
  const tokens = getPerspectiveSortableTokens(config);
  if (!tokens.length) return { entries: [], signature: "" };

  const entries = tokens
    .map(token => ({ token, depth: getPerspectiveTokenDepthSortValue(token, config) }))
    .sort((a, b) => (a.depth - b.depth) || String(a.token.document.id).localeCompare(String(b.token.document.id)))
    .map((entry, index) => ({
      ...entry,
      sort: (index + 1) * PERSPECTIVE_SORT_STEP
    }));

  const signature = entries.map(entry => `${entry.token.document.id}:${entry.sort}`).join("|");
  return { entries, signature };
}

function markFoundrySortDirty(token) {
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

  try { token?.renderFlags?.set?.({ refreshElevation: true }); } catch (_err) { /* noop */ }
  try { token?.applyRenderFlags?.(); } catch (_err) { /* noop */ }
  try { token?.layer?.objects?.sortChildren?.(); } catch (_err) { /* noop */ }
  try { globalThis.canvas?.primary?.sortChildren?.(); } catch (_err) { /* noop */ }
}

function applyTokenDocumentSortLocally(token, sort) {
  const document = token?.document;
  if (!document) return false;

  const current = Number(document.sort ?? 0);
  if (Number.isFinite(current) && current === sort) {
    markFoundrySortDirty(token);
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
  placeFlightShadowBelowToken(token, ORIGINAL_TOKEN_STATE.get(token));
  markFoundrySortDirty(token);
  return true;
}

function applyPerspectiveSortNow(config = getLevelConfig(), { persist = false } = {}) {
  if (!config?.enabled) return null;
  const snapshot = buildPerspectiveSortSnapshot(config);
  if (!snapshot.entries.length) return snapshot;

  if (snapshot.signature !== LAST_LOCAL_SORT_SIGNATURE) {
    for (const entry of snapshot.entries) applyTokenDocumentSortLocally(entry.token, entry.sort);
    LAST_LOCAL_SORT_SIGNATURE = snapshot.signature;
  } else {
    for (const entry of snapshot.entries) markFoundrySortDirty(entry.token);
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

  PERSPECTIVE_SORT_PERSISTING = true;
  try {
    const scene = globalThis.canvas?.scene;
    if (!scene?.updateEmbeddedDocuments) return;

    const updates = snapshot.entries.map(entry => ({ _id: entry.token.document.id, sort: entry.sort }));
    await scene.updateEmbeddedDocuments("Token", updates, {
      diff: false,
      animate: false,
      _perspectiveLevelsSort: true
    });
    LAST_PERSISTED_SORT_SIGNATURE = snapshot.signature;
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to persist perspective token sort`, err);
  } finally {
    PERSPECTIVE_SORT_PERSISTING = false;
    if (PERSPECTIVE_SORT_PERSIST_AGAIN) {
      PERSPECTIVE_SORT_PERSIST_AGAIN = false;
      schedulePerspectiveSort({ persist: true });
    }
  }
}

function flushPerspectiveSort() {
  PERSPECTIVE_SORT_RAF = null;
  const persist = PERSPECTIVE_SORT_PERSIST_REQUESTED;
  PERSPECTIVE_SORT_PERSIST_REQUESTED = false;
  applyPerspectiveSortNow(getLevelConfig(), { persist });
}

export function schedulePerspectiveSort({ persist = false, debounce = false } = {}) {
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

  if (PERSPECTIVE_SORT_RAF) return;
  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  PERSPECTIVE_SORT_RAF = raf(flushPerspectiveSort);
}

export function clearPerspectiveSortState() {
  LAST_LOCAL_SORT_SIGNATURE = "";
  LAST_PERSISTED_SORT_SIGNATURE = "";
  PERSPECTIVE_SORT_PERSIST_REQUESTED = false;
  PERSPECTIVE_SORT_PERSIST_AGAIN = false;
  if (PERSPECTIVE_SORT_PERSIST_TIMEOUT) {
    globalThis.clearTimeout(PERSPECTIVE_SORT_PERSIST_TIMEOUT);
    PERSPECTIVE_SORT_PERSIST_TIMEOUT = null;
  }
}

export function applyPerspectiveToToken(token) {
  if (!isTokenObject(token) || token.destroyed) return;

  const config = getLevelConfig();
  if (!config.enabled) {
    removePerspectiveFromToken(token);
    return;
  }

  const mesh = token.mesh;

  if (!config.tokenScaling) {
    restoreTokenBaseScale(token);
    destroyFlightShadow(token, ORIGINAL_TOKEN_STATE.get(token));
    schedulePerspectiveSort();
    return;
  }

  if (!mesh || mesh.destroyed) {
    destroyFlightShadow(token, ORIGINAL_TOKEN_STATE.get(token));
    schedulePerspectiveSort();
    return;
  }

  const state = getTokenState(token, mesh);
  if (state.baseSource === "document") TOKEN_BASE_RETRY_COUNT.delete(token);
  else scheduleBaseScaleRetry(token);

  const tokenScaleMultiplier = clamp(config.tokenScaleMultiplier ?? 1, 0.05, 8);
  const scale = scaleForPerspectiveToken(getTokenGroundPoint(token), config) * tokenScaleMultiplier;

  mesh.scale.set(state.baseScaleX * scale, state.baseScaleY * scale);
  applyTokenVerticalAlignment(token, mesh, state, scale, config);
  mesh._perspectiveLevelsAppliedScale = scale;
  state.lastPerspectiveScale = scale;
  updateFlightShadow(token, state, scale, config);

  schedulePerspectiveSort();
}

export function refreshTokens() {
  forEachToken(token => {
    try { applyPerspectiveToToken(token); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to update token perspective`, err); }
  });
}

export function clearTokenScaleState() {
  TOKEN_BASE_SCALE_BY_DOCUMENT.clear();
}
