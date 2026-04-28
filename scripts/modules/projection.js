import { getLevelConfig } from "./config.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { clamp } from "./utils.js";

export function anchorToPoint(anchor, rect = getSceneRect()) {
  return {
    x: rect.x + anchor.x * rect.width,
    y: rect.y + anchor.y * rect.height
  };
}

export function pointToAnchor(point, rect = getSceneRect()) {
  return {
    x: clamp((point.x - rect.x) / rect.width, 0, 1),
    y: clamp((point.y - rect.y) / rect.height, 0, 1)
  };
}

export function scaleForY(y, config = getLevelConfig(), rect = getSceneRect()) {
  const farY = rect.y + config.far.y * rect.height;
  const nearY = rect.y + config.near.y * rect.height;
  const span = nearY - farY;
  if (Math.abs(span) < 1) return config.near.scale;

  const t = clamp((y - farY) / span, 0, 1);
  return config.far.scale + (config.near.scale - config.far.scale) * t;
}

export function getElevation(point) {
  const candidates = [point?.elevation, point?.z, point?.k];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function getPointXY(point) {
  return {
    x: Number(point?.x ?? 0) || 0,
    y: Number(point?.y ?? 0) || 0,
    elevation: getElevation(point)
  };
}

export function getPerspectiveCellSize(config = getLevelConfig(), rect = getSceneRect()) {
  return Math.max(4, rect.gridSize * clamp(config.gridScale ?? 1, 0.1, 8));
}

export function getPerspectiveGridModel(config = getLevelConfig(), rect = getSceneRect()) {
  const cellSize = getPerspectiveCellSize(config, rect);
  const far = anchorToPoint(config.far, rect);
  const near = anchorToPoint(config.near, rect);
  const span = near.y - far.y;
  const safeSpan = Math.abs(span) < 1 ? (span < 0 ? -1 : 1) : span;
  const rows = Math.max(1, Math.round(clamp(config.sceneDepthCells ?? 12, 1, 200)));

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

export function perspectiveGridModelToScreen(model, column, row) {
  const rawT = model.rows > 0 ? row / model.rows : 0;
  const yT = Math.pow(Math.max(0, rawT), model.curve);
  const bottomX = model.startX + column * model.cellSize;
  return {
    x: model.vanishX + (bottomX - model.vanishX) * rawT,
    y: model.topY + model.span * yT
  };
}

export function perspectiveGridToScreen(column, row, config = getLevelConfig(), rect = getSceneRect()) {
  return perspectiveGridModelToScreen(getPerspectiveGridModel(config, rect), column, row);
}

function screenPointToPerspectiveGridRaw(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = getPointXY(point);
  const model = getPerspectiveGridModel(config, rect);

  let normalizedY = (p.y - model.topY) / model.span;
  if (!Number.isFinite(normalizedY)) normalizedY = 0;

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

export function getPerspectiveCellScreenHeightAtRow(row, config = getLevelConfig(), rect = getSceneRect()) {
  const model = getPerspectiveGridModel(config, rect);
  const safeRow = Number.isFinite(Number(row)) ? Number(row) : 0;
  const p0 = perspectiveGridModelToScreen(model, model.columns / 2, safeRow);
  const p1 = perspectiveGridModelToScreen(model, model.columns / 2, safeRow + 1);
  const height = Math.abs(Number(p1.y) - Number(p0.y));
  return Number.isFinite(height) && height > 0.0001 ? height : Math.max(1, rect.gridSize * 0.25);
}

export function elevationToScreenOffsetAtRow(elevation, row, config = getLevelConfig(), rect = getSceneRect()) {
  const e = Number(elevation) || 0;
  if (Math.abs(e) < 0.0001) return 0;

  const gridDistance = Math.max(0.0001, getSceneGridDistance());
  const gridScale = Math.max(0.1, Number(config.gridScale) || 1);
  const spaces = e / gridDistance;
  return spaces * gridScale * getPerspectiveCellScreenHeightAtRow(row, config, rect);
}

export function screenPointToElevationGroundPoint(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = getPointXY(point);
  if (Math.abs(p.elevation) < 0.0001) return p;

  // Foundry v14 stores token elevation in real scene units. For perspective mode we
  // interpret the token's canvas Y as a projected/elevated visual point and recover
  // the ground point under it. The local pixel-per-height-unit depends on the
  // perspective row, so solve it iteratively instead of using a constant.
  let groundY = p.y;
  for (let i = 0; i < 5; i++) {
    const coords = screenPointToPerspectiveGridRaw({ x: p.x, y: groundY, elevation: 0 }, config, rect);
    const offset = elevationToScreenOffsetAtRow(p.elevation, coords.j, config, rect);
    const nextY = p.y + offset;
    if (Math.abs(nextY - groundY) < 0.01) {
      groundY = nextY;
      break;
    }
    groundY = nextY;
  }

  return { x: p.x, y: groundY, elevation: p.elevation };
}

export function perspectiveGroundPointToElevatedScreen(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = getPointXY(point);
  if (Math.abs(p.elevation) < 0.0001) return p;

  const coords = screenPointToPerspectiveGridRaw({ x: p.x, y: p.y, elevation: 0 }, config, rect);
  const offset = elevationToScreenOffsetAtRow(p.elevation, coords.j, config, rect);
  return { x: p.x, y: p.y - offset, elevation: p.elevation };
}

export function screenPointToPerspectiveGrid(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = screenPointToElevationGroundPoint(point, config, rect);
  const coords = screenPointToPerspectiveGridRaw(p, config, rect);
  coords.elevation = p.elevation;
  return coords;
}

export function screenPointToPerspectiveGround(point, config = getLevelConfig(), rect = getSceneRect()) {
  const coords = screenPointToPerspectiveGrid(point, config, rect);
  return {
    x: coords.i * rect.gridSize,
    y: coords.j * rect.gridSize,
    elevation: coords.elevation
  };
}
