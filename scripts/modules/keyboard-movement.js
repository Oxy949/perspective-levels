import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import {
  perspectiveGridToScreen,
  perspectiveGroundPointToElevatedScreen,
  screenPointToPerspectiveGrid
} from "./projection.js";
import { getSceneRect } from "./scene.js";
import {
  getDocumentBottomPoint,
  getDocumentPixelSize,
  getKeyboardIncrementScale,
  wrapPrototypeMethod
} from "./foundry-helpers.js";
import { schedulePerspectiveTokenUpdateBurst } from "./token-update-queue.js";
import { schedulePerspectiveSort } from "./tokens.js";
import { clamp } from "./utils.js";

function perspectiveKeyboardMovePoint(bottom, dx, dy, config, rect) {
  const coords = screenPointToPerspectiveGrid(bottom, config, rect);

  return perspectiveGridToScreen(
    coords.i + dx,
    coords.j + dy,
    config,
    rect
  );
}

function buildPerspectiveKeyboardMoveUpdate(object, dx, dy, config, rect, elevation) {
  const document = object?.document;
  if (!document?.id) return null;

  const { width, height } = getDocumentPixelSize(document, object, rect);
  const bottom = getDocumentBottomPoint(document, object, rect);
  const movedGroundBottom = perspectiveKeyboardMovePoint(bottom, dx, dy, config, rect);
  const movedBottom = perspectiveGroundPointToElevatedScreen({
    x: movedGroundBottom.x,
    y: movedGroundBottom.y,
    elevation: Number.isFinite(elevation) ? elevation : bottom.elevation
  }, config, rect);

  const minX = rect.x;
  const minY = rect.y;
  const maxX = rect.x + rect.width - width;
  const maxY = rect.y + rect.height - height;

  return {
    _id: document.id,
    x: Math.round(clamp(movedBottom.x - (width / 2), minX, maxX)),
    y: Math.round(clamp(movedBottom.y - height, minY, maxY))
  };
}

export function installPerspectiveTokenLayerMovementPatch() {
  const TokenLayerClass = globalThis.foundry?.canvas?.layers?.TokenLayer ?? globalThis.TokenLayer;
  const proto = TokenLayerClass?.prototype;
  if (!proto || proto._perspectiveLevelsMoveManyPatch || typeof proto._prepareKeyboardMovementUpdates !== "function") return false;
  proto._perspectiveLevelsMoveManyPatch = true;

  // Keep the native moveMany workflow: pause checks, argument validation,
  // includeLocked, vertical movement and update errors belong to Foundry.
  wrapPrototypeMethod(proto, "_prepareKeyboardMovementUpdates", function(original, args) {
    const result = original.apply(this, args);
    const [objects, dx, dy] = args;
    try {
      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || (!dx && !dy)) return result;

      const rect = getSceneRect();
      const incrementScale = getKeyboardIncrementScale();
      const byId = new Map(objects.map(object => [object.document.id, object]));
      const [updates, options = {}] = result;
      return [updates.map(update => {
        const object = byId.get(update._id);
        if (!object || object.destroyed) return update;
        const position = buildPerspectiveKeyboardMoveUpdate(object, dx * incrementScale, dy * incrementScale,
          config, rect, update.elevation);
        return position ? { ...update, ...position } : update;
      }), { ...options, animate: true, _perspectiveLevelsKeyboardMove: true }];
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective keyboard movement`, err);
      return result;
    }
  });

  wrapPrototypeMethod(proto, "moveMany", async function(original, args) {
    const objects = await original.apply(this, args);
    if (globalThis.canvas?.ready && isPerspectiveEnabled() && !args[0]?.rotate && objects?.length) {
      for (const object of objects) schedulePerspectiveTokenUpdateBurst(object);
      schedulePerspectiveSort({ tokens: objects, debounce: true });
    }
    return objects;
  });

  console.log(`${MODULE_ID} | Perspective keyboard movement patch installed`);
  return true;
}
