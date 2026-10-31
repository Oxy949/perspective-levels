const FILTER_CLASSES = new WeakMap();

export function createTokenOutlineFilter() {
  const Base = globalThis.foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter;
  if (typeof Base !== "function") return null;
  let Filter = FILTER_CLASSES.get(Base);
  if (!Filter) {
    Filter = class extends Base {
      static _createFragmentShader() {
        const modes = globalThis.CONST?.CANVAS_PERFORMANCE_MODES;
        const mode = globalThis.canvas?.performance?.mode;
        const samples = modes && mode === modes.LOW ? 10 : modes && mode === modes.MED ? 20 : 30;
        // Filter input already contains Foundry's hidden/drag/animation alpha.
        // Keep those premultiplied pixels intact. The contour adds only the
        // neighboring alpha outside the art, without an absolute alpha cutoff.
        return `
          varying vec2 vTextureCoord;
          uniform sampler2D uSampler;
          uniform vec4 filterClamp;
          uniform vec2 thickness;
          uniform vec4 outlineColor;

          void main() {
            vec4 source = texture2D(uSampler, vTextureCoord);
            float outerAlpha = source.a;
            for (int i = 0; i < ${samples}; i++) {
              float angle = float(i) * 6.28318530718 / float(${samples});
              vec2 offset = vec2(cos(angle), sin(angle)) * thickness;
              vec2 uv = clamp(vTextureCoord + offset, filterClamp.xy, filterClamp.zw);
              outerAlpha = max(outerAlpha, texture2D(uSampler, uv).a);
            }
            float contourAlpha = (outerAlpha - source.a) * outlineColor.a;
            gl_FragColor = source + vec4(outlineColor.rgb * contourAlpha, contourAlpha);
          }
        `;
      }
    };
    FILTER_CLASSES.set(Base, Filter);
  }
  const filter = Filter.create({ knockout: false, wave: false });
  filter.animated = false;
  filter.thickness = 3;
  return filter;
}
