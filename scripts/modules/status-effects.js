import { MODULE_ID } from "./constants.js";
import { applyPerspectiveToToken } from "./tokens.js";
import { getRuntimeLevelConfig } from "./config.js";
import { collectTokensForActor } from "./actor-tokens.js";

const PENDING_STATUS_ICON_REFRESHES = new Map();
const PENDING_STATUS_ICON_REFRESH_TIMERS = new Map();
const IN_FLIGHT_STATUS_ICON_REFRESHES = new Map();
const STATUS_ICON_REFRESH_BURST_DELAYS_MS = [0, 60, 180, 360];
let PENDING_STATUS_ICON_REFRESH_TIMEOUT = null;
let PENDING_STATUS_ICON_REFRESH_RAF = null;
let ACTOR_STATUS_EFFECT_REFRESH_PATCHED = false;
let statusRefreshGeneration = 0;

function refreshRenderFlags(object, flags = {}) {
  try { object?.renderFlags?.set?.(flags); } catch (_err) { /* noop */ }
  try { object?.applyRenderFlags?.(); } catch (_err) { /* noop */ }
}

function canRefresh(token, scene = globalThis.canvas?.scene) {
  return Boolean(token && !token.destroyed && globalThis.canvas?.ready
    && scene === globalThis.canvas.scene
    && (!token.document?.parent || token.document.parent === scene)
    && getRuntimeLevelConfig().enabled);
}

export function getActorFromActiveEffect(effect) {
  const parent = effect?.parent ?? effect?.document?.parent;
  if (parent?.documentName === "Actor") return parent;
  if (effect?.actor?.documentName === "Actor") return effect.actor;
  if (parent?.actor?.documentName === "Actor") return parent.actor;
  return null;
}

function getActorClass() {
  return globalThis.foundry?.documents?.Actor
    ?? globalThis.CONFIG?.Actor?.documentClass
    ?? globalThis.Actor
    ?? null;
}

export function scheduleTokenStatusIconRefresh(token, { redraw = true } = {}) {
  if (!canRefresh(token)) return;
  const current = PENDING_STATUS_ICON_REFRESHES.get(token) ?? { redraw: false };
  current.redraw ||= redraw;
  PENDING_STATUS_ICON_REFRESHES.set(token, current);

  if (PENDING_STATUS_ICON_REFRESH_TIMEOUT || PENDING_STATUS_ICON_REFRESH_RAF) return;

  PENDING_STATUS_ICON_REFRESH_TIMEOUT = globalThis.setTimeout(() => {
    PENDING_STATUS_ICON_REFRESH_TIMEOUT = null;
    const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
    PENDING_STATUS_ICON_REFRESH_RAF = raf(flushTokenStatusIconRefreshes);
  }, 0);
}

export function scheduleActorStatusIconRefresh(actor, options = {}) {
  if (!globalThis.canvas?.ready || !getRuntimeLevelConfig().enabled) return;
  for (const token of collectTokensForActor(actor)) scheduleTokenStatusIconRefresh(token, options);
}

export function scheduleTokenStatusIconRefreshBurst(token, options = {}) {
  if (!canRefresh(token)) return;
  const previous = PENDING_STATUS_ICON_REFRESH_TIMERS.get(token);
  for (const timer of previous?.timers ?? []) globalThis.clearTimeout(timer);
  const burst = { timers: new Set(), options: { ...options, redraw: previous?.options.redraw || options.redraw !== false } };
  PENDING_STATUS_ICON_REFRESH_TIMERS.set(token, burst);

  for (const delay of STATUS_ICON_REFRESH_BURST_DELAYS_MS) {
    if (delay <= 0) {
      scheduleTokenStatusIconRefresh(token, burst.options);
      continue;
    }

    const timer = globalThis.setTimeout(() => {
      burst.timers.delete(timer);
      if (!burst.timers.size) PENDING_STATUS_ICON_REFRESH_TIMERS.delete(token);
      scheduleTokenStatusIconRefresh(token, burst.options);
    }, delay);
    burst.timers.add(timer);
  }
}

export function scheduleActorStatusIconRefreshBurst(actor, options = {}) {
  if (!globalThis.canvas?.ready || !getRuntimeLevelConfig().enabled) return;
  for (const token of collectTokensForActor(actor)) scheduleTokenStatusIconRefreshBurst(token, options);
}

export function installActorStatusEffectRefreshPatch() {
  if (ACTOR_STATUS_EFFECT_REFRESH_PATCHED) return false;

  const ActorClass = getActorClass();
  const proto = ActorClass?.prototype;
  const original = proto?.toggleStatusEffect;
  if (typeof original !== "function") return false;

  ACTOR_STATUS_EFFECT_REFRESH_PATCHED = true;
  if (original._perspectiveLevelsStatusRefreshWrapped) return false;

  const wrapped = async function perspectiveLevelsToggleStatusEffectWrapper(...args) {
    try {
      return await original.apply(this, args);
    } finally {
      try { scheduleActorStatusIconRefreshBurst(this, { redraw: true }); }
      catch (err) { console.warn(`${MODULE_ID} | Failed to refresh token status icons after Actor#toggleStatusEffect`, err); }
    }
  };

  wrapped._perspectiveLevelsStatusRefreshWrapped = true;
  wrapped._perspectiveLevelsOriginal = original;
  proto.toggleStatusEffect = wrapped;
  console.log(`${MODULE_ID} | Actor status effect refresh patch installed`);
  return true;
}

async function refreshTokenStatusIcons(token, { redraw = true } = {}) {
  if (!canRefresh(token)) return;
  const existing = IN_FLIGHT_STATUS_ICON_REFRESHES.get(token);
  if (existing) {
    existing.pending ??= { redraw: false };
    existing.pending.redraw ||= redraw;
    return;
  }
  const state = { generation: statusRefreshGeneration, scene: globalThis.canvas.scene };
  IN_FLIGHT_STATUS_ICON_REFRESHES.set(token, state);
  const current = () => state.generation === statusRefreshGeneration && canRefresh(token, state.scene);

  try {
    try {
      if (redraw && typeof token.drawEffects === "function") {
        await token.drawEffects();
      } else if (redraw) {
        refreshRenderFlags(token, { redrawEffects: true });
      } else {
        refreshRenderFlags(token, { refreshEffects: true });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to redraw token status effects`, err);
    }

    if (!current()) return;

    try {
      if (typeof token._refreshEffects === "function") token._refreshEffects();
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to refresh token status effect positions`, err);
    }

    refreshRenderFlags(token, { refreshEffects: true, refreshState: true });

    try { applyPerspectiveToToken(token); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to reapply perspective after status effects refresh`, err); }
  } finally {
    if (IN_FLIGHT_STATUS_ICON_REFRESHES.get(token) === state) {
      IN_FLIGHT_STATUS_ICON_REFRESHES.delete(token);
      if (state.pending && current()) scheduleTokenStatusIconRefresh(token, state.pending);
    }
  }
}

function flushTokenStatusIconRefreshes() {
  PENDING_STATUS_ICON_REFRESH_RAF = null;
  if (!globalThis.canvas?.ready) {
    PENDING_STATUS_ICON_REFRESHES.clear();
    return;
  }

  const entries = [...PENDING_STATUS_ICON_REFRESHES.entries()];
  PENDING_STATUS_ICON_REFRESHES.clear();

  for (const [token, options] of entries) refreshTokenStatusIcons(token, options);
}

export function clearTokenStatusIconRefreshState() {
  statusRefreshGeneration++;
  IN_FLIGHT_STATUS_ICON_REFRESHES.clear();
  PENDING_STATUS_ICON_REFRESHES.clear();
  for (const burst of PENDING_STATUS_ICON_REFRESH_TIMERS.values()) {
    for (const timer of burst.timers) {
      try { globalThis.clearTimeout(timer); } catch (_err) { /* noop */ }
    }
  }
  PENDING_STATUS_ICON_REFRESH_TIMERS.clear();
  if (PENDING_STATUS_ICON_REFRESH_TIMEOUT) {
    globalThis.clearTimeout(PENDING_STATUS_ICON_REFRESH_TIMEOUT);
    PENDING_STATUS_ICON_REFRESH_TIMEOUT = null;
  }
  if (PENDING_STATUS_ICON_REFRESH_RAF) {
    const caf = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
    try { caf(PENDING_STATUS_ICON_REFRESH_RAF); } catch (_err) { /* noop */ }
    PENDING_STATUS_ICON_REFRESH_RAF = null;
  }
}
