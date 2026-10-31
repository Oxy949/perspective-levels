import { getRuntimeLevelConfig } from "./config.js";
import { getTokenClass } from "./foundry-helpers.js";
import { getTokenArtBounds } from "./token-hit-testing.js";

const OUTLINES = new WeakMap();
const NATIVE_POSITION_REFRESH = new WeakSet();
const SUSPENDED_VISUALS = new WeakSet();

export function withTokenVisualsSuspended(token, callback) {
  SUSPENDED_VISUALS.add(token);
  try { return callback(); }
  finally { clearTokenOutline(token); SUSPENDED_VISUALS.delete(token); }
}

export function getTokenVisualCenter(token) {
  if (!globalThis.canvas?.ready || !getRuntimeLevelConfig().enabled || !token || token.destroyed || SUSPENDED_VISUALS.has(token)) return null;
  if (token.document?.parent && token.document.parent !== globalThis.canvas.scene) return null;
  const bounds = getTokenArtBounds(token);
  if (!bounds) return null;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const angle = Number(token.mesh?.rotation) || 0;
  if (!angle) return center;
  const pivot = token.mesh.position, dx = center.x - pivot.x, dy = center.y - pivot.y;
  return { x: pivot.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: pivot.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

export function clearTokenOutline(token) {
  const state = OUTLINES.get(token);
  if (!state) return;
  if (state.mesh?.filters?.includes(state.filter)) state.mesh.filters = state.mesh.filters.filter(filter => filter !== state.filter);
  state.filter.destroy?.();
  if (state.border && !state.border.destroyed) state.border.renderable = state.borderRenderable;
  OUTLINES.delete(token);
}

export function updateTokenOutline(token, config = getRuntimeLevelConfig()) {
  const mesh = token?.mesh;
  const Filter = globalThis.foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter;
  const highlighted = token.layer?.highlightObjects ?? globalThis.canvas?.tokens?.highlightObjects;
  const active = !SUSPENDED_VISUALS.has(token) && config.enabled && config.selectionOutline
    && !token.document?.isSecret && (token.controlled || token.hover || highlighted)
    && !token.destroyed && token.visible !== false && mesh && !mesh.destroyed;
  let state = OUTLINES.get(token);
  if (!active || !Filter) { clearTokenOutline(token); return; }
  if (state?.mesh !== mesh || state?.border !== token.border) { clearTokenOutline(token); state = null; }
  if (!state) {
    const filter = Filter.create({ knockout: false, wave: false });
    filter.animated = false;
    filter.thickness = 3;
    state = { mesh, filter, border: token.border, borderRenderable: token.border?.renderable ?? true };
    OUTLINES.set(token, state);
  }
  const color = Number(token.getDispositionColor?.() ?? globalThis.CONFIG?.Canvas?.dispositionColors?.NEUTRAL ?? 0xffffff);
  if (state.color !== color) {
    state.filter.uniforms.outlineColor = [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255, 1];
    state.color = color;
  }
  if (!mesh.filters?.includes(state.filter)) mesh.filters = [...(mesh.filters ?? []), state.filter];
  if (token.border) token.border.renderable = false;
}

function wrap(object, key, wrapper) {
  const original = object?.[key];
  if (typeof original !== "function" || original._perspectiveLevelsVisualWrapped) return;
  const wrapped = function(...args) { return wrapper.call(this, original, args); };
  wrapped._perspectiveLevelsVisualWrapped = true;
  object[key] = wrapped;
}

function withMappedGraphics(graphics, method, map, callback) {
  const original = graphics?.[method];
  if (typeof original !== "function") return callback();
  const own = Object.hasOwn(graphics, method);
  graphics[method] = function(...args) { return original.apply(this, map(args)); };
  try { return callback(); }
  finally { if (own) graphics[method] = original; else delete graphics[method]; }
}

export function installTokenVisualPatches() {
  const proto = getTokenClass()?.prototype;
  if (!proto || Object.hasOwn(proto, "_perspectiveLevelsVisualPatch")) return;
  proto._perspectiveLevelsVisualPatch = true;
  let owner = proto;
  while (owner && !Object.getOwnPropertyDescriptor(owner, "center")) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, "center");
  if (descriptor?.get) {
    Object.defineProperty(proto, "center", {
      configurable: true,
      get() {
        const point = !NATIVE_POSITION_REFRESH.has(this) && getTokenVisualCenter(this);
        return point ? new PIXI.Point(point.x, point.y) : descriptor.get.call(this);
      }
    });
  }
  // Native position refresh places the mesh at the logical cell center. Let it
  // do that before perspective adjusts the art, avoiding feedback/drift.
  wrap(proto, "_refreshPosition", function(original, args) {
    NATIVE_POSITION_REFRESH.add(this);
    try { return original.apply(this, args); }
    finally { NATIVE_POSITION_REFRESH.delete(this); }
  });
  wrap(proto, "getCenterPoint", function(original, args) {
    return (!args[0] && getTokenVisualCenter(this)) || original.apply(this, args);
  });
  wrap(proto, "_refreshBorder", function(original, args) {
    const result = original.apply(this, args);
    updateTokenOutline(this);
    return result;
  });
  wrap(proto, "_drawTargetArrows", function(original, args) {
    if (!getTokenVisualCenter(this)) return original.apply(this, args);
    const bounds = getTokenArtBounds(this), x = bounds.x - this.position.x, y = bounds.y - this.position.y;
    return withMappedGraphics(this.targetArrows, "drawPolygon", polygonArgs => {
      if (!Array.isArray(polygonArgs[0]) || typeof polygonArgs[0][0] !== "number") return polygonArgs;
      const points = polygonArgs[0].map((value, i) => i % 2
        ? (value >= this.h / 2 ? y + bounds.height + value - this.h : y + value)
        : (value >= this.w / 2 ? x + bounds.width + value - this.w : x + value));
      return [points, ...polygonArgs.slice(1)];
    }, () => original.apply(this, args));
  });
  wrap(proto, "_drawTargetPips", function(original, args) {
    if (!getTokenVisualCenter(this)) return original.apply(this, args);
    const bounds = getTokenArtBounds(this), dx = bounds.x - this.position.x + bounds.width / 2 - this.w / 2;
    const dy = bounds.y - this.position.y;
    return withMappedGraphics(this.targetPips, "drawCircle", ([x, y, ...rest]) => [x + dx, y + dy, ...rest],
      () => original.apply(this, args));
  });
}

function effectToken(effect, side) {
  const value = effect?.[side] ?? effect?.[`${side}Document`];
  const token = value?.object ?? value;
  if (token?.document?.documentName !== "Token" || !getTokenVisualCenter(token)) return null;
  return token;
}

function effectScale(effect) {
  if (effect.data?.screenSpace || effect.data?.screenSpaceAboveUI) return 1;
  const token = effectToken(effect, "source") ?? effectToken(effect, "target");
  const scale = Number(token?.mesh?._perspectiveLevelsAppliedScale);
  return Number.isFinite(scale) && scale >= 0 ? scale : 1;
}

// Installed on each effect before Sequencer initializes it. No files or global
// coordinates in AutoAnimations/Sequencer are changed; offsets stay native.
export function adaptSequencerEffect(effect) {
  for (const side of ["source", "target"]) {
    wrap(effect, side === "source" ? "getSourceData" : "getTargetData", function(original, args) {
      const data = original.apply(this, args);
      if (this.data?.screenSpace || this.data?.screenSpaceAboveUI) return data;
      const token = effectToken(this, side);
      if (!token || !data) return data;
      const bounds = getTokenArtBounds(token);
      const considerScale = side === "source" && this.data?.scaleToObject?.considerTokenScale;
      // A portrait's tall bounding rectangle must not become the aspect ratio
      // of a sword, burst or aura. Use one extent for object-fit sizing.
      const extent = Math.max(bounds.width, bounds.height);
      const objectFit = side === "source" && this.data?.scaleToObject;
      return { ...data, position: { ...data.position, ...getTokenVisualCenter(token) },
        width: (objectFit ? extent : bounds.width) / (considerScale ? Math.abs(Number(token.document.texture?.scaleX) || 1) : 1),
        height: (objectFit ? extent : bounds.height) / (considerScale ? Math.abs(Number(token.document.texture?.scaleY) || 1) : 1) };
    });
  }
  wrap(effect, "_getBaseScale", function(original, args) {
    const result = original.apply(this, args);
    const scale = this.data?.scaleToObject ? 1 : effectScale(this);
    return { ...result, baseScaleX: result.baseScaleX * scale, baseScaleY: result.baseScaleY * scale };
  });
  wrap(effect, "_getDistanceScaling", function(original, args) {
    const adjust = result => {
      if (this.data?.screenSpace || this.data?.screenSpaceAboveUI || !this.data?.stretchTo?.onlyX) return result;
      if (!(effectToken(this, "source") ?? effectToken(this, "target"))) return result;
      // Keep the native endpoint distance. A width-only stretch must not turn
      // a perspective-scaled projectile into a flattened or elongated sprite.
      return { ...result, scaleY: result.scaleX };
    };
    const result = original.apply(this, args);
    return result?.then ? result.then(adjust) : adjust(result);
  });
  // Native distance scaling already supplies the uniform scale for ranged
  // sprites. No additional perspective multiplier is applied to either axis.
}
