import { MODULE_ID } from "./constants.js";
import { i18n } from "./utils.js";
import { getLevelConfig, normalizeConfig, setLevelConfig, isPerspectiveEnabled } from "./config.js";
import { PerspectiveCalibrator } from "./calibrator.js";
import { PerspectiveGridOverlay } from "./grid-overlay.js";
import { injectLevelConfig } from "./level-config-ui.js";
import {
  applyPerspectiveMeasurement,
  buildPerspectiveMeasurement,
  perspectiveDistanceBetween,
  squareGridDistanceSpaces
} from "./measurement.js";
import {
  anchorToPoint,
  getPerspectiveCellSize,
  getPerspectiveGridModel,
  pointToAnchor,
  perspectiveGridModelToScreen,
  perspectiveGridToScreen,
  perspectiveGroundPointToElevatedScreen,
  scaleForPerspectivePoint,
  scaleForY,
  screenPointToElevationGroundPoint,
  screenPointToPerspectiveGrid,
  screenPointToPerspectiveGround
} from "./projection.js";
import { installRuntimePatches } from "./patches.js";
import {
  applyPerspectiveToToken,
  clearPerspectiveSortState,
  clearTokenScaleState,
  forEachToken,
  isTokenObject,
  refreshTokens,
  removePerspectiveFromToken,
  schedulePerspectiveSort
} from "./tokens.js";

export const gridOverlay = new PerspectiveGridOverlay();
export const calibrator = new PerspectiveCalibrator({
  refresh: refreshAll,
  drawGrid: () => {
    gridOverlay.forceVisible = calibrator.active;
    gridOverlay.draw();
  }
});

let hooksRegistered = false;

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

function getActorFromActiveEffect(effect) {
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

function scheduleTokenStatusIconRefresh(token, { redraw = true } = {}) {
  if (!token || token.destroyed) return;
  const current = PENDING_STATUS_ICON_REFRESHES.get(token) ?? { redraw: false };
  current.redraw ||= redraw;
  PENDING_STATUS_ICON_REFRESHES.set(token, current);

  if (PENDING_STATUS_ICON_REFRESH_TIMEOUT || PENDING_STATUS_ICON_REFRESH_RAF) return;

  // ActiveEffect hooks can fire before the token's actor/status cache is fully
  // settled. Defer one macrotask and one frame before rebuilding the icon layer.
  PENDING_STATUS_ICON_REFRESH_TIMEOUT = globalThis.setTimeout(() => {
    PENDING_STATUS_ICON_REFRESH_TIMEOUT = null;
    const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
    PENDING_STATUS_ICON_REFRESH_RAF = raf(flushTokenStatusIconRefreshes);
  }, 0);
}

function scheduleActorStatusIconRefresh(actor, options = {}) {
  for (const token of collectTokensForActor(actor)) scheduleTokenStatusIconRefresh(token, options);
}

function scheduleTokenStatusIconRefreshBurst(token, options = {}) {
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

function scheduleActorStatusIconRefreshBurst(actor, options = {}) {
  for (const token of collectTokensForActor(actor)) scheduleTokenStatusIconRefreshBurst(token, options);
}

function installActorStatusEffectRefreshPatch() {
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

  // Наш модуль меняет scale у token.mesh, поэтому после перестройки слоя эффектов
  // безопасно ещё раз применить перспективу к самому арту токена.
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


function clearTokenStatusIconRefreshState() {
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


gridOverlay.onLevelChange = () => refreshAll();

function refreshOverlays() {
  gridOverlay.forceVisible = calibrator.active;
  gridOverlay.draw();
  if (calibrator.active) calibrator.redraw();
}

export function refreshAll() {
  refreshOverlays();
  refreshTokens();
  schedulePerspectiveSort();
}

function injectLevelConfigWithRuntime(app, html) {
  injectLevelConfig(app, html, { openCalibrator: () => calibrator.open() });
}

export function registerHooks() {
  if (hooksRegistered) return;
  const hooks = globalThis.Hooks;
  if (!hooks) return;
  hooksRegistered = true;

  hooks.once("init", () => {
    console.log(`${MODULE_ID} | Initializing`);
    installRuntimePatches();
    installActorStatusEffectRefreshPatch();
  });

  hooks.once("ready", () => {
    installRuntimePatches();
    installActorStatusEffectRefreshPatch();
  });

  hooks.on("getSceneControlButtons", controls => {
    const tokens = controls.tokens;
    if (!tokens?.tools) return;

    tokens.tools.perspectiveLevelsCalibrator = {
      name: "perspectiveLevelsCalibrator",
      title: i18n("PERSPECTIVE_LEVELS.ToolbarCalibrator"),
      icon: "fa-solid fa-vector-square",
      order: Object.keys(tokens.tools).length + 100,
      button: true,
      visible: game.user?.isGM,
      onChange: () => calibrator.toggle()
    };
  });

  hooks.on("renderLevelConfig", (app, html, _context, _options) => injectLevelConfigWithRuntime(app, html));
  hooks.on("renderApplicationV2", (app, html, _context, _options) => {
    if (app?.constructor?.name === "LevelConfig") injectLevelConfigWithRuntime(app, html);
  });

  hooks.on("canvasReady", () => {
    installRuntimePatches();
    installActorStatusEffectRefreshPatch();
    gridOverlay.startTicker();
    refreshAll();
  });

  hooks.on("canvasPan", () => refreshOverlays());

  // В Foundry 14 иконки статусов рисуются отдельным слоем Token#drawEffects.
  // Перспективный модуль часто трогает mesh/refresh токена, поэтому при добавлении
  // ActiveEffect явно перестраиваем слой иконок для всех токенов затронутого актёра.
  hooks.on("createActiveEffect", effect => {
    try { scheduleActorStatusIconRefreshBurst(getActorFromActiveEffect(effect), { redraw: true }); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to schedule status icon refresh after effect creation`, err); }
  });

  hooks.on("updateActiveEffect", effect => {
    try { scheduleActorStatusIconRefreshBurst(getActorFromActiveEffect(effect), { redraw: true }); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to schedule status icon refresh after effect update`, err); }
  });

  hooks.on("deleteActiveEffect", effect => {
    try { scheduleActorStatusIconRefreshBurst(getActorFromActiveEffect(effect), { redraw: true }); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to schedule status icon refresh after effect deletion`, err); }
  });

  hooks.on("applyTokenStatusEffect", token => {
    try { scheduleTokenStatusIconRefreshBurst(token, { redraw: true }); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to schedule status icon refresh after token status change`, err); }
  });

  // Обновить масштаб когда токен создается или изменяется
  hooks.on("createToken", (token) => {
    try {
      const config = getLevelConfig();
      if (isPerspectiveEnabled(config)) {
        applyPerspectiveToToken(token.object);
        schedulePerspectiveSort({ debounce: true });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective to new token`, err);
    }
  });

  hooks.on("updateToken", (token, changes = {}, options = {}) => {
    try {
      if (options?._perspectiveLevelsSort && Object.keys(changes ?? {}).every(key => key === "sort" || key === "_id")) return;

      const config = getLevelConfig();
      if (isPerspectiveEnabled(config)) {
        const positionChanged = changes.x !== undefined || changes.y !== undefined || changes.elevation !== undefined || changes.level !== undefined;

        // При обычном drag Foundry сама ведёт анимацию движения. Если сразу после
        // updateToken насильно пересчитать mesh scale/sort по финальным координатам,
        // дальний drag может визуально оборваться телепортом. Поэтому для
        // анимируемого перемещения ждём moveToken/recordToken/stopToken.
        if (positionChanged && options?.animate !== false && !options?._perspectiveLevelsKeyboardMove) {
          schedulePerspectiveSort({ debounce: true });
          return;
        }

        applyPerspectiveToToken(token.object);
        if (positionChanged) {
          schedulePerspectiveSort({ debounce: true });
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective to updated token`, err);
    }
  });

  hooks.on("canvasTearDown", () => {
    calibrator.close(false);
    gridOverlay.stopTicker();
    gridOverlay.destroy();
    forEachToken(removePerspectiveFromToken);
    clearTokenScaleState();
    clearPerspectiveSortState();
    clearTokenStatusIconRefreshState();
  });

  hooks.on("drawObject", object => {
    if (isTokenObject(object)) applyPerspectiveToToken(object);
  });
  hooks.on("refreshObject", object => {
    if (isTokenObject(object)) applyPerspectiveToToken(object);
  });
  hooks.on("destroyObject", object => {
    if (isTokenObject(object)) removePerspectiveFromToken(object);
  });

  hooks.on("moveToken", () => { refreshTokens(); schedulePerspectiveSort(); });
  hooks.on("recordToken", () => { refreshTokens(); schedulePerspectiveSort(); });
  hooks.on("stopToken", () => { refreshTokens(); schedulePerspectiveSort({ debounce: true }); });

  hooks.on("updateDocument", (document, changes = {}) => {
    const canvasRef = globalThis.canvas;
    if (!canvasRef?.ready) return;
    if (document?.documentName === "Level" && document.parent?.id === canvasRef.scene?.id) refreshAll();

    if (document?.documentName === "Scene" && document.id === canvasRef.scene?.id) {
      const hasProperty = globalThis.foundry?.utils?.hasProperty;
      const gridChanged = Boolean(
        changes.grid
        || changes.width !== undefined
        || changes.height !== undefined
        || Object.hasOwn(changes, "grid.distance")
        || Object.hasOwn(changes, "grid.units")
        || Object.hasOwn(changes, "grid.size")
        || hasProperty?.(changes, "grid.distance")
        || hasProperty?.(changes, "grid.units")
        || hasProperty?.(changes, "grid.size")
      );
      if (gridChanged) refreshAll();
    }
  });
}

export function getPublicApi() {
  return {
    MODULE_ID,
    getLevelConfig,
    setLevelConfig,
    normalizeConfig,
    refresh: refreshAll,
    openCalibrator: () => calibrator.open(),
    closeCalibrator: () => calibrator.close(),
    toggleCalibrator: () => calibrator.toggle(),
    scaleForY,
    scaleForPerspectivePoint,
    screenPointToPerspectiveGround,
    screenPointToPerspectiveGrid,
    getPerspectiveGridModel,
    perspectiveGridModelToScreen,
    perspectiveGridToScreen,
    perspectiveDistanceBetween,
    measurePerspectivePath: buildPerspectiveMeasurement,
    config: {
      getLevelConfig,
      setLevelConfig,
      normalizeConfig
    },
    projection: {
      anchorToPoint,
      pointToAnchor,
      scaleForY,
      scaleForPerspectivePoint,
      getPerspectiveCellSize,
      getPerspectiveGridModel,
      perspectiveGridModelToScreen,
      perspectiveGridToScreen,
      perspectiveGroundPointToElevatedScreen,
      screenPointToElevationGroundPoint,
      screenPointToPerspectiveGround,
      screenPointToPerspectiveGrid
    },
    measurement: {
      squareGridDistanceSpaces,
      perspectiveDistanceBetween,
      buildPerspectiveMeasurement,
      applyPerspectiveMeasurement
    },
    overlay: gridOverlay,
    calibrator
  };
}
