import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import {
  elevationToScreenOffsetAtRow,
  screenPointToPerspectiveGrid
} from "./projection.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import {
  canUpdateTokenDocument,
  getDocumentPixelSize,
  getTokenIdentity,
  getTokenPositionForFlight,
  isShiftActive,
  wrapPrototypeMethod
} from "./foundry-helpers.js";
import { applyOrSchedulePerspectiveUpdate } from "./token-update-queue.js";
import { schedulePerspectiveSort } from "./tokens.js";

const DRAG_STATE = new Map();
let ACTIVE_DRAG_EVENT_SHIFT = false;

function getFlightDragState(token, { event = null, create = false } = {}) {
  const tokenId = getTokenIdentity(token);
  if (!create || DRAG_STATE.has(tokenId)) return DRAG_STATE.get(tokenId);

  const config = getLevelConfig();
  const rect = getSceneRect();
  const document = token?._original?.document ?? token?.document;
  const { width, height } = getDocumentPixelSize(document, token?._original ?? token, rect);
  const pos = getTokenPositionForFlight(token);
  const elevation = Number(document?.elevation ?? token?.document?.elevation ?? token?.elevation ?? 0) || 0;
  const bottom = { x: pos.x + (width / 2), y: pos.y + height, elevation };
  const grid = screenPointToPerspectiveGrid(bottom, config, rect);
  const gridDistance = getSceneGridDistance();
  const pxPerGridDistance = Math.max(1, Math.abs(elevationToScreenOffsetAtRow(gridDistance, grid.j, config, rect)) || rect.gridSize);

  const state = {
    startX: pos.x,
    startY: pos.y,
    startElevation: elevation,
    startWidth: width,
    startHeight: height,
    pxPerGridDistance,
    gridDistance,
    isShiftDrag: isShiftActive(event),
    isDragging: true,
    lastElevation: elevation
  };

  DRAG_STATE.set(tokenId, state);
  return state;
}

function computeFlightElevationFromY(state, y) {
  if (!state) return 0;
  const dy = (Number(y) || 0) - state.startY;
  const delta = -(dy / Math.max(1, state.pxPerGridDistance)) * Math.max(0.0001, state.gridDistance);
  let elevation = state.startElevation + delta;

  if (state.startElevation > 0.0001) elevation = Math.max(0, elevation);
  else if (state.startElevation < -0.0001) elevation = Math.min(0, elevation);
  return Math.round((elevation + Number.EPSILON) * 1000) / 1000;
}

function applyFlightElevationPreview(token, elevation) {
  if (!token?.document) return;

  try { token.document.updateSource?.({ elevation }, { _perspectiveLevelsFlightPreview: true }); }
  catch (_err) {
    try { token.document.elevation = elevation; }
    catch (_innerErr) { /* noop */ }
  }

  try { token.elevation = elevation; }
  catch (_err) { /* noop */ }
}

function deleteFlightState(token) {
  DRAG_STATE.delete(getTokenIdentity(token));
}

function installDragStartPatches(proto) {
  wrapPrototypeMethod(proto, "_onDragLeftStart", function(original, args) {
    getFlightDragState(this, { event: args[0], create: true });
    return original.apply(this, args);
  });

  wrapPrototypeMethod(proto, "_onDragRightStart", function(original, args) {
    getFlightDragState(this, { event: args[0], create: true });
    return original.apply(this, args);
  });
}

function installWaypointPatch(proto) {
  if (typeof proto._getDragWaypointPosition !== "function") return;

  wrapPrototypeMethod(proto, "_getDragWaypointPosition", function(original, args) {
    const result = original.apply(this, args);

    try {
      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || !(ACTIVE_DRAG_EVENT_SHIFT || isShiftActive())) return result;

      const state = getFlightDragState(this, { create: true });
      if (!state) return result;

      const y = Number(result?.y ?? args[1]?.y ?? getTokenPositionForFlight(this).y) || 0;
      const elevation = computeFlightElevationFromY(state, y);
      state.isShiftDrag = true;
      state.lastElevation = elevation;

      if (result && typeof result === "object") result.elevation = elevation;
      applyFlightElevationPreview(this, elevation);
      applyOrSchedulePerspectiveUpdate(this);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to prepare perspective flight waypoint`, err);
    }

    return result;
  });
}

function dragMoveHandler(original, args) {
  const event = args[0];
  const shift = isShiftActive(event);
  let result;

  try {
    const config = getLevelConfig();
    if (globalThis.canvas?.ready && isPerspectiveEnabled(config)) getFlightDragState(this, { event, create: true });
  } catch (_err) { /* noop */ }

  ACTIVE_DRAG_EVENT_SHIFT = shift;
  try { result = original.apply(this, args); }
  finally { ACTIVE_DRAG_EVENT_SHIFT = false; }

  try {
    const config = getLevelConfig();
    if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config)) return result;

    const state = getFlightDragState(this, { event, create: true });
    if (!shift || !state) {
      if (state) state.isShiftDrag = false;
      applyOrSchedulePerspectiveUpdate(this);
      return result;
    }

    state.isShiftDrag = true;
    const pos = getTokenPositionForFlight(this);
    const elevation = computeFlightElevationFromY(state, pos.y);
    state.lastElevation = elevation;
    applyFlightElevationPreview(this, elevation);
    applyOrSchedulePerspectiveUpdate(this);
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to apply perspective flight preview`, err);
  }

  return result;
}

function dragEndHandler(original, args) {
  const state = DRAG_STATE.get(getTokenIdentity(this));
  const result = original.apply(this, args);

  try {
    const originalToken = this?._original ?? this;
    const document = originalToken?.document ?? this.document;

    if (state?.isShiftDrag && document) {
      const elevation = Number.isFinite(Number(state.lastElevation)) ? Number(state.lastElevation) : Number(document.elevation ?? 0) || 0;
      applyFlightElevationPreview(this, elevation);
      if (originalToken !== this) applyFlightElevationPreview(originalToken, elevation);

      if (document.update && canUpdateTokenDocument(document)) {
        document.update({ elevation }, {
          animate: false,
          _perspectiveLevelsFlight: true
        }).catch(err => console.warn(`${MODULE_ID} | Failed to save flight elevation`, err));
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to finalize perspective flight`, err);
  } finally {
    deleteFlightState(this);
    if (state?.isShiftDrag) applyOrSchedulePerspectiveUpdate(this);
    schedulePerspectiveSort({ token: this, debounce: true });
  }

  return result;
}

export function installTokenFlightDragPatches(proto) {
  if (!proto) return false;

  installDragStartPatches(proto);
  installWaypointPatch(proto);

  if (typeof proto._onDragLeftMove === "function") wrapPrototypeMethod(proto, "_onDragLeftMove", dragMoveHandler);
  if (typeof proto._onDragRightMove === "function") wrapPrototypeMethod(proto, "_onDragRightMove", dragMoveHandler);

  for (const method of ["_onDragLeftDrop", "_onDragRightDrop", "_onDragLeftCancel", "_onDragRightCancel", "_onDragEnd", "_onDragLeftUp", "_onDragRightUp"]) {
    wrapPrototypeMethod(proto, method, dragEndHandler);
  }

  return true;
}
