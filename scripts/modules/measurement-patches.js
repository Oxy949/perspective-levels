import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveDistanceEnabled } from "./config.js";
import { applyPerspectiveMeasurement } from "./measurement.js";
import { wrapPrototypeMethod } from "./foundry-helpers.js";

export function installPerspectiveMeasurementPatch() {
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
