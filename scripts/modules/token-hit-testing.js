import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { getTokenClass, wrapPrototypeMethod } from "./foundry-helpers.js";

const TOKEN_ALPHA_HIT_THRESHOLD = 0.1;

export function installTokenPixelPerfectShapePatch() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsPixelShapePatch) return false;
  proto._perspectiveLevelsPixelShapePatch = true;

  wrapPrototypeMethod(proto, "getShape", function(original, args) {
    const shape = original.apply(this, args);
    if (!shape || shape._perspectiveLevelsPixelShape || typeof shape.contains !== "function") return shape;

    const originalContains = shape.contains.bind(shape);
    shape._perspectiveLevelsPixelShape = true;
    shape._perspectiveLevelsToken = this;
    shape._perspectiveLevelsMesh = this.mesh;
    shape.contains = function perspectiveLevelsPixelContains(...containsArgs) {
      const insideRectangle = originalContains(...containsArgs);

      try {
        const config = getLevelConfig();
        const mesh = this._perspectiveLevelsToken?.mesh ?? this._perspectiveLevelsMesh;
        const point = globalThis.canvas?.mousePosition;

        if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || !mesh?.containsCanvasPoint || !point) {
          return insideRectangle;
        }

        return Boolean(mesh.containsCanvasPoint(point, TOKEN_ALPHA_HIT_THRESHOLD));
      } catch (_err) {
        return insideRectangle;
      }
    };

    return shape;
  });

  console.log(`${MODULE_ID} | Token pixel-perfect shape patch installed`);
  return true;
}
