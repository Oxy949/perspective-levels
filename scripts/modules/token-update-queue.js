import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveToToken, isTokenObject, schedulePerspectiveSort } from "./tokens.js";

const PENDING_PERSPECTIVE_UPDATES = new Set();
const PENDING_PERSPECTIVE_TOKEN_ONLY_UPDATES = new Set();
const PENDING_PERSPECTIVE_UPDATE_BURSTS = new Map();
const PERSPECTIVE_UPDATE_BURST_DELAYS_MS = [0, 50, 125, 250, 500];
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
  const tokenOnly = [...PENDING_PERSPECTIVE_TOKEN_ONLY_UPDATES].filter(token => !PENDING_PERSPECTIVE_UPDATES.has(token));
  PENDING_PERSPECTIVE_UPDATES.clear();
  PENDING_PERSPECTIVE_TOKEN_ONLY_UPDATES.clear();
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

  for (const token of tokenOnly) {
    try {
      applyPerspectiveToToken(token, { scheduleSort: false });
      touchedTokens.add(token);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to update token perspective`, err);
    }
  }

  if (touchedTokens.size) schedulePerspectiveSort({ tokens: touchedTokens });
}

export function schedulePerspectiveUpdate(token, { includePreviews = true } = {}) {
  if (!token) return;
  if (includePreviews) PENDING_PERSPECTIVE_UPDATES.add(token);
  else PENDING_PERSPECTIVE_TOKEN_ONLY_UPDATES.add(token);
  if (PENDING_PERSPECTIVE_RAF) return;

  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  PENDING_PERSPECTIVE_RAF = raf(flushPerspectiveUpdates);
}

function clearPerspectiveUpdateBurst(token) {
  const timers = PENDING_PERSPECTIVE_UPDATE_BURSTS.get(token);
  if (!timers) return;

  for (const timer of timers) {
    try { globalThis.clearTimeout(timer); } catch (_err) { /* noop */ }
  }

  PENDING_PERSPECTIVE_UPDATE_BURSTS.delete(token);
}

export function schedulePerspectiveTokenUpdateBurst(token, delays = PERSPECTIVE_UPDATE_BURST_DELAYS_MS) {
  if (!token) return;
  clearPerspectiveUpdateBurst(token);

  const timers = new Set();
  PENDING_PERSPECTIVE_UPDATE_BURSTS.set(token, timers);

  for (const delay of delays) {
    const n = Number(delay) || 0;
    if (n <= 0) {
      schedulePerspectiveUpdate(token, { includePreviews: false });
      continue;
    }

    const timer = globalThis.setTimeout(() => {
      timers.delete(timer);
      if (!token.destroyed) schedulePerspectiveUpdate(token, { includePreviews: false });
      if (!timers.size) PENDING_PERSPECTIVE_UPDATE_BURSTS.delete(token);
    }, n);
    timers.add(timer);
  }

  if (!timers.size) PENDING_PERSPECTIVE_UPDATE_BURSTS.delete(token);
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

export function clearPerspectiveUpdateState() {
  PENDING_PERSPECTIVE_UPDATES.clear();
  PENDING_PERSPECTIVE_TOKEN_ONLY_UPDATES.clear();
  if (PENDING_PERSPECTIVE_RAF) {
    const caf = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
    try { caf(PENDING_PERSPECTIVE_RAF); } catch (_err) { /* noop */ }
    PENDING_PERSPECTIVE_RAF = null;
  }

  for (const token of [...PENDING_PERSPECTIVE_UPDATE_BURSTS.keys()]) clearPerspectiveUpdateBurst(token);
  PENDING_PERSPECTIVE_UPDATE_BURSTS.clear();
}
