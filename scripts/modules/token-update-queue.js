import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveToToken, isTokenObject, schedulePerspectiveSort } from "./tokens.js";

const PENDING_PERSPECTIVE_UPDATES = new Set();
let PENDING_PERSPECTIVE_RAF = null;

function addTokenLikeToSet(value, set, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (isTokenObject(value)) {
    set.add(value);
    return;
  }

  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) addTokenLikeToSet(entry, set, seen);
    return;
  }

  if (value instanceof Map) {
    for (const entry of value.values()) addTokenLikeToSet(entry, set, seen);
    return;
  }

  if (Array.isArray(value.children)) {
    for (const child of value.children) addTokenLikeToSet(child, set, seen);
  }

  if (Array.isArray(value.placeables)) {
    for (const placeable of value.placeables) addTokenLikeToSet(placeable, set, seen);
  }
}

export function collectTokenAndDragPreviews(token) {
  const set = new Set();
  const seen = new Set();
  addTokenLikeToSet(token, set, seen);

  for (const key of ["_preview", "preview", "_dragPreview", "_movementPreview", "_previewObject"]) {
    try { addTokenLikeToSet(token?.[key], set, seen); }
    catch (_err) { /* private access may throw in some builds */ }
  }

  const canvasRef = globalThis.canvas;
  const layer = token?.layer ?? canvasRef?.tokens;
  for (const source of [
    layer?.preview,
    layer?._preview,
    layer?.previews,
    layer?._previews,
    layer?.objects?.preview,
    canvasRef?.tokens?.preview,
    canvasRef?.tokens?._preview
  ]) {
    addTokenLikeToSet(source, set, seen);
  }

  return [...set];
}

function applyPerspectiveToTokenAndPreviews(token, touchedTokens) {
  applyPerspectiveToToken(token, { scheduleSort: false });
  touchedTokens.add(token);

  for (const preview of collectTokenAndDragPreviews(token)) {
    if (preview === token) continue;
    applyPerspectiveToToken(preview, { scheduleSort: false });
    touchedTokens.add(preview);
  }
}

function flushPerspectiveUpdates() {
  const tokens = [...PENDING_PERSPECTIVE_UPDATES];
  PENDING_PERSPECTIVE_UPDATES.clear();
  PENDING_PERSPECTIVE_RAF = null;

  const config = getLevelConfig();
  if (!isPerspectiveEnabled(config)) return;

  const touchedTokens = new Set();
  for (const token of tokens) {
    try {
      applyPerspectiveToTokenAndPreviews(token, touchedTokens);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to update perspective`, err);
    }
  }

  if (touchedTokens.size) schedulePerspectiveSort({ tokens: touchedTokens });
}

export function schedulePerspectiveUpdate(token) {
  if (!token) return;
  PENDING_PERSPECTIVE_UPDATES.add(token);
  if (PENDING_PERSPECTIVE_RAF) return;

  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  PENDING_PERSPECTIVE_RAF = raf(flushPerspectiveUpdates);
}

export function applyPerspectiveUpdateNow(token) {
  const config = getLevelConfig();
  if (!isPerspectiveEnabled(config)) return false;

  const touchedTokens = new Set();
  applyPerspectiveToTokenAndPreviews(token, touchedTokens);
  if (touchedTokens.size) schedulePerspectiveSort({ tokens: touchedTokens });
  return true;
}

export function applyOrSchedulePerspectiveUpdate(token) {
  try {
    if (!applyPerspectiveUpdateNow(token)) schedulePerspectiveUpdate(token);
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to update token perspective immediately`, err);
    schedulePerspectiveUpdate(token);
  }
}
