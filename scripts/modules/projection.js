import { getRuntimeLevelConfig as getLevelConfig } from "./config.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { clamp } from "./utils.js";

const RUNTIME_GRID_MODELS = new WeakMap();

export function getCachedPerspectiveGridModel(config = getLevelConfig(), rect = getSceneRect()) {
  // Mutable configurations (including calibrator drafts and API arguments) must
  // always be recalculated. Runtime settings are immutable snapshots.
  if (!Object.isFrozen(config) || !Object.isFrozen(config.far) || !Object.isFrozen(config.near)) {
    return getPerspectiveGridModel(config, rect);
  }
  const key = [rect.x, rect.y, rect.width, rect.height, rect.gridSize].join("|");
  const cached = RUNTIME_GRID_MODELS.get(config);
  if (cached?.key === key) return cached.model;
  const model = getPerspectiveGridModel(config, { ...rect });
  for (const line of [model.far, model.near]) {
    Object.freeze(line.center); Object.freeze(line.left); Object.freeze(line.right); Object.freeze(line);
  }
  Object.freeze(model.rect); Object.freeze(model);
  RUNTIME_GRID_MODELS.set(config, { key, model });
  return model;
}

export function anchorToPoint(anchor, rect = getSceneRect()) {
  return {
    x: rect.x + anchor.x * rect.width,
    y: rect.y + anchor.y * rect.height
  };
}

export function pointToAnchor(point, rect = getSceneRect()) {
  return {
    x: (point.x - rect.x) / rect.width,
    y: (point.y - rect.y) / rect.height
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

export function scaleForPerspectivePoint(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  model ??= getCachedPerspectiveGridModel(config, rect);
  const coords = screenPointToPerspectiveGridRaw(point, config, rect, model);
  const t = clamp(coords.j / Math.max(1, model.rows), 0, 1);
  return config.far.scale + (config.near.scale - config.far.scale) * t;
}

export function scaleForPerspectiveToken(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  // gridScale controls the visible size of one perspective cell in pixels.
  // Token scaling must follow it too: when all calibration values are 1:1,
  // a normal 1x1 Foundry token should visually occupy exactly one drawn
  // perspective cell. Distance math stays cell-based elsewhere.
  const cellVisualScale = clamp(config.gridScale ?? 1, 0.1, 8);
  return scaleForPerspectivePoint(point, config, rect, model) * cellVisualScale;
}

export function scaleForY(y, config = getLevelConfig(), rect = getSceneRect()) {
  const model = getCachedPerspectiveGridModel(config, rect);
  return scaleForPerspectivePoint({ x: model.near.center.x, y, elevation: 0 }, config, rect, model);
}

export function getElevation(point) {
  const candidates = [point?.elevation, point?.z, point?.k];
  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;
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
  const corners = [far.left, far.right, near.right, near.left];
  const turns = corners.map((a, index) => {
    const b = corners[(index + 1) % 4], c = corners[(index + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });

  return {
    rect,
    cellSize,
    rows,
    columns,
    baseWidth,
    far,
    near,
    convex: turns.every(turn => turn > 0.000001) || turns.every(turn => turn < -0.000001),
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
  const clampedRawT = clamp(rawT, -100, 100);
  const easedT = clampedRawT >= 0
    ? Math.pow(Math.max(0, clampedRawT), model.curve)
    : -Math.pow(Math.abs(clampedRawT), model.curve);

  const u = model.columns > 0 ? column / model.columns : 0;
  if (easedT < 0 || easedT > 1) {
    // Extend the end plane without letting its width invert past a vanishing
    // point. Flyers above the far edge must keep a continuous ground inverse.
    const line = easedT < 0 ? model.far : model.near;
    const delta = easedT < 0 ? easedT : easedT - 1;
    return { x: lerp(line.left.x, line.right.x, u) + (model.near.center.x - model.far.center.x) * delta,
      y: lerp(line.left.y, line.right.y, u) + (model.near.center.y - model.far.center.y) * delta };
  }
  const left = lerpPoint(model.far.left, model.near.left, easedT);
  const right = lerpPoint(model.far.right, model.near.right, easedT);

  return {
    x: lerp(left.x, right.x, u),
    y: lerp(left.y, right.y, u)
  };
}

export function perspectiveGridToScreen(column, row, config = getLevelConfig(), rect = getSceneRect()) {
  return perspectiveGridModelToScreen(getCachedPerspectiveGridModel(config, rect), column, row);
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

  for (let i = 0; i < 20; i++) {
    const left = lerpPoint(model.far.left, model.near.left, t);
    const right = lerpPoint(model.far.right, model.near.right, t);
    const width = subtractPoint(right, left);
    const widthLenSq = width.x * width.x + width.y * width.y;
    if (widthLenSq > 0.0001) {
      u = ((p.x - left.x) * width.x + (p.y - left.y) * width.y) / widthLenSq;
    }

    const current = bilinearPoint(model, t, u);
    const fx = current.x - p.x;
    const fy = current.y - p.y;
    if (Math.hypot(fx, fy) < 0.0000001) break;

    const dLeft = subtractPoint(model.near.left, model.far.left);
    const dRight = subtractPoint(model.near.right, model.far.right);
    const dWidth = subtractPoint(dRight, dLeft);
    const dt = { x: dLeft.x + dWidth.x * u, y: dLeft.y + dWidth.y * u };
    const du = width;

    const det = dt.x * du.y - du.x * dt.y;
    if (Math.abs(det) < 0.000001) break;

    const deltaT = (fx * du.y - du.x * fy) / det;
    const deltaU = (dt.x * fy - fx * dt.y) / det;
    t = clamp(t - deltaT, -100, 100);
    u -= deltaU;
  }

  return { t, u };
}

function projectionOnGridRow(model, row, point) {
  const left = perspectiveGridModelToScreen(model, 0, row);
  const right = perspectiveGridModelToScreen(model, model.columns, row);
  const width = subtractPoint(right, left);
  const widthLenSq = Math.max(0.0001, width.x * width.x + width.y * width.y);
  const rawU = ((point.x - left.x) * width.x + (point.y - left.y) * width.y) / widthLenSq;

  // Sideways extensions keep their actual coordinate instead of clamping the
  // token to a different cell when it is far from the drawn strip.
  const u = rawU;
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
  const seed = solveBilinearCoordinates(model, p);
  const seedT = Math.abs(seed.t) < 1e-10 ? 0 : (Math.abs(seed.t - 1) < 1e-10 ? 1 : seed.t);
  const seedRow = Math.sign(seedT) * Math.pow(Math.abs(seedT), 1 / model.curve) * model.rows;
  const seedProjection = Number.isFinite(seedRow) ? projectionOnGridRow(model, seedRow, p) : null;
  // Convex grids have one inverse inside their borders. Avoid hundreds of row
  // samples for every token/elevation refresh in this common case.
  if (model.convex && seedT >= 0 && seedT <= 1 && seed.u >= 0 && seed.u <= 1
    && seedProjection?.distanceSquared < 0.0000000001) {
    return { i: seedProjection.u * model.columns, j: seedRow, elevation: p.elevation };
  }
  if (model.convex) {
    const axis = subtractPoint(model.near.center, model.far.center);
    for (const [line, end] of [[model.far, 0], [model.near, 1]]) {
      const width = subtractPoint(line.right, line.left), relative = subtractPoint(p, line.left);
      const det = axis.x * width.y - axis.y * width.x;
      if (Math.abs(det) < 1e-8) continue;
      const delta = (relative.x * width.y - relative.y * width.x) / det;
      if ((end === 0 && delta >= 0) || (end === 1 && delta <= 0)) continue;
      const t = delta + end;
      const u = (axis.x * relative.y - axis.y * relative.x) / det;
      return { i: u * model.columns, j: Math.sign(t) * Math.pow(Math.abs(t), 1 / model.curve) * model.rows,
        elevation: p.elevation };
    }
    if (seedT >= 0 && seedT <= 1 && seedProjection?.distanceSquared < 1e-10) {
      return { i: seedProjection.u * model.columns, j: seedRow, elevation: p.elevation };
    }
  }
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

  // The drawn anchors are not scene boundaries. Use the bilinear inverse to
  // recover fractional rows and extensions outside them (keyboard movement and
  // rulers must not get stuck at the first/last drawn row).
  const row = seedRow;
  if (Number.isFinite(row) && Math.abs(row) <= model.rows * 10) {
    const candidate = seedProjection;
    if (row >= 0 && row <= model.rows) best = betterGridProjection(best, candidate, 0.00000001);
    else if (candidate.distanceSquared < best.distanceSquared - 0.0000000001) best = candidate;
  }

  return {
    i: best.u * model.columns,
    j: best.row,
    elevation: p.elevation
  };
}

function screenPointToPerspectiveGridRaw(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  const p = getPointXY(point);
  model ??= getCachedPerspectiveGridModel(config, rect);
  const coords = solveVisualGridCoordinates(model, p);
  coords.elevation = p.elevation;
  return coords;
}

export function getPerspectiveCellScreenHeightAtRow(row, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  model ??= getCachedPerspectiveGridModel(config, rect);
  const safeRow = Number.isFinite(Number(row)) ? Number(row) : 0;
  const p0 = perspectiveGridModelToScreen(model, model.columns / 2, safeRow);
  const p1 = perspectiveGridModelToScreen(model, model.columns / 2, safeRow + 1);
  const height = Math.hypot(Number(p1.x) - Number(p0.x), Number(p1.y) - Number(p0.y));
  return Number.isFinite(height) && height > 0.0001 ? height : Math.max(1, rect.gridSize * 0.25);
}

export function elevationToScreenOffsetAtRow(elevation, row, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  const e = Number(elevation) || 0;
  if (Math.abs(e) < 0.0001) return 0;

  const gridDistance = Math.max(0.0001, getSceneGridDistance());
  const spaces = e / gridDistance;

  model ??= getCachedPerspectiveGridModel(config, rect);
  // Integrate across the displaced rows instead of extrapolating one cell's
  // local derivative for the entire altitude. The latter folds near the far
  // anchor on curved grids, giving several ground positions for one flyer.
  const ground = perspectiveGridModelToScreen(model, model.columns / 2, row);
  const raised = perspectiveGridModelToScreen(model, model.columns / 2, row - spaces);
  return ground.y - raised.y;
}

export function screenPointToElevationGroundPoint(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  const p = getPointXY(point);
  if (Math.abs(p.elevation) < 0.0001) return p;
  model ??= getCachedPerspectiveGridModel(config, rect);

  // Altitude displaces a continuous row coordinate, not an extrapolated local
  // cell derivative. Inverting this translation avoids unstable Newton roots.
  const visual = screenPointToPerspectiveGridRaw({ ...p, elevation: 0 }, config, rect, model);
  const groundRow = visual.j + p.elevation / getSceneGridDistance();
  return { ...pointOnGridRowAtX(model, groundRow, p.x), elevation: p.elevation };
}

function pointOnGridRowAtX(model, row, x) {
  const left = perspectiveGridModelToScreen(model, 0, row);
  const right = perspectiveGridModelToScreen(model, model.columns, row);
  const dx = right.x - left.x;
  const u = Math.abs(dx) > 1e-8 ? (x - left.x) / dx : 0.5;
  return { x, y: left.y + (right.y - left.y) * u };
}

export function perspectiveGroundPointToElevatedScreen(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  const p = getPointXY(point);
  if (Math.abs(p.elevation) < 0.0001) return p;
  model ??= getCachedPerspectiveGridModel(config, rect);

  const coords = screenPointToPerspectiveGridRaw({ x: p.x, y: p.y, elevation: 0 }, config, rect, model);
  return { ...pointOnGridRowAtX(model, coords.j - p.elevation / getSceneGridDistance(), p.x), elevation: p.elevation };
}

export function screenPointToPerspectiveGrid(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  model ??= getCachedPerspectiveGridModel(config, rect);
  const p = screenPointToElevationGroundPoint(point, config, rect, model);
  const coords = screenPointToPerspectiveGridRaw(p, config, rect, model);
  coords.elevation = p.elevation;
  return coords;
}

export function screenPointToPerspectiveGround(point, config = getLevelConfig(), rect = getSceneRect(), model = null) {
  const coords = screenPointToPerspectiveGrid(point, config, rect, model);
  return {
    x: coords.i * rect.gridSize,
    y: coords.j * rect.gridSize,
    elevation: coords.elevation
  };
}
