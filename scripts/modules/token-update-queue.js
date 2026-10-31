import { MODULE_ID } from "./constants.js";
import { getRuntimeLevelConfig as getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveToToken, isTokenObject, schedulePerspectiveSort } from "./tokens.js";
import { buildTokenPreviewIndex, getIndexedTokenPreviews } from "./token-previews.js";

const PENDING_PERSPECTIVE_UPDATES = new Set();
const PENDING_PERSPECTIVE_TOKEN_ONLY_UPDATES = new Set();
const PENDING_PERSPECTIVE_UPDATE_BURSTS = new Map();
const PERSPECTIVE_UPDATE_BURST_DELAYS_MS = [0, 50, 125, 250, 500];
let PENDING_PERSPECTIVE_RAF = null;

export function collectTokenAndDragPreviews(token) {
  return getIndexedTokenPreviews(token, buildTokenPreviewIndex([token], isTokenObject));
}

function applyPerspectiveToTokenAndPreviews(token, touchedTokens, previewIndex = null) {
  if (!token) return;
  if (token.destroyed || touchedTokens.has(token)) return;
  const previews = previewIndex ? getIndexedTokenPreviews(token, previewIndex) : collectTokenAndDragPreviews(token);
  for (const preview of previews) {
    if (touchedTokens.has(preview) || preview.destroyed) continue;
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
  const previewIndex = buildTokenPreviewIndex(tokens, isTokenObject);
  for (const token of tokens) {
    try {
      applyPerspectiveToTokenAndPreviews(token, touchedTokens, previewIndex);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to update perspective`, err);
    }
  }

  for (const token of tokenOnly) {
    if (touchedTokens.has(token) || token.destroyed) continue;
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
    applyPerspectiveUpdateNow(token);
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
