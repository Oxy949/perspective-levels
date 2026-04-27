/*
 * Perspective Levels for Foundry VTT v14
 *
 * Stores perspective settings on the viewed Scene Level via flags:
 * flags.perspective-levels.perspective
 *
 * This module intentionally keeps Foundry's movement/collision math untouched.
 * It changes the visual grid and token scale/distance for a specific Level.
 */

const MODULE_ID = "perspective-levels";
const FLAG = "perspective";

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  grid: true,
  tokenScaling: true,
  distance: true,
  gridColor: "#ffffff",
  gridAlpha: 0.32,
  gridLineWidth: 1,
  gridScale: 1,
  far: { x: 0.5, y: 0.22, scale: 0.58 },
  near: { x: 0.5, y: 0.84, scale: 1.18 },
  curve: 1.45
});

const ORIGINAL_TOKEN_STATE = new WeakMap();
function i18n(key) {
  return game.i18n?.localize?.(key) ?? key;
}

function cloneDefaultConfig() {
  return foundry.utils.deepClone(DEFAULT_CONFIG);
}

function clamp(value, min, max) {
  value = Number(value);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function asBool(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return Boolean(value);
}

function normalizeConfig(config = {}) {
  const base = cloneDefaultConfig();
  const merged = foundry.utils.mergeObject(base, config, { inplace: false, performDeletions: false });
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
  if (Math.abs(merged.near.y - merged.far.y) < 0.02) merged.near.y = clamp(merged.far.y + 0.35, 0, 1);
  return merged;
}

function getLevelConfig(level = canvas?.level) {
  if (!level) return normalizeConfig();
  return normalizeConfig(level.getFlag(MODULE_ID, FLAG) ?? {});
}

async function setLevelConfig(level, config) {
  if (!level) return;
  await level.setFlag(MODULE_ID, FLAG, normalizeConfig(config));
}

function getSceneRect() {
  const dims = canvas.dimensions ?? {};
  const scene = canvas.scene ?? {};
  const gridSize = Number(dims.size ?? canvas.grid?.size ?? scene.grid?.size ?? 100) || 100;
  const width = Number(dims.sceneWidth ?? dims.width ?? scene.width ?? canvas.app?.renderer?.screen?.width ?? 4000) || 4000;
  const height = Number(dims.sceneHeight ?? dims.height ?? scene.height ?? canvas.app?.renderer?.screen?.height ?? 3000) || 3000;
  const x = Number(dims.sceneX ?? dims.x ?? 0) || 0;
  const y = Number(dims.sceneY ?? dims.y ?? 0) || 0;
  return { x, y, width, height, gridSize };
}

function anchorToPoint(anchor, rect = getSceneRect()) {
  return {
    x: rect.x + anchor.x * rect.width,
    y: rect.y + anchor.y * rect.height
  };
}

function pointToAnchor(point, rect = getSceneRect()) {
  return {
    x: clamp((point.x - rect.x) / rect.width, 0, 1),
    y: clamp((point.y - rect.y) / rect.height, 0, 1)
  };
}

function scaleForY(y, config = getLevelConfig(), rect = getSceneRect()) {
  const farY = rect.y + config.far.y * rect.height;
  const nearY = rect.y + config.near.y * rect.height;
  const span = nearY - farY;
  if (Math.abs(span) < 1) return config.near.scale;

  // Token scale is deliberately linear and stateless. The perspective grid may
  // still use curve for its visual spacing, but token size should be a stable
  // interpolation between the two calibration anchors.
  const t = clamp((y - farY) / span, 0, 1);
  return config.far.scale + (config.near.scale - config.far.scale) * t;
}

function isPerspectiveEnabled(config = getLevelConfig()) {
  return Boolean(config.enabled);
}

function isPerspectiveDistanceEnabled(config = getLevelConfig()) {
  return Boolean(config.enabled && config.distance);
}

function getSceneGridDistance() {
  const candidates = [
    canvas?.scene?.grid?.distance,
    canvas?.dimensions?.distance,
    canvas?.grid?.distance,
    canvas?.scene?.gridDistance
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

function getElevation(point) {
  const candidates = [point?.elevation, point?.z, point?.k];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function getPointXY(point) {
  return {
    x: Number(point?.x ?? 0) || 0,
    y: Number(point?.y ?? 0) || 0,
    elevation: getElevation(point)
  };
}

/**
 * The visual perspective grid is modelled in its own cell coordinate space.
 * One cell in that coordinate space always equals one Foundry grid distance
 * unit: 5 ft in a typical D&D scene, or whatever the scene grid uses.
 *
 * gridScale changes how large those perspective cells are drawn on the near
 * edge of the map. It does not change how much a cell is worth in game units.
 */
function getPerspectiveCellSize(config = getLevelConfig(), rect = getSceneRect()) {
  return Math.max(4, rect.gridSize * clamp(config.gridScale ?? 1, 0.1, 8));
}

function getPerspectiveGridModel(config = getLevelConfig(), rect = getSceneRect()) {
  const cellSize = getPerspectiveCellSize(config, rect);
  const far = anchorToPoint(config.far, rect);
  const near = anchorToPoint(config.near, rect);
  const span = near.y - far.y;
  const safeSpan = Math.abs(span) < 1 ? (span < 0 ? -1 : 1) : span;
  const rows = Math.max(1, Math.ceil(Math.abs(safeSpan) / cellSize));

  // The near edge is intentionally wider than the scene so tokens can be
  // measured near the scene borders without falling outside the perspective
  // grid. The nearest horizontal cell width equals cellSize.
  const minimumColumns = 4;
  const columns = Math.max(minimumColumns, Math.ceil((rect.width * 1.1) / cellSize));
  const bottomWidth = columns * cellSize;
  const vanishX = far.x;
  const nearCenterX = near.x;
  const startX = nearCenterX - bottomWidth / 2;

  return {
    rect,
    cellSize,
    rows,
    columns,
    topY: far.y,
    bottomY: far.y + safeSpan,
    span: safeSpan,
    vanishX,
    nearCenterX,
    startX,
    endX: startX + bottomWidth,
    curve: Math.max(0.01, config.curve)
  };
}

function perspectiveGridToScreen(column, row, config = getLevelConfig(), rect = getSceneRect()) {
  const model = getPerspectiveGridModel(config, rect);
  const rawT = model.rows > 0 ? row / model.rows : 0;
  const yT = Math.pow(Math.max(0, rawT), model.curve);
  const bottomX = model.startX + column * model.cellSize;
  return {
    x: model.vanishX + (bottomX - model.vanishX) * rawT,
    y: model.topY + model.span * yT
  };
}

function screenPointToPerspectiveGrid(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = getPointXY(point);
  const model = getPerspectiveGridModel(config, rect);

  let normalizedY = (p.y - model.topY) / model.span;
  if (!Number.isFinite(normalizedY)) normalizedY = 0;

  // Above the far anchor all rays collapse to the vanishing point, so clamp the
  // lower bound to a tiny positive value. Below the near anchor we keep growing
  // the grid coordinate so measuring below the anchor still behaves naturally.
  const yT = Math.max(0.0001, normalizedY);
  const rawT = Math.pow(yT, 1 / model.curve);
  const safeT = Math.max(0.0001, rawT);
  const projectedBottomX = model.vanishX + ((p.x - model.vanishX) / safeT);

  return {
    i: (projectedBottomX - model.startX) / model.cellSize,
    j: rawT * model.rows,
    elevation: p.elevation
  };
}

/**
 * Backwards-compatible helper exported for debugging. It now returns a flat
 * coordinate where one perspective cell maps to one Foundry grid pixel size,
 * making it easy to inspect the inverse projection in devtools.
 */
function screenPointToPerspectiveGround(point, config = getLevelConfig(), rect = getSceneRect()) {
  const coords = screenPointToPerspectiveGrid(point, config, rect);
  return {
    x: coords.i * rect.gridSize,
    y: coords.j * rect.gridSize,
    elevation: coords.elevation
  };
}

function getSquareDiagonalMode() {
  let worldDefault;
  try { worldDefault = game?.settings?.get?.("core", "gridDiagonals"); }
  catch (_err) { worldDefault = undefined; }

  const candidates = [
    canvas?.scene?.grid?.diagonals,
    canvas?.grid?.diagonals,
    worldDefault
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return CONST?.GRID_DIAGONALS?.EQUIDISTANT ?? 0;
}

function alternatingDiagonalSpaces(diagonals, firstCost) {
  const whole = Math.floor(Math.max(0, diagonals));
  const fraction = Math.max(0, diagonals - whole);
  let cost = 0;
  for (let i = 0; i < whole; i++) cost += (i % 2 === 0) ? firstCost : (3 - firstCost);
  if (fraction > 0) cost += fraction * ((whole % 2 === 0) ? firstCost : (3 - firstCost));
  return cost;
}

function squareGridDistanceSpaces(dx, dy) {
  const absX = Math.abs(Number(dx) || 0);
  const absY = Math.abs(Number(dy) || 0);
  const diagonals = Math.min(absX, absY);
  const straight = Math.max(absX, absY) - diagonals;
  const mode = getSquareDiagonalMode();
  const DIAG = CONST?.GRID_DIAGONALS ?? {};

  switch (mode) {
    case DIAG.EXACT:
      return Math.hypot(absX, absY);
    case DIAG.APPROXIMATE:
      return straight + (diagonals * 1.5);
    case DIAG.RECTILINEAR:
    case DIAG.ILLEGAL:
      return absX + absY;
    case DIAG.ALTERNATING_1:
      return straight + alternatingDiagonalSpaces(diagonals, 1);
    case DIAG.ALTERNATING_2:
      return straight + alternatingDiagonalSpaces(diagonals, 2);
    case DIAG.EQUIDISTANT:
    default:
      return straight + diagonals; // max(dx, dy)
  }
}

function perspectiveDistanceBetween(a, b, config = getLevelConfig(), rect = getSceneRect()) {
  const pa = screenPointToPerspectiveGrid(a, config, rect);
  const pb = screenPointToPerspectiveGrid(b, config, rect);
  const gridDistance = getSceneGridDistance();

  const dxCells = pb.i - pa.i;
  const dyCells = pb.j - pa.j;
  const horizontalSpaces = squareGridDistanceSpaces(dxCells, dyCells);
  const euclideanSpaces = Math.hypot(dxCells, dyCells);
  const horizontalDistance = horizontalSpaces * gridDistance;
  const euclideanDistance = euclideanSpaces * gridDistance;

  const dz = Number(pb.elevation - pa.elevation) || 0;
  const hasElevation = Math.abs(dz) > 0.0001;
  const distance = hasElevation ? Math.hypot(horizontalDistance, dz) : horizontalDistance;
  const euclidean = hasElevation ? Math.hypot(euclideanDistance, dz) : euclideanDistance;

  return {
    distance,
    euclidean,
    cost: distance,
    spaces: horizontalSpaces,
    diagonals: Math.min(Math.abs(dxCells), Math.abs(dyCells))
  };
}

function buildPerspectiveMeasurement(waypoints, config = getLevelConfig(), rect = getSceneRect()) {
  const points = Array.from(waypoints ?? [], getPointXY);
  const measuredWaypoints = points.map(() => ({
    distance: 0,
    euclidean: 0,
    cost: 0,
    spaces: 0,
    diagonals: 0,
    backward: null,
    forward: null
  }));
  const segments = [];
  let totalDistance = 0;
  let totalEuclidean = 0;
  let totalCost = 0;
  let totalSpaces = 0;
  let totalDiagonals = 0;

  for (let i = 1; i < points.length; i++) {
    const measurement = perspectiveDistanceBetween(points[i - 1], points[i], config, rect);
    totalDistance += measurement.distance;
    totalEuclidean += measurement.euclidean;
    totalCost += measurement.cost;
    totalSpaces += measurement.spaces;
    totalDiagonals += measurement.diagonals;

    const segment = {
      distance: measurement.distance,
      euclidean: measurement.euclidean,
      cost: measurement.cost,
      spaces: measurement.spaces,
      diagonals: measurement.diagonals,
      from: measuredWaypoints[i - 1],
      to: measuredWaypoints[i]
    };
    segments.push(segment);

    measuredWaypoints[i - 1].forward = segment;
    measuredWaypoints[i].backward = segment;
    measuredWaypoints[i].distance = totalDistance;
    measuredWaypoints[i].euclidean = totalEuclidean;
    measuredWaypoints[i].cost = totalCost;
    measuredWaypoints[i].spaces = totalSpaces;
    measuredWaypoints[i].diagonals = totalDiagonals;
  }

  return {
    distance: totalDistance,
    euclidean: totalEuclidean,
    cost: totalCost,
    spaces: totalSpaces,
    diagonals: totalDiagonals,
    segments,
    waypoints: measuredWaypoints
  };
}

function mergePerspectiveMeasurement(baseResult, perspectiveResult) {
  if (!baseResult || !perspectiveResult) return perspectiveResult ?? baseResult;

  const baseSegments = Array.isArray(baseResult.segments) ? baseResult.segments : [];
  const perspectiveSegments = Array.isArray(perspectiveResult.segments) ? perspectiveResult.segments : [];
  const baseWaypoints = Array.isArray(baseResult.waypoints) ? baseResult.waypoints : [];

  for (let i = 0; i < Math.min(baseSegments.length, perspectiveSegments.length); i++) {
    const base = baseSegments[i];
    const perspective = perspectiveSegments[i];
    const originalDistance = Number(base.distance) || 0;
    const originalCost = Number(base.cost);
    const terrainRatio = originalDistance > 0 && Number.isFinite(originalCost) ? originalCost / originalDistance : 1;

    base.distance = perspective.distance;
    base.euclidean = perspective.euclidean;
    base.spaces = perspective.spaces;
    base.diagonals = perspective.diagonals;
    base.cost = Number.isFinite(originalCost) ? perspective.cost * terrainRatio : originalCost;
  }

  let totalDistance = 0;
  let totalEuclidean = 0;
  let totalSpaces = 0;
  let totalDiagonals = 0;
  let totalCost = 0;
  for (let i = 0; i < baseSegments.length; i++) {
    const segment = baseSegments[i];
    totalDistance += Number(segment.distance) || 0;
    totalEuclidean += Number(segment.euclidean) || 0;
    totalSpaces += Number(segment.spaces) || 0;
    totalDiagonals += Number(segment.diagonals) || 0;
    totalCost = Number.isFinite(totalCost) && Number.isFinite(Number(segment.cost))
      ? totalCost + Number(segment.cost)
      : Infinity;

    const to = segment.to ?? baseWaypoints[i + 1];
    if (to) {
      to.distance = totalDistance;
      to.euclidean = totalEuclidean;
      to.spaces = totalSpaces;
      to.diagonals = totalDiagonals;
      to.cost = totalCost;
      to.backward = segment;
    }
    const from = segment.from ?? baseWaypoints[i];
    if (from) from.forward = segment;
  }

  if (!baseSegments.length && perspectiveSegments.length) return perspectiveResult;

  const first = baseWaypoints[0];
  if (first) {
    first.distance = 0;
    first.euclidean = 0;
    first.cost = 0;
    first.spaces = 0;
    first.diagonals = 0;
    first.backward = null;
  }

  baseResult.distance = totalDistance;
  baseResult.euclidean = totalEuclidean;
  baseResult.spaces = totalSpaces;
  baseResult.diagonals = totalDiagonals;
  baseResult.cost = totalCost;
  baseResult._perspectiveLevels = true;
  return baseResult;
}

function applyPerspectiveMeasurement(baseResult, waypoints, config = getLevelConfig(), rect = getSceneRect()) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) return baseResult;
  const perspectiveResult = buildPerspectiveMeasurement(waypoints, config, rect);
  return mergePerspectiveMeasurement(baseResult, perspectiveResult);
}

function isTokenObject(object) {
  return object?.document?.documentName === "Token" || object?.constructor?.name === "Token";
}

function forEachToken(callback) {
  const placeables = canvas?.tokens?.placeables ?? [];
  for (const token of placeables) callback(token);
}

function getTokenSignature(token) {
  const texture = token.document?.texture ?? {};
  return [
    texture.src ?? "",
    token.document?.width ?? "",
    token.document?.height ?? "",
    texture.scaleX ?? "",
    texture.scaleY ?? "",
    texture.offsetX ?? "",
    texture.offsetY ?? "",
    texture.rotation ?? "",
    texture.tint ?? ""
  ].join("|");
}

function cleanupLegacyRectangleOutline(token) {
  const names = new Set([
    "PerspectiveLevels.TokenOutlineFallback",
    "PerspectiveLevels.TokenAlphaOutline"
  ]);

  for (const child of [...(token.children ?? [])]) {
    if (names.has(child?.name) && !child.destroyed) child.destroy({ children: true });
  }

  const meshParent = token.mesh?.parent;
  if (meshParent && meshParent !== token) {
    for (const child of [...(meshParent.children ?? [])]) {
      if (names.has(child?.name) && !child.destroyed) child.destroy({ children: true });
    }
  }
}

function removePerspectiveOutlineFilters(mesh) {
  if (!mesh || !Array.isArray(mesh.filters)) return;
  const kept = mesh.filters.filter(f => !f?._perspectiveLevelsOutline);
  mesh.filters = kept.length ? kept : null;
}

function cleanupTokenOutline(token, state = ORIGINAL_TOKEN_STATE.get(token)) {
  removePerspectiveOutlineFilters(token.mesh);
  if (state?.outlineContainer && !state.outlineContainer.destroyed) state.outlineContainer.destroy({ children: true });
  if (state) {
    state.outlineContainer = null;
    state.outlineSprites = [];
    state.outlineParent = null;
  }
  cleanupLegacyRectangleOutline(token);
}

function removePerspectiveFromToken(token) {
  const state = ORIGINAL_TOKEN_STATE.get(token);
  if (!state) {
    cleanupTokenOutline(token, null);
    return;
  }

  try {
    if (token.mesh && !token.mesh.destroyed) {
      token.mesh.scale.set(state.baseScaleX, state.baseScaleY);
      removePerspectiveOutlineFilters(token.mesh);
    }
    cleanupTokenOutline(token, state);
  } finally {
    ORIGINAL_TOKEN_STATE.delete(token);
  }
}

function getTokenState(token, mesh) {
  const signature = getTokenSignature(token);
  let state = ORIGINAL_TOKEN_STATE.get(token);
  if (state && state.signature === signature && state.meshRef === mesh) return state;

  const sameMesh = Boolean(state && state.meshRef === mesh);
  const previousScale = Number(state?.lastPerspectiveScale) || 1;
  const baseScaleX = sameMesh ? mesh.scale.x / previousScale : mesh.scale.x;
  const baseScaleY = sameMesh ? mesh.scale.y / previousScale : mesh.scale.y;

  cleanupTokenOutline(token, state);
  state = {
    signature,
    meshRef: mesh,
    baseScaleX,
    baseScaleY,
    lastPerspectiveScale: 1
  };
  ORIGINAL_TOKEN_STATE.set(token, state);
  return state;
}

function getTokenGroundY(token) {
  // Use the token's logical top-left + logical height instead of bounds.bottom.
  // bounds.bottom changes after the mesh is scaled, which creates feedback
  // during dragging and makes tokens appear to grow or shrink from their own
  // already-perspective-scaled dimensions.
  const rect = getSceneRect();
  const y = Number(token.position?.y ?? token.y ?? token.document?.y ?? 0) || 0;
  const h = Number(token.h ?? ((token.document?.height || 1) * rect.gridSize) ?? rect.gridSize) || rect.gridSize;
  return y + h;
}

function applyPerspectiveToToken(token) {
  if (!isTokenObject(token) || token.destroyed) return;

  const config = getLevelConfig();
  if (!config.enabled || !config.tokenScaling) {
    removePerspectiveFromToken(token);
    return;
  }

  const mesh = token.mesh;
  if (!mesh || mesh.destroyed) return;

  const state = getTokenState(token, mesh);
  const groundY = getTokenGroundY(token);
  const scale = scaleForY(groundY, config);
  mesh.scale.set(state.baseScaleX * scale, state.baseScaleY * scale);
  state.lastPerspectiveScale = scale;

  // v0.1.3: token outlines were removed completely. Clean up any legacy
  // outline containers/filters left by older versions so tokens do not duplicate.
  cleanupTokenOutline(token, state);
}

function refreshTokens() {
  forEachToken(token => {
    try { applyPerspectiveToToken(token); }
    catch (err) { console.warn(`${MODULE_ID} | Failed to update token perspective`, err); }
  });
}

class PerspectiveGridOverlay {
  constructor() {
    this.container = null;
    this.grid = null;
    this._lastLevelId = null;
    this._ticker = this._ticker.bind(this);
  }

  ensure() {
    if (!canvas?.ready || !canvas.interface) return false;
    if (!this.container || this.container.destroyed) {
      this.container = new PIXI.Container();
      this.container.name = "PerspectiveLevels.GridOverlay";
      this.container.eventMode = "none";
      this.grid = new PIXI.Graphics();
      this.grid.name = "PerspectiveLevels.Grid";
      this.grid.eventMode = "none";
      this.container.addChild(this.grid);
    }
    if (!this.container.parent) canvas.interface.addChildAt?.(this.container, 0) ?? canvas.interface.addChild(this.container);
    return true;
  }

  destroy() {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
    this.grid = null;
  }

  startTicker() {
    if (!canvas?.app?.ticker) return;
    try { canvas.app.ticker.remove(this._ticker); } catch (_err) { /* noop */ }
    canvas.app.ticker.add(this._ticker);
  }

  stopTicker() {
    try { canvas?.app?.ticker?.remove(this._ticker); } catch (_err) { /* noop */ }
  }

  _ticker() {
    const id = canvas?.level?.id ?? null;
    if (id !== this._lastLevelId) {
      this._lastLevelId = id;
      refreshAll();
    }
  }

  draw() {
    if (!this.ensure()) return;
    const level = canvas.level;
    const config = getLevelConfig(level);
    this.container.visible = Boolean(config.enabled && config.grid);
    this.grid.clear();
    if (!this.container.visible) return;

    const rect = getSceneRect();
    const color = parseColor(config.gridColor, 0xffffff);
    const alpha = config.gridAlpha;
    const lineWidth = config.gridLineWidth;
    const model = getPerspectiveGridModel(config, rect);

    const g = this.grid;
    g.lineStyle({ width: lineWidth, color, alpha });

    // Horizontal lines: each adjacent pair is one perspective grid square in
    // the vertical direction. Their screen spacing changes with curve.
    for (let row = 0; row <= model.rows; row++) {
      const left = perspectiveGridToScreen(0, row, config, rect);
      const right = perspectiveGridToScreen(model.columns, row, config, rect);
      g.moveTo(left.x, left.y);
      g.lineTo(right.x, right.y);
    }

    // Vertical lines: each adjacent pair is one perspective grid square in the
    // horizontal direction at the current row.
    const steps = Math.max(12, Math.min(48, model.rows * 2));
    for (let col = 0; col <= model.columns; col++) {
      for (let s = 0; s <= steps; s++) {
        const row = (s / steps) * model.rows;
        const point = perspectiveGridToScreen(col, row, config, rect);
        if (s === 0) g.moveTo(point.x, point.y);
        else g.lineTo(point.x, point.y);
      }
    }
  }
}

class PerspectiveCalibrator {
  constructor() {
    this.level = null;
    this.config = null;
    this.container = null;
    this.anchors = {};
    this.panel = null;
    this.dragging = null;
  }

  get active() {
    return Boolean(this.container && !this.container.destroyed);
  }

  open() {
    if (!canvas?.ready || !canvas.level) {
      ui.notifications?.warn("Открой сцену и выбери уровень, который нужно настроить.");
      return;
    }
    this.close(false);
    this.level = canvas.level;
    this.config = getLevelConfig(this.level);
    this.config.enabled = true;
    this.config.grid = true;

    this.container = new PIXI.Container();
    this.container.name = "PerspectiveLevels.Calibrator";
    this.container.eventMode = "static";
    this.container.sortableChildren = true;

    const rect = getSceneRect();
    this.container.hitArea = new PIXI.Rectangle(rect.x, rect.y, rect.width, rect.height);
    canvas.interface.addChild(this.container);

    this.anchors.far = this._createAnchor("far", i18n("PERSPECTIVE_LEVELS.FarAnchor"), 0x4aa3ff);
    this.anchors.near = this._createAnchor("near", i18n("PERSPECTIVE_LEVELS.NearAnchor"), 0xffb84a);
    this.container.addChild(this.anchors.far, this.anchors.near);

    this.container.on("pointermove", event => this._onPointerMove(event));
    this.container.on("pointerup", () => this._stopDrag());
    this.container.on("pointerupoutside", () => this._stopDrag());

    this._createPanel();
    this.redraw();
    refreshAll();
  }

  close(refresh = true) {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
    this.anchors = {};
    this.dragging = null;
    this.level = null;
    if (this.panel) this.panel.remove();
    this.panel = null;
    if (refresh) refreshAll();
  }

  toggle() {
    if (this.active) this.close();
    else this.open();
  }

  async save() {
    if (!this.level || !this.config) return;
    await setLevelConfig(this.level, this.config);
    ui.notifications?.info(`Perspective Levels: настройки сохранены на уровень «${this.level.name}».`);
    refreshAll();
  }

  reset() {
    this.config = normalizeConfig({ enabled: true });
    this._syncPanelFromConfig();
    this.redraw();
    refreshAll();
  }

  _createAnchor(key, label, color) {
    const anchor = new PIXI.Container();
    anchor.name = `PerspectiveLevels.Anchor.${key}`;
    anchor.eventMode = "static";
    anchor.cursor = "move";
    anchor.zIndex = 1000;
    anchor._plKey = key;
    anchor._plColor = color;

    anchor.gfx = new PIXI.Graphics();
    anchor.label = new PIXI.Text(label, {
      fontFamily: "Arial",
      fontSize: 16,
      fill: 0xffffff,
      stroke: 0x000000,
      strokeThickness: 4
    });
    anchor.label.anchor.set(0.5, 0);
    anchor.addChild(anchor.gfx, anchor.label);

    anchor.on("pointerdown", event => {
      event.stopPropagation();
      this.dragging = key;
      anchor.alpha = 0.75;
    });

    return anchor;
  }

  _onPointerMove(event) {
    if (!this.dragging || !this.container) return;
    const point = event.getLocalPosition(this.container.parent);
    const rect = getSceneRect();
    const normalized = pointToAnchor(point, rect);
    this.config[this.dragging].x = normalized.x;
    this.config[this.dragging].y = normalized.y;
    this.redraw();
    refreshAll();
  }

  _stopDrag() {
    if (this.dragging && this.anchors[this.dragging]) this.anchors[this.dragging].alpha = 1;
    this.dragging = null;
  }

  _createPanel() {
    const existing = document.getElementById("perspective-levels-calibrator");
    if (existing) existing.remove();

    const div = document.createElement("div");
    div.id = "perspective-levels-calibrator";
    div.innerHTML = `
      <header>${i18n("PERSPECTIVE_LEVELS.Calibrator")}</header>
      <p class="hint">Перетащи два якоря на сцене. Масштаб якорей задаёт, какими будут токены на дальнем и ближнем плане.</p>
      <label>${i18n("PERSPECTIVE_LEVELS.FarAnchor")} scale <input type="range" data-pl-scale="far" min="0.05" max="2.5" step="0.01"></label>
      <label>${i18n("PERSPECTIVE_LEVELS.NearAnchor")} scale <input type="range" data-pl-scale="near" min="0.05" max="3.5" step="0.01"></label>
      <label>Кривизна сетки <input type="range" data-pl-curve min="0.4" max="4" step="0.01"></label>
      <label>Масштаб клетки сетки <input type="range" data-pl-grid-scale min="0.1" max="4" step="0.05"></label>
      <footer>
        <button type="button" data-pl-action="save"><i class="fa-solid fa-floppy-disk"></i> ${i18n("PERSPECTIVE_LEVELS.Save")}</button>
        <button type="button" data-pl-action="reset">${i18n("PERSPECTIVE_LEVELS.Reset")}</button>
        <button type="button" data-pl-action="close">${i18n("PERSPECTIVE_LEVELS.Close")}</button>
      </footer>
    `;
    document.body.appendChild(div);
    this.panel = div;

    div.querySelectorAll("input[data-pl-scale]").forEach(input => {
      input.addEventListener("input", event => {
        const key = event.currentTarget.dataset.plScale;
        this.config[key].scale = clamp(event.currentTarget.value, 0.05, 4);
        this.redraw();
        refreshAll();
      });
    });
    div.querySelector("input[data-pl-curve]")?.addEventListener("input", event => {
      this.config.curve = clamp(event.currentTarget.value, 0.4, 4);
      this.redraw();
      refreshAll();
    });
    div.querySelector("input[data-pl-grid-scale]")?.addEventListener("input", event => {
      this.config.gridScale = clamp(event.currentTarget.value, 0.1, 8);
      this.redraw();
      refreshAll();
    });
    div.querySelector("[data-pl-action='save']")?.addEventListener("click", () => this.save());
    div.querySelector("[data-pl-action='reset']")?.addEventListener("click", () => this.reset());
    div.querySelector("[data-pl-action='close']")?.addEventListener("click", () => this.close());

    this._syncPanelFromConfig();
  }

  _syncPanelFromConfig() {
    if (!this.panel || !this.config) return;
    const far = this.panel.querySelector("input[data-pl-scale='far']");
    const near = this.panel.querySelector("input[data-pl-scale='near']");
    const curve = this.panel.querySelector("input[data-pl-curve]");
    const gridScale = this.panel.querySelector("input[data-pl-grid-scale]");
    if (far) far.value = this.config.far.scale;
    if (near) near.value = this.config.near.scale;
    if (curve) curve.value = this.config.curve;
    if (gridScale) gridScale.value = this.config.gridScale;
  }

  redraw() {
    if (!this.container || !this.config) return;
    const rect = getSceneRect();
    for (const key of ["far", "near"]) {
      const anchor = this.anchors[key];
      if (!anchor) continue;
      const data = this.config[key];
      const point = anchorToPoint(data, rect);
      const size = Math.max(28, rect.gridSize * data.scale);
      anchor.position.set(point.x, point.y);
      anchor.gfx.clear();
      anchor.gfx.lineStyle({ width: 3, color: anchor._plColor, alpha: 1 });
      anchor.gfx.beginFill(anchor._plColor, 0.22);
      anchor.gfx.drawRoundedRect(-size / 2, -size / 2, size, size, 10);
      anchor.gfx.endFill();
      anchor.gfx.lineStyle({ width: 2, color: 0xffffff, alpha: 0.95 });
      anchor.gfx.drawCircle(0, 0, size * 0.28);
      anchor.gfx.moveTo(-size * 0.5, 0);
      anchor.gfx.lineTo(size * 0.5, 0);
      anchor.gfx.moveTo(0, -size * 0.5);
      anchor.gfx.lineTo(0, size * 0.5);
      anchor.label.y = size / 2 + 6;
    }
    GRID_OVERLAY.draw();
  }
}


const PENDING_DRAG_TOKENS = new Set();
let PENDING_DRAG_RAF = null;

function addTokenLikeToSet(value, set) {
  if (!value) return;
  if (isTokenObject(value)) {
    set.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addTokenLikeToSet(entry, set);
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) addTokenLikeToSet(entry, set);
    return;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) addTokenLikeToSet(entry, set);
    return;
  }
  if (Array.isArray(value.children)) {
    for (const child of value.children) addTokenLikeToSet(child, set);
  }
  if (Array.isArray(value.placeables)) {
    for (const placeable of value.placeables) addTokenLikeToSet(placeable, set);
  }
}

function collectTokenAndDragPreviews(token) {
  const set = new Set();
  addTokenLikeToSet(token, set);

  for (const key of ["_preview", "preview", "_dragPreview", "_movementPreview", "_previewObject"]) {
    try { addTokenLikeToSet(token?.[key], set); }
    catch (_err) { /* private access may throw in some builds */ }
  }

  const layer = token?.layer ?? canvas?.tokens;
  for (const source of [
    layer?.preview,
    layer?._preview,
    layer?.previews,
    layer?._previews,
    layer?.objects?.preview,
    canvas?.tokens?.preview,
    canvas?.tokens?._preview
  ]) {
    addTokenLikeToSet(source, set);
  }

  return [...set];
}

function flushPerspectiveDragRefresh() {
  const tokens = [...PENDING_DRAG_TOKENS];
  PENDING_DRAG_TOKENS.clear();
  PENDING_DRAG_RAF = null;

  const config = getLevelConfig();
  if (!isPerspectiveEnabled(config)) return;

  for (const token of tokens) {
    for (const candidate of collectTokenAndDragPreviews(token)) {
      try { applyPerspectiveToToken(candidate); }
      catch (err) { console.warn(`${MODULE_ID} | Failed to update token drag preview perspective`, err); }
    }
  }
}

function schedulePerspectiveDragRefresh(token) {
  if (!token) return;
  PENDING_DRAG_TOKENS.add(token);
  if (PENDING_DRAG_RAF) return;
  const raf = globalThis.requestAnimationFrame ?? ((fn) => window.setTimeout(fn, 16));
  PENDING_DRAG_RAF = raf(flushPerspectiveDragRefresh);
}

function wrapPrototypeMethod(proto, methodName, wrapper) {
  const original = proto?.[methodName];
  if (typeof original !== "function" || original._perspectiveLevelsWrapped) return false;
  const wrapped = function perspectiveLevelsWrappedMethod(...args) {
    return wrapper.call(this, original, args);
  };
  wrapped._perspectiveLevelsWrapped = true;
  wrapped._perspectiveLevelsOriginal = original;
  proto[methodName] = wrapped;
  return true;
}

function installTokenPreviewScalingPatch() {
  const TokenClass = foundry?.canvas?.placeables?.Token ?? CONFIG?.Token?.objectClass ?? globalThis.Token;
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsPreviewPatch) return;
  proto._perspectiveLevelsPreviewPatch = true;

  const afterDragMove = function(original, args) {
    const result = original.apply(this, args);
    schedulePerspectiveDragRefresh(this);
    return result;
  };

  for (const method of [
    "_onDragLeftMove",
    "_onDragRightMove",
    "_updateDragDestination",
    "_refreshPosition",
    "_refreshMesh",
    "_refreshMeshSizeAndScale"
  ]) {
    wrapPrototypeMethod(proto, method, afterDragMove);
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

  console.log(`${MODULE_ID} | Token drag-preview scaling patch installed`);
}

function installPerspectiveMeasurementPatch() {
  const BaseGrid = foundry?.grid?.BaseGrid;
  const proto = BaseGrid?.prototype;
  if (!proto || proto._perspectiveLevelsMeasurementPatch) return;
  proto._perspectiveLevelsMeasurementPatch = true;

  wrapPrototypeMethod(proto, "measurePath", function(original, args) {
    const result = original.apply(this, args);
    try {
      const [waypoints, options = {}] = args;
      if (options?._perspectiveLevelsBypass || result?._perspectiveLevels) return result;
      const config = getLevelConfig();
      if (!canvas?.ready || !isPerspectiveDistanceEnabled(config)) return result;
      return applyPerspectiveMeasurement(result, waypoints, config);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective grid measurement`, err);
      return result;
    }
  });

  console.log(`${MODULE_ID} | Perspective distance measurement patch installed`);
}

function installRuntimePatches() {
  installTokenPreviewScalingPatch();
  installPerspectiveMeasurementPatch();
}

const GRID_OVERLAY = new PerspectiveGridOverlay();
const CALIBRATOR = new PerspectiveCalibrator();

function refreshAll() {
  GRID_OVERLAY.draw();
  if (CALIBRATOR.active) CALIBRATOR.redraw();
  refreshTokens();
}

function fieldName(path) {
  return `flags.${MODULE_ID}.${FLAG}.${path}`;
}

function checkedAttr(value) {
  return value ? "checked" : "";
}

function injectLevelConfig(app, html) {
  if (!game.user?.isGM) return;
  const level = app?.document;
  if (!level || level.documentName !== "Level") return;

  const element = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!element || element.querySelector?.(".perspective-levels-config")) return;

  const form = element.querySelector("form") ?? element;
  const target = form.querySelector("[data-tab='basics']")
    ?? form.querySelector(".tab.active")
    ?? form.querySelector(".form-body")
    ?? form;

  const cfg = getLevelConfig(level);
  const htmlString = `
    <fieldset class="perspective-levels-config">
      <legend><i class="fa-solid fa-vector-square"></i> ${i18n("PERSPECTIVE_LEVELS.Title")}</legend>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.Enable")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("enabled")}" value="false">
          <input type="checkbox" name="${fieldName("enabled")}" value="true" ${checkedAttr(cfg.enabled)}>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.Grid")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("grid")}" value="false">
          <input type="checkbox" name="${fieldName("grid")}" value="true" ${checkedAttr(cfg.grid)}>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.TokenScaling")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("tokenScaling")}" value="false">
          <input type="checkbox" name="${fieldName("tokenScaling")}" value="true" ${checkedAttr(cfg.tokenScaling)}>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.Distance")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("distance")}" value="false">
          <input type="checkbox" name="${fieldName("distance")}" value="true" ${checkedAttr(cfg.distance)}>
        </div>
      </div>

      <div class="form-group stacked perspective-levels-grid-settings">
        <label>Сетка</label>
        <div class="form-fields">
          <label>Цвет <input type="color" name="${fieldName("gridColor")}" value="${cfg.gridColor}"></label>
          <label>Прозрачность <input type="number" name="${fieldName("gridAlpha")}" value="${cfg.gridAlpha}" min="0" max="1" step="0.05"></label>
          <label>Толщина <input type="number" name="${fieldName("gridLineWidth")}" value="${cfg.gridLineWidth}" min="0.25" max="8" step="0.25"></label>
          <label>Масштаб клетки <input type="number" name="${fieldName("gridScale")}" value="${cfg.gridScale}" min="0.1" max="8" step="0.05"></label>
        </div>
      </div>

      <div class="form-group stacked perspective-levels-anchor-settings">
        <label>Якоря перспективы</label>
        <div class="form-fields perspective-levels-anchor-grid">
          <label>Far X <input type="number" name="${fieldName("far.x")}" value="${cfg.far.x}" min="0" max="1" step="0.01"></label>
          <label>Far Y <input type="number" name="${fieldName("far.y")}" value="${cfg.far.y}" min="0" max="1" step="0.01"></label>
          <label>Far Scale <input type="number" name="${fieldName("far.scale")}" value="${cfg.far.scale}" min="0.05" max="4" step="0.01"></label>
          <label>Near X <input type="number" name="${fieldName("near.x")}" value="${cfg.near.x}" min="0" max="1" step="0.01"></label>
          <label>Near Y <input type="number" name="${fieldName("near.y")}" value="${cfg.near.y}" min="0" max="1" step="0.01"></label>
          <label>Near Scale <input type="number" name="${fieldName("near.scale")}" value="${cfg.near.scale}" min="0.05" max="4" step="0.01"></label>
          <label>Curve <input type="number" name="${fieldName("curve")}" value="${cfg.curve}" min="0.4" max="4" step="0.01"></label>
        </div>
      </div>

      <button type="button" class="perspective-levels-open-calibrator">
        <i class="fa-solid fa-crosshairs"></i> ${i18n("PERSPECTIVE_LEVELS.OpenCalibrator")}
      </button>
      <p class="hint">Настройки сохраняются в flags текущего Level. Кнопка калибровки работает, если этот уровень сейчас открыт на canvas.</p>
    </fieldset>
  `;

  target.insertAdjacentHTML("beforeend", htmlString);
  element.querySelector(".perspective-levels-open-calibrator")?.addEventListener("click", event => {
    event.preventDefault();
    if (canvas.level?.id !== level.id) {
      ui.notifications?.warn("Сначала выбери этот уровень на сцене, затем открой калибровку.");
      return;
    }
    CALIBRATOR.open();
  });
}

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
  installRuntimePatches();
});

Hooks.once("ready", () => {
  installRuntimePatches();
});

Hooks.on("getSceneControlButtons", controls => {
  const tokens = controls.tokens;
  if (!tokens?.tools) return;
  tokens.tools.perspectiveLevelsCalibrator = {
    name: "perspectiveLevelsCalibrator",
    title: "Perspective Levels: калибровка уровня",
    icon: "fa-solid fa-vector-square",
    order: Object.keys(tokens.tools).length + 100,
    button: true,
    visible: game.user?.isGM,
    onChange: () => CALIBRATOR.toggle()
  };
});

Hooks.on("renderLevelConfig", (app, html, _context, _options) => injectLevelConfig(app, html));
Hooks.on("renderApplicationV2", (app, html, _context, _options) => {
  if (app?.constructor?.name === "LevelConfig") injectLevelConfig(app, html);
});

Hooks.on("canvasReady", () => {
  installRuntimePatches();
  GRID_OVERLAY.startTicker();
  refreshAll();
});

Hooks.on("canvasPan", () => refreshAll());
Hooks.on("canvasTearDown", () => {
  CALIBRATOR.close(false);
  GRID_OVERLAY.stopTicker();
  GRID_OVERLAY.destroy();
  forEachToken(removePerspectiveFromToken);
});

Hooks.on("drawObject", object => {
  if (isTokenObject(object)) applyPerspectiveToToken(object);
});
Hooks.on("refreshObject", object => {
  if (isTokenObject(object)) applyPerspectiveToToken(object);
});
Hooks.on("destroyObject", object => {
  if (isTokenObject(object)) removePerspectiveFromToken(object);
});

Hooks.on("moveToken", () => refreshTokens());
Hooks.on("recordToken", () => refreshTokens());
Hooks.on("stopToken", () => refreshTokens());

Hooks.on("updateDocument", (document, changes) => {
  if (!canvas?.ready) return;
  if (document?.documentName === "Level" && document.parent?.id === canvas.scene?.id) refreshAll();
  if (document?.documentName === "Scene" && document.id === canvas.scene?.id && (changes.grid || changes.width || changes.height)) refreshAll();
});

globalThis.PerspectiveLevels = {
  MODULE_ID,
  getLevelConfig,
  setLevelConfig,
  refresh: refreshAll,
  openCalibrator: () => CALIBRATOR.open(),
  closeCalibrator: () => CALIBRATOR.close(),
  toggleCalibrator: () => CALIBRATOR.toggle(),
  scaleForY,
  screenPointToPerspectiveGround,
  screenPointToPerspectiveGrid,
  getPerspectiveGridModel,
  perspectiveGridToScreen,
  perspectiveDistanceBetween,
  measurePerspectivePath: buildPerspectiveMeasurement
};
