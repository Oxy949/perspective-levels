import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { elevationToScreenOffsetAtRow, screenPointToPerspectiveGrid } from "./projection.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { getDocumentPixelSize, isShiftActive, wrapPrototypeMethod } from "./foundry-helpers.js";
import { schedulePerspectiveUpdate } from "./token-update-queue.js";
import { beginTokenShadowPreview, endTokenShadowPreview } from "./tokens.js";

const DRAG_STATE = new WeakMap();
let ACTIVE_DRAG_EVENT_SHIFT = null;

function getFlightDragState(token) {
  token = token?._original ?? token;
  let state = DRAG_STATE.get(token);
  if (state) return state;

  const config = getLevelConfig();
  const rect = getSceneRect();
  const document = token.document;
  const { width, height } = getDocumentPixelSize(document, token, rect);
  const source = document._source ?? document;
  const x = Number(source.x) || 0;
  const y = Number(source.y) || 0;
  const elevation = Number(source.elevation) || 0;
  const grid = screenPointToPerspectiveGrid({ x: x + width / 2, y: y + height, elevation }, config, rect);
  const gridDistance = getSceneGridDistance();
  const pxPerGridDistance = Math.max(1, Math.abs(elevationToScreenOffsetAtRow(gridDistance, grid.j, config, rect)) || rect.gridSize);

  state = { startY: y, startElevation: elevation, pxPerGridDistance, gridDistance };
  DRAG_STATE.set(token, state);
  return state;
}

function computeFlightElevationFromY(state, y) {
  const dy = y - state.startY;
  const delta = -(dy / state.pxPerGridDistance) * state.gridDistance;
  let elevation = state.startElevation + delta;

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
    const result = original.apply(this, args);
    try {
      const config = getLevelConfig();
      const changes = args[1];
      if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config)) return result;
      if (changes?.elevation !== undefined && result) {
        const state = getFlightDragState(this);
        state.startY = Number(result.y);
        state.startElevation = Number(result.elevation);
        return result;
      }
      if (!(ACTIVE_DRAG_EVENT_SHIFT ?? isShiftActive())
        || changes?.y === undefined || changes?.elevation !== undefined
        || !result || !Number.isFinite(Number(result.y))) return result;

      // Foundry applies this waypoint to each clone and saves the whole movement
      // on drop. Mutating an original document or saving again from _onDragEnd
      // races that workflow, especially while a group's previews are destroyed.
      result.elevation = computeFlightElevationFromY(getFlightDragState(this), Number(result.y));
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
