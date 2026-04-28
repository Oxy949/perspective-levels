import { LEGACY_TOKEN_OUTLINE_NAMES, MODULE_ID } from "./constants.js";
import { getLevelConfig } from "./config.js";
import { getSceneRect } from "./scene.js";
import { scaleForY } from "./projection.js";

const ORIGINAL_TOKEN_STATE = new WeakMap();
const TOKEN_BASE_SCALE_BY_DOCUMENT = new Map();

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

function removePerspectiveOutlineFilters(mesh) {
  if (!mesh || !Array.isArray(mesh.filters)) return;
  const kept = mesh.filters.filter(filter => !filter?._perspectiveLevelsOutline);
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
    return;
  }

  try {
    if (token.mesh && !token.mesh.destroyed) {
      token.mesh.scale.set(state.baseScaleX, state.baseScaleY);
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
  let state = ORIGINAL_TOKEN_STATE.get(token);
  if (state && state.signature === signature && state.meshRef === mesh) return state;

  const sameMesh = Boolean(state && state.meshRef === mesh);
  const previousScale = Number(state?.lastPerspectiveScale) || 1;
  const safePreviousScale = Math.abs(previousScale) > 0.0001 ? previousScale : 1;
  const documentKey = getTokenDocumentKey(token);
  const savedBase = documentKey ? TOKEN_BASE_SCALE_BY_DOCUMENT.get(documentKey) : null;
  const hasSavedBase = Boolean(savedBase && savedBase.signature === signature);

  const baseScaleX = hasSavedBase
    ? savedBase.baseScaleX
    : sameMesh ? mesh.scale.x / safePreviousScale : mesh.scale.x;
  const baseScaleY = hasSavedBase
    ? savedBase.baseScaleY
    : sameMesh ? mesh.scale.y / safePreviousScale : mesh.scale.y;

  cleanupTokenOutline(token, state);

  state = {
    signature,
    meshRef: mesh,
    baseScaleX,
    baseScaleY,
    lastPerspectiveScale: 1
  };

  ORIGINAL_TOKEN_STATE.set(token, state);
  if (documentKey) {
    TOKEN_BASE_SCALE_BY_DOCUMENT.set(documentKey, {
      signature,
      baseScaleX,
      baseScaleY
    });
  }

  return state;
}

export function restoreTokenBaseScale(token) {
  const state = ORIGINAL_TOKEN_STATE.get(token);
  const mesh = token?.mesh;
  if (!state || !mesh || mesh.destroyed || state.meshRef !== mesh) return false;

  mesh.scale.set(state.baseScaleX, state.baseScaleY);
  state.lastPerspectiveScale = 1;
  return true;
}

export function getTokenGroundY(token) {
  const rect = getSceneRect();
  const y = Number(token.position?.y ?? token.y ?? token.document?.y ?? 0) || 0;
  const h = Number(token.h ?? ((token.document?.height || 1) * rect.gridSize) ?? rect.gridSize) || rect.gridSize;
  return y + h;
}

export function applyPerspectiveToToken(token) {
  if (!isTokenObject(token) || token.destroyed) return;

  const config = getLevelConfig();
  if (!config.enabled || !config.tokenScaling) {
    removePerspectiveFromToken(token);
    return;
  }

  const mesh = token.mesh;
  if (!mesh || mesh.destroyed) return;

  const state = getTokenState(token, mesh);
  const scale = scaleForY(getTokenGroundY(token), config);
  mesh.scale.set(state.baseScaleX * scale, state.baseScaleY * scale);
  state.lastPerspectiveScale = scale;

  cleanupTokenOutline(token, state);
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
