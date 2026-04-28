import { DEFAULT_CONFIG, FLAG, MODULE_ID } from "./constants.js";
import { asBool, clamp } from "./utils.js";

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

  merged.gridColor = String(merged.gridColor || DEFAULT_CONFIG.gridColor);
  merged.gridAlpha = clamp(merged.gridAlpha, 0, 1);
  merged.gridLineWidth = clamp(merged.gridLineWidth, 0.25, 8);
  merged.gridScale = clamp(merged.gridScale, 0.1, 8);
  merged.curve = clamp(merged.curve, 0.4, 4);
  merged.far = {
    x: clamp(merged.far?.x, 0, 1),
    y: clamp(merged.far?.y, 0, 1),
    scale: clamp(merged.far?.scale, 0.05, 4)
  };
  merged.near = {
    x: clamp(merged.near?.x, 0, 1),
    y: clamp(merged.near?.y, 0, 1),
    scale: clamp(merged.near?.scale, 0.05, 4)
  };

  if (Math.abs(merged.near.y - merged.far.y) < 0.02) {
    merged.near.y = clamp(merged.far.y + 0.35, 0, 1);
  }

  return merged;
}

export function getLevelConfig(level = globalThis.canvas?.level) {
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
