import { MODULE_ID } from "./constants.js";
import { i18n } from "./utils.js";
import { getLevelConfig, getRuntimeLevelConfig, clearRuntimeLevelConfigCache, isPerspectiveEnabled, normalizeConfig, setLevelConfig } from "./config.js";
import { collectTokensForActor } from "./actor-tokens.js";
import { adaptSequencerEffect } from "./token-visuals.js";
import { refreshPerspectiveRegions, clearPerspectiveRegionState } from "./region-perspective.js";
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
  clearTokenStatusIconRefreshState,
  getActorFromActiveEffect,
  installActorStatusEffectRefreshPatch,
  scheduleActorStatusIconRefreshBurst,
  scheduleTokenStatusIconRefreshBurst
} from "./status-effects.js";
import { clearPerspectiveUpdateState, schedulePerspectiveUpdate } from "./token-update-queue.js";
import { isTokenArtMultiplierUpdate } from "./token-art.js";
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

gridOverlay.onLevelChange = () => {
  if (calibrator.active && calibrator.level !== globalThis.canvas?.level) calibrator.close(false);
  refreshAll();
};

function refreshOverlays() {
  gridOverlay.forceVisible = calibrator.active;
  gridOverlay.draw();
  if (calibrator.active) calibrator.redraw();
}

export function refreshAll() {
  refreshPerspectiveRegions();
  refreshOverlays();
  refreshTokens();
  schedulePerspectiveSort({ force: true });
}

function injectLevelConfigWithRuntime(app, html) {
  injectLevelConfig(app, html, { openCalibrator: () => calibrator.open() });
}

function getHookTokenObject(value) {
  if (!globalThis.canvas?.ready) return null;
  const object = isTokenObject(value) ? value : value?.object ?? value?.token?.object ?? value?.placeable ?? null;
  if (object?.document?.parent && object.document.parent !== globalThis.canvas.scene) return null;
  return isTokenObject(object) ? object : null;
}

function refreshTokenFromHook(value, { debounce = false } = {}) {
  const token = getHookTokenObject(value);
  if (token) {
    applyPerspectiveToToken(token, { scheduleSort: false });
    schedulePerspectiveSort({ token, debounce });
  }
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
  hooks.on("createSequencerEffect", adaptSequencerEffect);

  hooks.on("createActiveEffect", effect => {
    try { scheduleActorStatusIconRefreshBurst(getActorFromActiveEffect(effect), { redraw: true }); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to schedule status icon refresh after effect creation`, err); }
  });

  hooks.on("updateActor", (actor, changes = {}) => {
    if (!isTokenArtMultiplierUpdate(changes) || !globalThis.canvas?.ready || !getRuntimeLevelConfig().enabled) return;
    for (const token of collectTokensForActor(actor)) schedulePerspectiveUpdate(token);
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

  hooks.on("createToken", token => {
    try {
      const object = getHookTokenObject(token);
      if (!object) return;
      const config = getRuntimeLevelConfig();
      if (isPerspectiveEnabled(config)) {
        applyPerspectiveToToken(object, { scheduleSort: false });
        schedulePerspectiveSort({ token: object, debounce: true });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective to new token`, err);
    }
  });

  hooks.on("updateToken", (token, changes = {}, options = {}) => {
    try {
      if (options?._perspectiveLevelsSort && Object.keys(changes ?? {}).every(key => key === "sort" || key === "_id")) return;
      const object = getHookTokenObject(token);
      if (!object) return;
      const config = getRuntimeLevelConfig();
      if (isPerspectiveEnabled(config)) {
        const positionChanged = changes.x !== undefined || changes.y !== undefined || changes.elevation !== undefined || changes.level !== undefined;

        if (positionChanged && options?.animate !== false && !options?._perspectiveLevelsKeyboardMove) {
          schedulePerspectiveSort({ token: object, debounce: true });
          return;
        }

        applyPerspectiveToToken(object, { scheduleSort: !positionChanged });
        if (positionChanged) schedulePerspectiveSort({ token: object, debounce: true });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective to updated token`, err);
    }
  });

  hooks.on("canvasTearDown", () => {
    clearPerspectiveRegionState();
    calibrator.close(false);
    gridOverlay.stopTicker();
    gridOverlay.destroy();
    forEachToken(removePerspectiveFromToken);
    clearTokenScaleState();
    clearPerspectiveSortState();
    clearPerspectiveUpdateState();
    clearTokenStatusIconRefreshState();
    clearRuntimeLevelConfigCache();
  });

  hooks.on("drawToken", object => {
    if (isTokenObject(object)) applyPerspectiveToToken(object);
  });
  hooks.on("refreshToken", object => {
    // Sort flushing applies render flags, which emits refreshToken again.
    if (isTokenObject(object)) applyPerspectiveToToken(object, { scheduleSort: false });
  });
  hooks.on("destroyToken", object => {
    if (isTokenObject(object)) removePerspectiveFromToken(object);
  });

  hooks.on("moveToken", token => refreshTokenFromHook(token));
  hooks.on("recordToken", token => refreshTokenFromHook(token));
  hooks.on("stopToken", token => refreshTokenFromHook(token, { debounce: true }));

  const onConfigDocumentUpdate = (document, changes = {}) => {
    const canvasRef = globalThis.canvas;
    if (!canvasRef?.ready) return;
    if (document?.documentName === "Level" && document.parent?.id === canvasRef.scene?.id
      && document.id === canvasRef.level?.id) refreshAll();

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
  };
  hooks.on("updateLevel", onConfigDocumentUpdate);
  hooks.on("updateScene", onConfigDocumentUpdate);
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
