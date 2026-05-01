import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveDistanceEnabled, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveMeasurement } from "./measurement.js";
import { getTokenClass, wrapPrototypeMethod } from "./foundry-helpers.js";
import { applyOrSchedulePerspectiveUpdate, schedulePerspectiveUpdate } from "./token-update-queue.js";
import { installTokenFlightDragPatches } from "./token-flight.js";

export function installTokenPerspectiveLifecyclePatches() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsPreviewPatch) return false;
  proto._perspectiveLevelsPreviewPatch = true;

  const initHandler = function(original, args) {
    const result = original.apply(this, args);
    try {
      const config = getLevelConfig();
      if (isPerspectiveEnabled(config)) schedulePerspectiveUpdate(this);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to initialize token perspective`, err);
    }
    return result;
  };

  wrapPrototypeMethod(proto, "draw", initHandler);

  const genericUpdateHandler = function(original, args) {
    const result = original.apply(this, args);
    applyOrSchedulePerspectiveUpdate(this);
    return result;
  };

  installTokenFlightDragPatches(proto);

  for (const method of ["_refreshPosition", "_refreshMesh", "_refreshMeshSizeAndScale", "_updateDragDestination", "_onHoverIn", "_onHoverOut", "control", "release", "setTarget"]) {
    wrapPrototypeMethod(proto, method, genericUpdateHandler);
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

  console.log(`${MODULE_ID} | Token preview scaling patch installed`);
  return true;
}
