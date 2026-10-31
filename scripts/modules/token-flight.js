import { MODULE_ID } from "./constants.js";
import { getRuntimeLevelConfig as getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { getCachedPerspectiveGridModel, perspectiveGridModelToScreen, perspectiveGroundPointToElevatedScreen,
  screenPointToPerspectiveGrid } from "./projection.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { getDocumentPixelSize, isShiftActive, wrapPrototypeMethod } from "./foundry-helpers.js";
import { schedulePerspectiveUpdate } from "./token-update-queue.js";
import { beginTokenShadowPreview, endTokenShadowPreview } from "./tokens.js";

const DRAG_STATE = new WeakMap();
let ACTIVE_DRAG_EVENT_SHIFT = null;

function getFlightDragState(token, waypoint = null) {
  token = token?._original ?? token;
  let state = DRAG_STATE.get(token);
  if (state && !waypoint) return state;

  const config = getLevelConfig();
  const rect = getSceneRect();
  const document = token.document;
  const { width, height } = getDocumentPixelSize(document, token, rect);
  const source = waypoint ?? document._source ?? document;
  const x = Number(source.x) || 0;
  const y = Number(source.y) || 0;
  const elevation = Number(source.elevation) || 0;
  const point = { x: x + width / 2, y: y + height, elevation };
  const model = getCachedPerspectiveGridModel(config, rect);
  const grid = screenPointToPerspectiveGrid(point, config, rect, model);
  const gridDistance = getSceneGridDistance();

  state = { startElevation: elevation, row: grid.j, width, height, model, gridDistance, config, rect };
  DRAG_STATE.set(token, state);
  return state;
}

function computeFlightElevationFromY(state, x, y) {
  const visual = screenPointToPerspectiveGrid({ x: x + state.width / 2, y: y + state.height, elevation: 0 }, state.config, state.rect, state.model);
  let elevation = (state.row - visual.j) * state.gridDistance;

  if (state.startElevation > 0.0001) elevation = Math.max(0, elevation);
  else if (state.startElevation < -0.0001) elevation = Math.min(0, elevation);
  return Math.round((elevation + Number.EPSILON) * 1000) / 1000;
}

function withDragEvent(original, args) {
  const previousShift = ACTIVE_DRAG_EVENT_SHIFT;
  ACTIVE_DRAG_EVENT_SHIFT = isShiftActive(args[0]);
  try { return original.apply(this, args); }
  finally { ACTIVE_DRAG_EVENT_SHIFT = previousShift; }
}

export function installTokenFlightDragPatches(proto) {
  if (!proto) return false;

  wrapPrototypeMethod(proto, "_initializeDragLeft", function(original, args) {
    const result = original.apply(this, args);
    for (const clone of args[0]?.interactionData?.clones ?? []) {
      DRAG_STATE.delete(clone._original ?? clone);
    }
    return result;
  });

  wrapPrototypeMethod(proto, "_getDragWaypointPosition", function(original, args) {
    const config = getLevelConfig();
    const enabled = globalThis.canvas?.ready && isPerspectiveEnabled(config);
    const snap = enabled && args[2]?.snap;
    const result = original.apply(this, snap ? [args[0], args[1], { ...args[2], snap: false }] : args);
    try {
      const changes = args[1];
      if (!enabled) return result;
      if (changes?.elevation !== undefined && result) {
        getFlightDragState(this, result);
        return result;
      }
      const flight = ACTIVE_DRAG_EVENT_SHIFT ?? isShiftActive();
      if (snap && !flight && result) {
        const rect = getSceneRect(), { width, height } = getDocumentPixelSize(this.document, this, rect);
        const coords = screenPointToPerspectiveGrid({ x: result.x + width / 2, y: result.y + height,
          elevation: result.elevation }, config, rect);
        const model = getCachedPerspectiveGridModel(config, rect);
        const ground = perspectiveGridModelToScreen(model,
          Math.round(coords.i - this.document.width / 2) + this.document.width / 2, Math.round(coords.j));
        const point = perspectiveGroundPointToElevatedScreen({ ...ground, elevation: result.elevation }, config, rect, model);
        result.x = Math.round(point.x - width / 2); result.y = Math.round(point.y - height);
      }
      if (!flight
        || changes?.y === undefined || changes?.elevation !== undefined
        || !result || !Number.isFinite(Number(result.y))) return result;

      // Foundry applies this waypoint to each clone and saves the whole movement
      // on drop. Mutating an original document or saving again from _onDragEnd
      // races that workflow, especially while a group's previews are destroyed.
      result.elevation = computeFlightElevationFromY(getFlightDragState(this), Number(result.x), Number(result.y));
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to prepare perspective flight waypoint`, err);
    }
    return result;
  });

  wrapPrototypeMethod(proto, "_onDragLeftMove", withDragEvent);
  wrapPrototypeMethod(proto, "_onDragClickLeft", withDragEvent);

  wrapPrototypeMethod(proto, "_onDragStart", function(original, args) {
    beginTokenShadowPreview(this);
    return original.apply(this, args);
  });

  wrapPrototypeMethod(proto, "_finalizeDragLeft", function(original, args) {
    const clones = args[0]?.interactionData?.clones ?? [];
    try { return original.apply(this, args); }
    finally {
      DRAG_STATE.delete(this);
      for (const clone of clones) DRAG_STATE.delete(clone._original ?? clone);
    }
  });

  wrapPrototypeMethod(proto, "_onDragEnd", function(original, args) {
    try { return original.apply(this, args); }
    finally {
      const token = this._original ?? this;
      endTokenShadowPreview(this);
      DRAG_STATE.delete(token);
      if (!token.destroyed) schedulePerspectiveUpdate(token, { includePreviews: false });
    }
  });

  return true;
}
