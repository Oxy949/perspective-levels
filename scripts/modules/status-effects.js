import { MODULE_ID } from "./constants.js";
import { applyPerspectiveToToken } from "./tokens.js";

const PENDING_STATUS_ICON_REFRESHES = new Map();
const PENDING_STATUS_ICON_REFRESH_TIMERS = new Set();
const STATUS_ICON_REFRESH_BURST_DELAYS_MS = [0, 60, 180, 360];
let PENDING_STATUS_ICON_REFRESH_TIMEOUT = null;
let PENDING_STATUS_ICON_REFRESH_RAF = null;
let ACTOR_STATUS_EFFECT_REFRESH_PATCHED = false;

function refreshRenderFlags(object, flags = {}) {
  try { object?.renderFlags?.set?.(flags); } catch (_err) { /* noop */ }
  try { object?.applyRenderFlags?.(); } catch (_err) { /* noop */ }
}

function tokenMatchesActor(token, actor) {
  if (!token || token.destroyed || !actor) return false;
  const tokenActor = token.actor ?? token.document?.actor;
  if (tokenActor === actor) return true;

  const actorUuid = actor.uuid ?? actor.document?.uuid;
  const tokenActorUuid = tokenActor?.uuid ?? tokenActor?.document?.uuid;
  if (actorUuid && tokenActorUuid && String(actorUuid) === String(tokenActorUuid)) return true;

  const actorId = actor.id ?? actor._id;
  const tokenActorId = tokenActor?.id ?? tokenActor?._id;
  if (actorId && tokenActorId && String(actorId) === String(tokenActorId)) return true;

  return false;
}

function collectTokensForActor(actor) {
  const tokens = new Set();
  if (!actor) return tokens;

  try {
    const actorTokens = actor.getActiveTokens?.();
    if (Array.isArray(actorTokens)) {
      for (const token of actorTokens) if (token && !token.destroyed) tokens.add(token);
    }
  } catch (_err) { /* Some synthetic actors can throw while scenes are changing. */ }

  try {
    const token = actor.token?.object ?? actor.prototypeToken?.object;
    if (token && !token.destroyed) tokens.add(token);
  } catch (_err) { /* noop */ }

  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (tokenMatchesActor(token, actor)) tokens.add(token);
  }

  return tokens;
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
  if (!token || token.destroyed) return;
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
  for (const token of collectTokensForActor(actor)) scheduleTokenStatusIconRefresh(token, options);
}

export function scheduleTokenStatusIconRefreshBurst(token, options = {}) {
  if (!token || token.destroyed) return;

  for (const delay of STATUS_ICON_REFRESH_BURST_DELAYS_MS) {
    if (delay <= 0) {
      scheduleTokenStatusIconRefresh(token, options);
      continue;
    }

    const timer = globalThis.setTimeout(() => {
      PENDING_STATUS_ICON_REFRESH_TIMERS.delete(timer);
      scheduleTokenStatusIconRefresh(token, options);
    }, delay);
    PENDING_STATUS_ICON_REFRESH_TIMERS.add(timer);
  }
}

export function scheduleActorStatusIconRefreshBurst(actor, options = {}) {
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
  if (!token || token.destroyed) return;

  try {
    if (token.effects && !token.effects.destroyed) {
      token.effects.visible = true;
      token.effects.renderable = true;
      token.effects.alpha = 1;
    }
  } catch (_err) { /* noop */ }

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

  try {
    if (typeof token._refreshEffects === "function") token._refreshEffects();
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to refresh token status effect positions`, err);
  }

  refreshRenderFlags(token, { refreshEffects: true, refreshState: true });

  try { applyPerspectiveToToken(token); }
  catch (err) { console.warn(`${MODULE_ID} | Failed to reapply perspective after status effects refresh`, err); }
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
  PENDING_STATUS_ICON_REFRESHES.clear();
  for (const timer of PENDING_STATUS_ICON_REFRESH_TIMERS) {
    try { globalThis.clearTimeout(timer); } catch (_err) { /* noop */ }
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
