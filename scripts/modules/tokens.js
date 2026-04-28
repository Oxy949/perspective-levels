import { LEGACY_TOKEN_OUTLINE_NAMES, MODULE_ID } from "./constants.js";
import { getLevelConfig } from "./config.js";
import { getSceneRect } from "./scene.js";
import { scaleForY, screenPointToPerspectiveGrid } from "./projection.js";
import { clamp } from "./utils.js";

const ORIGINAL_TOKEN_STATE = new WeakMap();
const TOKEN_BASE_SCALE_BY_DOCUMENT = new Map();
const TOKEN_BASE_RETRY_COUNT = new WeakMap();
const PERSPECTIVE_SORT_STEP = 100000;
const PERSPECTIVE_SORT_DEBOUNCE_MS = 90;

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

function cleanupLegacyRectangleOutline(token) {
  const names = new Set(LEGACY_TOKEN_OUTLINE_NAMES);

  for (const child of [...(token.children ?? [])]) {
    if (names.has(child?.name) && !child.destroyed) child.destroy({ children: true });
  }

  const meshParent = token.mesh?.parent;
  if (meshParent && meshParent !== token) {
    for (const child of [...(meshParent.children ?? [])]) {
      if (names.has(child?.name) && !child.destroyed) child.destroy({ children: true });
    }
  }
}

function getCurrentUser() {
  return globalThis.game?.user ?? null;
}

function canPersistSceneTokenSort() {
  return getCurrentUser()?.isGM === true;
}

function removePerspectiveOutlineFilters(mesh) {
  if (!mesh || !Array.isArray(mesh.filters)) return;
  const kept = mesh.filters.filter(filter => !filter?._perspectiveLevelsOutline && !filter?._perspectiveLevelsMteOutline);
  mesh.filters = kept.length ? kept : null;
}

function cleanupTokenOutline(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  removePerspectiveOutlineFilters(token.mesh);

  if (state?.outlineContainer && !state.outlineContainer.destroyed) {
    state.outlineContainer.destroy({ children: true });
  }

  if (state) {
    state.outlineContainer = null;
    state.outlineSprites = [];
    state.outlineParent = null;
  }

  cleanupLegacyRectangleOutline(token);
}

export function removePerspectiveFromToken(token) {
  const state = ORIGINAL_TOKEN_STATE.get(token);
  if (!state) {
    cleanupTokenOutline(token, null);
    const documentKey = getTokenDocumentKey(token);
    if (documentKey) TOKEN_BASE_SCALE_BY_DOCUMENT.delete(documentKey);
    if (token?.mesh) delete token.mesh._perspectiveLevelsAppliedScale;
    return;
  }

  try {
    if (token.mesh && !token.mesh.destroyed) {
      token.mesh.scale.set(state.baseScaleX, state.baseScaleY);
      delete token.mesh._perspectiveLevelsAppliedScale;
      removePerspectiveOutlineFilters(token.mesh);
    }
    cleanupTokenOutline(token, state);
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

  cleanupTokenOutline(token, state);

  state = {
    signature,
    meshRef: mesh,
    baseScaleX: base.baseScaleX,
    baseScaleY: base.baseScaleY,
    baseSource: base.baseSource,
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
  delete mesh._perspectiveLevelsAppliedScale;
  state.lastPerspectiveScale = 1;
  return true;
}

export function getTokenGroundY(token) {
  const rect = getSceneRect();
  const y = Number(token.position?.y ?? token.y ?? token.document?.y ?? 0) || 0;
  const h = Number(token.h ?? ((token.document?.height || 1) * rect.gridSize) ?? rect.gridSize) || rect.gridSize;
  return y + h;
}

export function getTokenGroundPoint(token) {
  const rect = getSceneRect();
  const x = Number(token.position?.x ?? token.x ?? token.document?.x ?? 0) || 0;
  const w = Number(token.w ?? ((token.document?.width || 1) * rect.gridSize) ?? rect.gridSize) || rect.gridSize;
  return {
    x: x + (w / 2),
    y: getTokenGroundY(token),
    elevation: getTokenElevation(token)
  };
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
  const point = getTokenGroundPoint(proxy);
  const coords = screenPointToPerspectiveGrid(point, config, getSceneRect());

  const depthCells = Number.isFinite(Number(coords?.j)) ? Number(coords.j) : 0;
  const elevation = getTokenElevation(proxy);

  // Чем больше j, тем ближе токен к зрителю. sceneDepthCells напрямую входит
  // в j, поэтому изменение глубины сцены меняет и шкалу сортировки.
  const depthKey = Math.round(depthCells * 1000);
  const elevationKey = Math.round(elevation * 1000000);
  return elevationKey + depthKey + stableTokenTieBreaker(token);
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
    schedulePerspectiveSort();
    return;
  }

  if (!mesh || mesh.destroyed) {
    schedulePerspectiveSort();
    return;
  }

  const state = getTokenState(token, mesh);
  if (state.baseSource === "document") TOKEN_BASE_RETRY_COUNT.delete(token);
  else scheduleBaseScaleRetry(token);

  const tokenScaleMultiplier = clamp(config.tokenScaleMultiplier ?? 1, 0.05, 8);
  const scale = scaleForY(getTokenGroundY(token), config) * tokenScaleMultiplier;

  mesh.scale.set(state.baseScaleX * scale, state.baseScaleY * scale);
  mesh._perspectiveLevelsAppliedScale = scale;
  state.lastPerspectiveScale = scale;

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
