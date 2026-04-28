import { MODULE_ID } from "./constants.js";
import { getLevelConfig, normalizeConfig, setLevelConfig } from "./config.js";
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
  scaleForY,
  screenPointToPerspectiveGrid,
  screenPointToPerspectiveGround
} from "./projection.js";
import { installRuntimePatches } from "./patches.js";
import {
  applyPerspectiveToToken,
  clearTokenScaleState,
  forEachToken,
  isTokenObject,
  refreshTokens,
  removePerspectiveFromToken
} from "./tokens.js";

export const gridOverlay = new PerspectiveGridOverlay();
export const calibrator = new PerspectiveCalibrator({
  refresh: refreshAll,
  drawGrid: () => gridOverlay.draw()
});

let hooksRegistered = false;

gridOverlay.onLevelChange = () => refreshAll();

export function refreshAll() {
  gridOverlay.draw();
  if (calibrator.active) calibrator.redraw();
  refreshTokens();
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
  });

  hooks.once("ready", () => {
    installRuntimePatches();
  });

  hooks.on("getSceneControlButtons", controls => {
    const tokens = controls.tokens;
    if (!tokens?.tools) return;

    tokens.tools.perspectiveLevelsCalibrator = {
      name: "perspectiveLevelsCalibrator",
      title: "Perspective Levels: калибровка уровня",
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
    gridOverlay.startTicker();
    refreshAll();
  });

  hooks.on("canvasPan", () => refreshAll());
  hooks.on("canvasTearDown", () => {
    calibrator.close(false);
    gridOverlay.stopTicker();
    gridOverlay.destroy();
    forEachToken(removePerspectiveFromToken);
    clearTokenScaleState();
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

  hooks.on("moveToken", () => refreshTokens());
  hooks.on("recordToken", () => refreshTokens());
  hooks.on("stopToken", () => refreshTokens());

  hooks.on("updateDocument", (document, changes) => {
    const canvasRef = globalThis.canvas;
    if (!canvasRef?.ready) return;
    if (document?.documentName === "Level" && document.parent?.id === canvasRef.scene?.id) refreshAll();
    if (document?.documentName === "Scene" && document.id === canvasRef.scene?.id && (changes.grid || changes.width || changes.height)) refreshAll();
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
      getPerspectiveCellSize,
      getPerspectiveGridModel,
      perspectiveGridModelToScreen,
      perspectiveGridToScreen,
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
