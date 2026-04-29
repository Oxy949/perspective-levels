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

function degreesToRadians(degrees) {
  const n = Number(degrees) || 0;
  return (n * Math.PI) / 180;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function subtractPoint(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function pointOnLine(center, angleRadians, length, side) {
  const half = Math.max(1, Number(length) || 1) / 2;
  const dx = Math.cos(angleRadians) * half * side;
  const dy = Math.sin(angleRadians) * half * side;
  return { x: center.x + dx, y: center.y + dy };
}

function lineDataForAnchor(anchor, length, rect = getSceneRect()) {
  const center = anchorToPoint(anchor, rect);
  const angle = degreesToRadians(anchor?.rotation ?? 0);
  return {
    center,
    angle,
    length,
    left: pointOnLine(center, angle, length, -1),
    right: pointOnLine(center, angle, length, 1)
  };
}

export function scaleForPerspectivePoint(point, config = getLevelConfig(), rect = getSceneRect()) {
  const model = getPerspectiveGridModel(config, rect);
  const coords = screenPointToPerspectiveGridRaw(point, config, rect);
  const t = clamp(coords.j / Math.max(1, model.rows), 0, 1);
  return config.far.scale + (config.near.scale - config.far.scale) * t;
}

export function scaleForPerspectiveToken(point, config = getLevelConfig(), rect = getSceneRect()) {
  // gridScale controls the visible size of one perspective cell in pixels.
  // Token scaling must follow it too: when all calibration values are 1:1,
  // a normal 1x1 Foundry token should visually occupy exactly one drawn
  // perspective cell. Distance math stays cell-based elsewhere.
  const cellVisualScale = clamp(config.gridScale ?? 1, 0.1, 8);
  return scaleForPerspectivePoint(point, config, rect) * cellVisualScale;
}

export function scaleForY(y, config = getLevelConfig(), rect = getSceneRect()) {
  const model = getPerspectiveGridModel(config, rect);
  return scaleForPerspectivePoint({ x: model.near.center.x, y, elevation: 0 }, config, rect);
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
  const rows = Math.max(1, Math.round(clamp(config.sceneDepthCells ?? 12, 1, 200)));

  const minimumColumns = 4;
  const columns = Math.max(minimumColumns, Math.ceil((rect.width * 1.1) / cellSize));
  const baseWidth = columns * cellSize;

  // Both anchors are finite lines. The near line keeps the calibrated base width;
  // the far line shrinks/expands by the same ratio that token scale uses. This
  // preserves older scenes while removing the single-point convergence model.
  const nearLength = baseWidth;
  const safeNearScale = Math.max(0.0001, Number(config.near?.scale) || 1);
  const farLength = baseWidth * (Math.max(0.0001, Number(config.far?.scale) || 1) / safeNearScale);

  const far = lineDataForAnchor(config.far, farLength, rect);
  const near = lineDataForAnchor(config.near, nearLength, rect);

  return {
    rect,
    cellSize,
    rows,
    columns,
    baseWidth,
    far,
    near,
    // Legacy-compatible aliases used by a few debug scripts / external macros.
    topY: far.center.y,
    bottomY: near.center.y,
    span: near.center.y - far.center.y || 1,
    vanishX: far.center.x,
    nearCenterX: near.center.x,
    startX: near.left.x,
    endX: near.right.x,
    curve: Math.max(0.01, config.curve)
  };
}

export function perspectiveGridModelToScreen(model, column, row) {
  const rawT = model.rows > 0 ? row / model.rows : 0;
  const clampedRawT = clamp(rawT, -10, 10);
  const easedT = clampedRawT >= 0
    ? Math.pow(Math.max(0, clampedRawT), model.curve)
    : -Math.pow(Math.abs(clampedRawT), model.curve);

  const u = model.columns > 0 ? column / model.columns : 0;
  const left = lerpPoint(model.far.left, model.near.left, easedT);
  const right = lerpPoint(model.far.right, model.near.right, easedT);

  return {
    x: lerp(left.x, right.x, u),
    y: lerp(left.y, right.y, u)
  };
}

export function perspectiveGridToScreen(column, row, config = getLevelConfig(), rect = getSceneRect()) {
  return perspectiveGridModelToScreen(getPerspectiveGridModel(config, rect), column, row);
}

function bilinearPoint(model, t, u) {
  const left = lerpPoint(model.far.left, model.near.left, t);
  const right = lerpPoint(model.far.right, model.near.right, t);
  return {
    x: lerp(left.x, right.x, u),
    y: lerp(left.y, right.y, u)
  };
}

function solveBilinearCoordinates(model, point) {
  const p = getPointXY(point);
  const farCenter = model.far.center;
  const nearCenter = model.near.center;
  const centerAxis = subtractPoint(nearCenter, farCenter);
  const axisLenSq = Math.max(0.0001, centerAxis.x * centerAxis.x + centerAxis.y * centerAxis.y);

  let t = clamp(((p.x - farCenter.x) * centerAxis.x + (p.y - farCenter.y) * centerAxis.y) / axisLenSq, 0, 1);
  let u = 0.5;

  for (let i = 0; i < 10; i++) {
    const left = lerpPoint(model.far.left, model.near.left, t);
    const right = lerpPoint(model.far.right, model.near.right, t);
    const width = subtractPoint(right, left);
    const widthLenSq = width.x * width.x + width.y * width.y;
    if (widthLenSq > 0.0001) {
      u = clamp(((p.x - left.x) * width.x + (p.y - left.y) * width.y) / widthLenSq, -4, 5);
    }

    const current = bilinearPoint(model, t, u);
    const fx = current.x - p.x;
    const fy = current.y - p.y;
    if (Math.hypot(fx, fy) < 0.01) break;

    const dLeft = subtractPoint(model.near.left, model.far.left);
    const dRight = subtractPoint(model.near.right, model.far.right);
    const dWidth = subtractPoint(dRight, dLeft);
    const dt = { x: dLeft.x + dWidth.x * u, y: dLeft.y + dWidth.y * u };
    const du = width;

    const det = dt.x * du.y - du.x * dt.y;
    if (Math.abs(det) < 0.000001) break;

    const deltaT = (fx * du.y - du.x * fy) / det;
    const deltaU = (dt.x * fy - fx * dt.y) / det;
    t = clamp(t - deltaT, -4, 5);
    u = clamp(u - deltaU, -4, 5);
  }

  return { t, u };
}

function projectionOnGridRow(model, row, point) {
  const left = perspectiveGridModelToScreen(model, 0, row);
  const right = perspectiveGridModelToScreen(model, model.columns, row);
  const width = subtractPoint(right, left);
  const widthLenSq = Math.max(0.0001, width.x * width.x + width.y * width.y);
  const rawU = ((point.x - left.x) * width.x + (point.y - left.y) * width.y) / widthLenSq;

  // Allow a generous amount of measuring just outside the drawn strip, but do
  // not let pathological anchor rotations choose a wildly distant extension.
  const u = clamp(rawU, -4, 5);
  const projected = {
    x: left.x + width.x * u,
    y: left.y + width.y * u
  };
  const dx = projected.x - point.x;
  const dy = projected.y - point.y;

  return {
    row,
    u,
    distanceSquared: (dx * dx) + (dy * dy)
  };
}

function betterGridProjection(a, b, epsilon = 0.0001) {
  if (!a) return b;
  if (!b) return a;
  if (b.distanceSquared < a.distanceSquared - epsilon) return b;
  if (Math.abs(b.distanceSquared - a.distanceSquared) <= epsilon) {
    // If two row-lines overlap because the calibrated quadrilateral folds over
    // itself, prefer the visually earlier row. This keeps a point lying on the
    // far anchor line at row 0 instead of letting a later crossing row win and
    // making depth distances explode.
    if (b.row < a.row) return b;
  }
  return a;
}

function solveVisualGridCoordinates(model, point) {
  const p = getPointXY(point);
  const minRow = 0;
  const maxRow = model.rows;

  let best = null;

  // Include every actually drawn horizontal grid line. This makes exact clicks
  // on visible lines/anchors deterministic and, more importantly, avoids the
  // old bilinear inverse picking another self-intersection when anchors are
  // rotated.
  for (let row = 0; row <= model.rows; row++) {
    best = betterGridProjection(best, projectionOnGridRow(model, row, p));
  }

  // Also include a moderate continuous scan between the lines so points
  // inside cells still receive a stable fractional coordinate before the
  // measurement layer snaps them back to whole cells.
  const samples = Math.max(48, Math.min(192, Math.ceil(model.rows * 8)));
  for (let step = 0; step <= samples; step++) {
    const row = minRow + ((maxRow - minRow) * (step / samples));
    best = betterGridProjection(best, projectionOnGridRow(model, row, p));
  }

  // Refine the best continuous sample locally. A small bracket is enough because
  // the coarse pass already chooses the visual row band; keeping it local also
  // prevents jumps to a different crossing in folded/strongly rotated grids.
  let lo = Math.max(minRow, best.row - ((maxRow - minRow) / samples));
  let hi = Math.min(maxRow, best.row + ((maxRow - minRow) / samples));
  for (let i = 0; i < 12; i++) {
    const m1 = lo + ((hi - lo) / 3);
    const m2 = hi - ((hi - lo) / 3);
    const p1 = projectionOnGridRow(model, m1, p);
    const p2 = projectionOnGridRow(model, m2, p);
    if (p1.distanceSquared <= p2.distanceSquared) hi = m2;
    else lo = m1;
  }

  const refined = projectionOnGridRow(model, (lo + hi) / 2, p);
  best = betterGridProjection(best, refined, 0.01);

  return {
    i: best.u * model.columns,
    j: best.row,
    elevation: p.elevation
  };
}

function screenPointToPerspectiveGridRaw(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = getPointXY(point);
  const model = getPerspectiveGridModel(config, rect);
  const coords = solveVisualGridCoordinates(model, p);
  coords.elevation = p.elevation;
  return coords;
}

export function getPerspectiveCellScreenHeightAtRow(row, config = getLevelConfig(), rect = getSceneRect()) {
  const model = getPerspectiveGridModel(config, rect);
  const safeRow = Number.isFinite(Number(row)) ? Number(row) : 0;
  const p0 = perspectiveGridModelToScreen(model, model.columns / 2, safeRow);
  const p1 = perspectiveGridModelToScreen(model, model.columns / 2, safeRow + 1);
  const height = Math.hypot(Number(p1.x) - Number(p0.x), Number(p1.y) - Number(p0.y));
  return Number.isFinite(height) && height > 0.0001 ? height : Math.max(1, rect.gridSize * 0.25);
}

export function elevationToScreenOffsetAtRow(elevation, row, config = getLevelConfig(), rect = getSceneRect()) {
  const e = Number(elevation) || 0;
  if (Math.abs(e) < 0.0001) return 0;

  const gridDistance = Math.max(0.0001, getSceneGridDistance());
  const spaces = e / gridDistance;

  // Elevation is stored in real scene distance units. Convert it to grid
  // spaces with the active scene Grid -> Distance. gridScale is visual-only
  // here; one perspective row still represents one Foundry grid space.
  return spaces * getPerspectiveCellScreenHeightAtRow(row, config, rect);
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
