export const MODULE_ID = "perspective-levels";
export const FLAG = "perspective";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  grid: true,
  tokenScaling: true,
  distance: true,
  gridColor: "#ffffff",
  gridAlpha: 0.32,
  gridLineWidth: 1,
  gridScale: 1,
  sceneDepthCells: 12,
  tokenScaleMultiplier: 1,
  far: { x: 0.5, y: 0.22, scale: 0.58 },
  near: { x: 0.5, y: 0.84, scale: 1.18 },
  curve: 1.45
});

export const LEGACY_TOKEN_OUTLINE_NAMES = Object.freeze([
  "PerspectiveLevels.TokenOutlineFallback",
  "PerspectiveLevels.TokenAlphaOutline"
]);
