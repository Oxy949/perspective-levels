import { DEFAULT_CONFIG, FLAG, MODULE_ID } from "./constants.js";
import { asBool, clamp, normalizeHexColor } from "./utils.js";

let activeLevelConfigOverride = null;

export function cloneDefaultConfig() {
  if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(DEFAULT_CONFIG);
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeConfig(base, config) {
  if (globalThis.foundry?.utils?.mergeObject) {
    return globalThis.foundry.utils.mergeObject(base, config, { inplace: false, performDeletions: false });
  }

  return {
    ...base,
    ...config,
    far: { ...base.far, ...(config?.far ?? {}) },
    near: { ...base.near, ...(config?.near ?? {}) }
  };
}

function roundNumber(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function normalizeRotationDegrees(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const wrapped = ((n % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

export function normalizeConfig(config = {}) {
  const base = cloneDefaultConfig();
  const merged = mergeConfig(base, config ?? {});

  merged.enabled = asBool(merged.enabled);
  merged.grid = asBool(merged.grid);
  merged.tokenScaling = asBool(merged.tokenScaling);
  merged.distance = asBool(merged.distance);

  delete merged.outline;
  delete merged.outlineColor;
  delete merged.outlineWidth;

  merged.gridColor = normalizeHexColor(merged.gridColor, DEFAULT_CONFIG.gridColor);
  merged.gridAlpha = roundNumber(clamp(merged.gridAlpha, 0, 1), 4);
  merged.gridLineWidth = roundNumber(clamp(merged.gridLineWidth, 0.25, 8), 4);
  merged.gridScale = roundNumber(clamp(merged.gridScale, 0.1, 8), 4);
  merged.sceneDepthCells = Math.round(clamp(merged.sceneDepthCells ?? DEFAULT_CONFIG.sceneDepthCells, 1, 200));
  merged.tokenScaleMultiplier = roundNumber(clamp(merged.tokenScaleMultiplier ?? 1, 0.05, 8), 4);
  const tokenArtVerticalAlign = hasOwn(config, "tokenArtVerticalAlign")
    ? merged.tokenArtVerticalAlign
    : (hasOwn(config, "tokenVerticalAlign") ? config.tokenVerticalAlign : merged.tokenArtVerticalAlign);
  merged.tokenArtVerticalAlign = roundNumber(clamp(tokenArtVerticalAlign ?? DEFAULT_CONFIG.tokenArtVerticalAlign, 0, 1), 4);
  delete merged.tokenVerticalAlign;
  merged.curve = roundNumber(clamp(merged.curve, 0.4, 4), 4);
  merged.far = {
    x: roundNumber(clamp(merged.far?.x, 0, 1), 4),
    y: roundNumber(clamp(merged.far?.y, 0, 1), 4),
    scale: roundNumber(clamp(merged.far?.scale, 0.05, 4), 4),
    rotation: roundNumber(normalizeRotationDegrees(merged.far?.rotation), 4)
  };
  merged.near = {
    x: roundNumber(clamp(merged.near?.x, 0, 1), 4),
    y: roundNumber(clamp(merged.near?.y, 0, 1), 4),
    scale: roundNumber(clamp(merged.near?.scale, 0.05, 4), 4),
    rotation: roundNumber(normalizeRotationDegrees(merged.near?.rotation), 4)
  };

  if (Math.abs(merged.near.y - merged.far.y) < 0.02) {
    merged.near.y = clamp(merged.far.y + 0.35, 0, 1);
  }

  return merged;
}

function getLevelIdentity(level) {
  return level?.uuid
    ?? level?.id
    ?? level?._id
    ?? null;
}

function isSameLevel(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  const aId = getLevelIdentity(a);
  const bId = getLevelIdentity(b);
  return Boolean(aId && bId && String(aId) === String(bId));
}

export function setLevelConfigOverride(level, config) {
  if (!level) return;
  activeLevelConfigOverride = {
    level,
    config: normalizeConfig(config)
  };
}

export function clearLevelConfigOverride(level = null) {
  if (!activeLevelConfigOverride) return;
  if (level && !isSameLevel(level, activeLevelConfigOverride.level)) return;
  activeLevelConfigOverride = null;
}

export function getLevelConfig(level = globalThis.canvas?.level) {
  if (level && activeLevelConfigOverride && isSameLevel(level, activeLevelConfigOverride.level)) {
    return normalizeConfig(activeLevelConfigOverride.config);
  }

  if (!level) return normalizeConfig();
  return normalizeConfig(level.getFlag(MODULE_ID, FLAG) ?? {});
}

export async function setLevelConfig(level, config) {
  if (!level) return;
  await level.setFlag(MODULE_ID, FLAG, normalizeConfig(config));
}

export function isPerspectiveEnabled(config = getLevelConfig()) {
  return Boolean(config.enabled);
}

export function isPerspectiveDistanceEnabled(config = getLevelConfig()) {
  return Boolean(config.enabled && config.distance);
}
