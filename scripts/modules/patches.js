import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveDistanceEnabled, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveMeasurement } from "./measurement.js";
import { applyPerspectiveToToken, isTokenObject, restoreTokenBaseScale } from "./tokens.js";

const PENDING_DRAG_TOKENS = new Set();
let PENDING_DRAG_RAF = null;
const CURRENTLY_DRAGGING = new Set();
const SHIFT_KEY_STATE = new Map();
const DRAG_START_POSITIONS = new Map();

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

function flushPerspectiveDragRefresh() {
  const tokens = [...PENDING_DRAG_TOKENS];
  PENDING_DRAG_TOKENS.clear();
  PENDING_DRAG_RAF = null;

  const config = getLevelConfig();
  if (!isPerspectiveEnabled(config)) return;

  for (const token of tokens) {
    for (const candidate of collectTokenAndDragPreviews(token)) {
      try { applyPerspectiveToToken(candidate); }
      catch (err) { console.warn(`${MODULE_ID} | Failed to update token drag preview perspective`, err); }
    }
  }
}

function restoreTokenAndDragPreviewsBaseScale(token) {
  for (const candidate of collectTokenAndDragPreviews(token)) {
    try { restoreTokenBaseScale(candidate); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to restore token drag-preview base scale`, err); }
  }
}

function isDragMethod(methodName) {
  return methodName.includes("Drag") || methodName.includes("drag") || methodName === "_updateDragDestination";
}

function isStartDragMethod(methodName) {
  return methodName === "_onDragLeftStart" || methodName === "_onDragRightStart";
}

function isEndDragMethod(methodName) {
  return methodName === "_onDragLeftDrop" || methodName === "_onDragRightDrop" 
    || methodName === "_onDragLeftCancel" || methodName === "_onDragRightCancel"
    || methodName === "_onDragEnd" || methodName === "_onDragLeftUp" || methodName === "_onDragRightUp";
}

function schedulePerspectiveDragRefresh(token) {
  if (!token) return;
  PENDING_DRAG_TOKENS.add(token);
  if (PENDING_DRAG_RAF) return;

  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  PENDING_DRAG_RAF = raf(flushPerspectiveDragRefresh);
}

function wrapPrototypeMethod(proto, methodName, wrapper) {
  const original = proto?.[methodName];
  if (typeof original !== "function" || original._perspectiveLevelsWrapped) return false;

  const wrapped = function perspectiveLevelsWrappedMethod(...args) {
    return wrapper.call(this, original, args, methodName);
  };
  wrapped._perspectiveLevelsWrapped = true;
  wrapped._perspectiveLevelsOriginal = original;
  proto[methodName] = wrapped;
  return true;
}

function installTokenPreviewScalingPatch() {
  const TokenClass = globalThis.foundry?.canvas?.placeables?.Token
    ?? globalThis.CONFIG?.Token?.objectClass
    ?? globalThis.Token;
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsPreviewPatch) return false;
  proto._perspectiveLevelsPreviewPatch = true;

  const aroundTokenRefresh = function(original, args, methodName) {
    const tokenId = this?.id ?? String(this);
    const isShiftPressed = globalThis.keyboard?.isDown?.("Shift") ?? false;
    
    if (isStartDragMethod(methodName)) {
      CURRENTLY_DRAGGING.add(tokenId);
      SHIFT_KEY_STATE.set(tokenId, isShiftPressed);
      // Store the starting position for Y->Z conversion
      DRAG_START_POSITIONS.set(tokenId, {
        x: this.document?.x ?? this.x ?? 0,
        y: this.document?.y ?? this.y ?? 0,
        elevation: this.document?.elevation ?? this.elevation ?? 0
      });
    } else if (isDragMethod(methodName) && methodName === "_onDragLeftMove" && isShiftPressed && CURRENTLY_DRAGGING.has(tokenId)) {
      // During shift-drag move, we'll handle Y->elevation conversion after position update
      SHIFT_KEY_STATE.set(tokenId, true);
    }

    // Only restore base scale if we're NOT in a drag operation
    // This prevents flickering during drag
    if (!isDragMethod(methodName)) {
      restoreTokenAndDragPreviewsBaseScale(this);
    }

    const result = original.apply(this, args);

    // Handle Shift-based Z-axis dragging after position is updated
    if (SHIFT_KEY_STATE.get(tokenId) && isDragMethod(methodName) && CURRENTLY_DRAGGING.has(tokenId)) {
      const startPos = DRAG_START_POSITIONS.get(tokenId);
      const currentY = this.document?.y ?? this.y ?? 0;
      const currentX = this.document?.x ?? this.x ?? 0;
      
      if (startPos && currentY !== startPos.y) {
        const yDelta = currentY - startPos.y;
        const elevationDelta = yDelta * 0.5; // Adjust this multiplier to change sensitivity
        const newElevation = Math.max(0, startPos.elevation + elevationDelta);
        
        // Update the elevation if it changed
        if (Math.abs(newElevation - (this.document?.elevation ?? this.elevation ?? 0)) > 0.01) {
          try {
            // Use update directly to change elevation while keeping X/Y at start position
            if (this.document?.update) {
              this.document.update({ 
                elevation: newElevation,
                x: startPos.x,
                y: startPos.y
              }, { animate: false });
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Failed to update token elevation during shift-drag`, err);
          }
        }
      }
    }

    if (result && typeof result.then === "function") {
      return result.finally(() => {
        if (isEndDragMethod(methodName)) {
          CURRENTLY_DRAGGING.delete(tokenId);
          SHIFT_KEY_STATE.delete(tokenId);
          DRAG_START_POSITIONS.delete(tokenId);
        }
        schedulePerspectiveDragRefresh(this);
      });
    }

    if (isEndDragMethod(methodName)) {
      CURRENTLY_DRAGGING.delete(tokenId);
      SHIFT_KEY_STATE.delete(tokenId);
      DRAG_START_POSITIONS.delete(tokenId);
    }

    schedulePerspectiveDragRefresh(this);
    return result;
  };

  for (const method of [
    "_onDragLeftStart",
    "_onDragLeftMove",
    "_onDragLeftDrop",
    "_onDragLeftCancel",
    "_onDragRightStart",
    "_onDragRightMove",
    "_onDragRightDrop",
    "_onDragRightCancel",
    "_onDragEnd",
    "_onDragLeftUp",
    "_onDragRightUp",
    "_updateDragDestination",
    "_refreshPosition",
    "_refreshMesh",
    "_refreshMeshSizeAndScale"
  ]) {
    wrapPrototypeMethod(proto, method, aroundTokenRefresh);
  }

  // Wrap document update to handle Shift-based elevation changes
  if (typeof proto._onUpdateTokenDocument === "function" && !proto._onUpdateTokenDocument._perspectiveLevelsWrapped) {
    wrapPrototypeMethod(proto, "_onUpdateTokenDocument", function(original, args) {
      const [changed, options = {}] = args;
      const tokenId = this?.id ?? String(this);
      const useZAxis = SHIFT_KEY_STATE.get(tokenId);

      // If Shift is being held during drag and Y is being changed, convert it to elevation
      if (useZAxis && CURRENTLY_DRAGGING.has(tokenId) && changed?.y !== undefined && changed?.x === undefined) {
        const yDelta = changed.y - (this.document?.y ?? this.y ?? 0);
        const elevationDelta = -yDelta * 0.1; // Convert Y pixels to elevation units (adjust multiplier as needed)
        
        changed = { ...changed, y: this.document?.y ?? this.y ?? 0 };
        const currentElevation = Number(this.document?.elevation ?? this.elevation ?? 0) || 0;
        changed.elevation = Math.max(0, currentElevation + elevationDelta);
      }

      return original.call(this, changed, options);
    });
  }

  if (typeof proto.measureMovementPath === "function" && !proto.measureMovementPath._perspectiveLevelsWrapped) {
    wrapPrototypeMethod(proto, "measureMovementPath", function(original, args) {
      const result = original.apply(this, args);
      try {
        const config = getLevelConfig();
        if (isPerspectiveDistanceEnabled(config) && !result?._perspectiveLevels) {
          return applyPerspectiveMeasurement(result, args[0], config);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to apply perspective token movement measurement`, err);
      }
      return result;
    });
  }

  console.log(`${MODULE_ID} | Token drag-preview scaling patch installed`);
  return true;
}

function installPerspectiveMeasurementPatch() {
  const proto = globalThis.foundry?.grid?.BaseGrid?.prototype;
  if (!proto || proto._perspectiveLevelsMeasurementPatch) return false;
  proto._perspectiveLevelsMeasurementPatch = true;

  wrapPrototypeMethod(proto, "measurePath", function(original, args) {
    const result = original.apply(this, args);
    try {
      const [waypoints, options = {}] = args;
      if (options?._perspectiveLevelsBypass || result?._perspectiveLevels) return result;

      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveDistanceEnabled(config)) return result;
      return applyPerspectiveMeasurement(result, waypoints, config);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective grid measurement`, err);
      return result;
    }
  });

  console.log(`${MODULE_ID} | Perspective distance measurement patch installed`);
  return true;
}

export function installRuntimePatches() {
  installTokenPreviewScalingPatch();
  installPerspectiveMeasurementPatch();
}
