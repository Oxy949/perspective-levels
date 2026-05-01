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
import { schedulePerspectiveUpdate } from "./token-update-queue.js";
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

function buildPerspectiveKeyboardMoveUpdate(object, dx, dy, config, rect) {
  const document = object?.document;
  if (!document?.id) return null;

  const { width, height } = getDocumentPixelSize(document, object, rect);
  const bottom = getDocumentBottomPoint(document, object, rect);
  const movedGroundBottom = perspectiveKeyboardMovePoint(bottom, dx, dy, config, rect);
  const movedBottom = perspectiveGroundPointToElevatedScreen({
    x: movedGroundBottom.x,
    y: movedGroundBottom.y,
    elevation: bottom.elevation
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
  if (!proto || proto._perspectiveLevelsMoveManyPatch || typeof proto.moveMany !== "function") return false;
  proto._perspectiveLevelsMoveManyPatch = true;

  wrapPrototypeMethod(proto, "moveMany", async function(original, args) {
    const [options = {}] = args;
    const dx = Number(options?.dx ?? 0) || 0;
    const dy = Number(options?.dy ?? 0) || 0;

    try {
      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || (dx === 0 && dy === 0) || options?.rotate) {
        return original.apply(this, args);
      }

      const objects = typeof this._getMovableObjects === "function"
        ? this._getMovableObjects(options?.ids, options?.includeLocked)
        : (Array.isArray(options?.ids) && options.ids.length
          ? (this.placeables ?? []).filter(object => options.ids.includes(object?.id ?? object?.document?.id))
          : (this.controlled ?? []));

      if (!objects?.length) return [];
      this.hud?.clear?.();

      const rect = getSceneRect();
      const incrementScale = getKeyboardIncrementScale();
      const updates = [];

      for (const object of objects) {
        if (!object || object.destroyed || object.document?.locked) continue;
        if (typeof object._canDrag === "function" && !object._canDrag(globalThis.game?.user, null)) continue;
        const update = buildPerspectiveKeyboardMoveUpdate(object, dx * incrementScale, dy * incrementScale, config, rect);
        if (update) updates.push(update);
      }

      if (!updates.length) return [];

      const scene = globalThis.canvas?.scene;
      if (scene?.updateEmbeddedDocuments) {
        await scene.updateEmbeddedDocuments("Token", updates, {
          animate: true,
          _perspectiveLevelsKeyboardMove: true
        });
      } else {
        await Promise.all(updates.map(update => {
          const object = objects.find(candidate => candidate?.document?.id === update._id);
          return object?.document?.update?.(update, { animate: true, _perspectiveLevelsKeyboardMove: true });
        }));
      }

      for (const object of objects) schedulePerspectiveUpdate(object);
      schedulePerspectiveSort({ tokens: objects, debounce: true });
      return objects;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective keyboard movement`, err);
      return original.apply(this, args);
    }
  });

  console.log(`${MODULE_ID} | Perspective keyboard movement patch installed`);
  return true;
}
