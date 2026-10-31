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
  const active = !SUSPENDED_VISUALS.has(token) && config.enabled && config.selectionOutline && (token.controlled || token.hover)
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
      return { ...data, position: { ...data.position, ...getTokenVisualCenter(token) },
        width: bounds.width / (considerScale ? Math.abs(Number(token.document.texture?.scaleX) || 1) : 1),
        height: bounds.height / (considerScale ? Math.abs(Number(token.document.texture?.scaleY) || 1) : 1) };
    });
  }
  wrap(effect, "_getBaseScale", function(original, args) {
    const result = original.apply(this, args);
    const scale = this.data?.scaleToObject ? 1 : effectScale(this);
    return { ...result, baseScaleX: result.baseScaleX * scale, baseScaleY: result.baseScaleY * scale };
  });
  wrap(effect, "_getDistanceScaling", function(original, args) {
    const scale = effectScale(this);
    const adjust = result => ({ ...result, scaleY: result.scaleY * scale });
    const result = original.apply(this, args);
    return result?.then ? result.then(adjust) : adjust(result);
  });
}
