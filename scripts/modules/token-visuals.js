import { getRuntimeLevelConfig } from "./config.js";
import { getTokenClass } from "./foundry-helpers.js";
import { getTokenArtBounds } from "./token-hit-testing.js";
import { createTokenOutlineFilter } from "./token-outline.js";
import { clamp } from "./utils.js";

const OUTLINES = new WeakMap();
const NATIVE_POSITION_REFRESH = new WeakSet();
const SUSPENDED_VISUALS = new WeakSet();
const RULER_ALIGNMENTS = new WeakMap();

export function withTokenVisualsSuspended(token, callback) {
  SUSPENDED_VISUALS.add(token);
  try { return callback(); }
  finally { clearTokenOutline(token); SUSPENDED_VISUALS.delete(token); }
}

function canUseTokenVisuals(token, config) {
  return globalThis.canvas?.ready && config.enabled && token && !token.destroyed && !SUSPENDED_VISUALS.has(token)
    && (!token.document?.parent || token.document.parent === globalThis.canvas.scene);
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

function prepareTokenRulerPath(ruler, path) {
  const token = ruler.token, config = getRuntimeLevelConfig();
  if (!canUseTokenVisuals(token, config) || !config.tokenScaling) return;
  const document = token.document;
  const align = clamp(config.tokenArtVerticalAlign ?? 0.5, 0, 1);
  const angle = Number(token.mesh?.rotation) || 0, sin = Math.sin(angle), cos = Math.cos(angle);
  for (const waypoint of path) {
    const level = waypoint.level ?? document.level;
    if (level && globalThis.canvas.level?.id && level !== globalThis.canvas.level.id) continue;
    const size = waypoint.size ?? document.getSize(waypoint);
    const center = document.getCenterPoint(waypoint);
    // Art alignment places this fraction of its height at the same fraction of
    // the logical token height. The art height cancels, so this stays exact for
    // every perspective/emotion scale, mirrored texture and historical size.
    const y = (waypoint.y ?? document.y) + size.height * (1 - align);
    const dy = y - center.y;
    waypoint.center = { ...center, x: center.x - dy * sin, y: center.y + dy * cos };
  }
  // The native ruler measures positions before _preparePath; only its display
  // centers and rays change. Keep movement cost, collisions and snapping native.
  const Ray = globalThis.foundry?.canvas?.geometry?.Ray ?? globalThis.Ray;
  if (Ray) for (const waypoint of path) {
    waypoint.ray = waypoint.previous ? new Ray(waypoint.previous.center, waypoint.center) : null;
  }
}

function adaptTokenRuler(ruler) {
  wrap(ruler, "_preparePath", function(original, args) {
    const result = original.apply(this, args);
    prepareTokenRulerPath(this, args[0]);
    return result;
  });
}

export function refreshTokenRulerAlignment(token, config) {
  if (!token.ruler || typeof token._refreshRuler !== "function") return;
  const align = canUseTokenVisuals(token, config) && config.tokenScaling ? config.tokenArtVerticalAlign : null;
  const rotation = align === null ? 0 : Number(token.mesh?.rotation) || 0;
  const previous = RULER_ALIGNMENTS.get(token);
  if (previous?.ruler === token.ruler && previous.align === align && previous.rotation === rotation) return;
  RULER_ALIGNMENTS.set(token, { ruler: token.ruler, align, rotation });
  token._refreshRuler();
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
  const highlighted = token.layer?.highlightObjects ?? globalThis.canvas?.tokens?.highlightObjects;
  const active = !SUSPENDED_VISUALS.has(token) && config.enabled && config.selectionOutline
    && !token.document?.isSecret && (token.controlled || token.hover || highlighted)
    && !token.destroyed && token.visible !== false && mesh && !mesh.destroyed;
  let state = OUTLINES.get(token);
  if (!active) { clearTokenOutline(token); return; }
  if (state?.mesh !== mesh || state?.border !== token.border) { clearTokenOutline(token); state = null; }
  if (!state) {
    const filter = createTokenOutlineFilter();
    if (!filter) { clearTokenOutline(token); return; }
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
  wrap(proto, "_initializeRuler", function(original, args) {
    const ruler = original.apply(this, args);
    adaptTokenRuler(ruler);
    return ruler;
  });
  // Also cover rulers created by a system or already present when patches load.
  wrap(proto, "_refreshRuler", function(original, args) {
    adaptTokenRuler(this.ruler);
    return original.apply(this, args);
  });
  wrap(proto, "_refreshRotation", function(original, args) {
    const result = original.apply(this, args);
    refreshTokenRulerAlignment(this, getRuntimeLevelConfig());
    return result;
  });
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
