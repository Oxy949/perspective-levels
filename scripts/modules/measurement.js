import { getLevelConfig } from "./config.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { getPointXY, screenPointToPerspectiveGrid } from "./projection.js";
import { safeArray } from "./utils.js";

function getSquareDiagonalMode() {
  let worldDefault;
  try { worldDefault = globalThis.game?.settings?.get?.("core", "gridDiagonals"); }
  catch (_err) { worldDefault = undefined; }

  const canvasRef = globalThis.canvas;
  const candidates = [
    canvasRef?.scene?.grid?.diagonals,
    canvasRef?.grid?.diagonals,
    worldDefault
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return globalThis.CONST?.GRID_DIAGONALS?.EQUIDISTANT ?? 0;
}

function alternatingDiagonalSpaces(diagonals, firstCost) {
  const whole = Math.floor(Math.max(0, diagonals));
  const fraction = Math.max(0, diagonals - whole);
  let cost = 0;

  for (let i = 0; i < whole; i++) cost += (i % 2 === 0) ? firstCost : (3 - firstCost);
  if (fraction > 0) cost += fraction * ((whole % 2 === 0) ? firstCost : (3 - firstCost));

  return cost;
}

export function squareGridDistanceSpaces(dx, dy) {
  const absX = Math.abs(Number(dx) || 0);
  const absY = Math.abs(Number(dy) || 0);
  const diagonals = Math.min(absX, absY);
  const straight = Math.max(absX, absY) - diagonals;
  const mode = getSquareDiagonalMode();
  const DIAG = globalThis.CONST?.GRID_DIAGONALS ?? {};

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
      return straight + diagonals;
  }
}


export function squareGridDistanceSpaces3D(dx, dy, dz) {
  const axes = [Math.abs(Number(dx) || 0), Math.abs(Number(dy) || 0), Math.abs(Number(dz) || 0)].sort((a, b) => a - b);
  const [minor, middle, major] = axes;
  const mode = getSquareDiagonalMode();
  const DIAG = globalThis.CONST?.GRID_DIAGONALS ?? {};

  switch (mode) {
    case DIAG.EXACT:
      return Math.hypot(minor, middle, major);
    case DIAG.APPROXIMATE:
      return (major - middle) + (middle * 1.5);
    case DIAG.RECTILINEAR:
    case DIAG.ILLEGAL:
      return minor + middle + major;
    case DIAG.ALTERNATING_1:
      return (major - middle) + alternatingDiagonalSpaces(middle, 1);
    case DIAG.ALTERNATING_2:
      return (major - middle) + alternatingDiagonalSpaces(middle, 2);
    case DIAG.EQUIDISTANT:
    default:
      return major;
  }
}


function roundGridCellCoordinate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  // Foundry grid measurements are cell-based: tiny floating point drift from
  // inverse projection must not turn a 6-cell move into 5.999 or 6.001 cells.
  return Math.round(n + Math.sign(n) * Number.EPSILON);
}

function snapPerspectiveGridToCells(coords) {
  return {
    ...coords,
    i: roundGridCellCoordinate(coords?.i),
    j: roundGridCellCoordinate(coords?.j)
  };
}

function roundElevationToGridCells(elevationDelta, gridDistance) {
  const raw = (Number(elevationDelta) || 0) / Math.max(0.0001, Number(gridDistance) || 1);
  return roundGridCellCoordinate(raw);
}

function isFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n);
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function getWaypointTokenCandidate(point) {
  if (!point || typeof point !== "object") return null;
  const candidates = [
    point.token,
    point.object,
    point.placeable,
    point.preview,
    point.source,
    point.subject,
    point.document?.object
  ];

  for (const candidate of candidates) {
    if (candidate?.document?.documentName === "Token" || candidate?.documentName === "Token") return candidate;
    if (candidate?.document?.constructor?.name === "TokenDocument") return candidate;
  }

  const id = point.tokenId ?? point.tokenID ?? point.id ?? point._id ?? point.document?._id ?? point.document?.id;
  if (id && globalThis.canvas?.tokens?.placeables) {
    const match = globalThis.canvas.tokens.placeables.find(token => token?.id === id || token?.document?.id === id);
    if (match) return match;
  }

  return null;
}

function getTokenElevation(token) {
  return firstFiniteNumber(token?.document?.elevation, token?.elevation);
}

function getTokenRect(token, rect = getSceneRect()) {
  const document = token?.document ?? token;
  const x = firstFiniteNumber(token?.x, token?.position?.x, document?.x);
  const y = firstFiniteNumber(token?.y, token?.position?.y, document?.y);
  const width = firstFiniteNumber(token?.w, token?.width, document?.width ? document.width * rect.gridSize : undefined, rect.gridSize);
  const height = firstFiniteNumber(token?.h, token?.height, document?.height ? document.height * rect.gridSize : undefined, rect.gridSize);
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  return { x, y, width, height };
}

function pointInsideTokenRect(point, token, rect = getSceneRect()) {
  const tokenRect = getTokenRect(token, rect);
  if (!tokenRect) return false;

  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  // Ruler endpoints are usually token centers, but some systems feed bottom or
  // snapped grid points. Keep a small margin so scaled/elevated tokens are still
  // detected without grabbing unrelated tokens across the scene.
  const margin = Math.max(2, rect.gridSize * 0.1);
  return x >= tokenRect.x - margin
    && x <= tokenRect.x + tokenRect.width + margin
    && y >= tokenRect.y - margin
    && y <= tokenRect.y + tokenRect.height + margin;
}

function findTokenAtWaypoint(point, rect = getSceneRect()) {
  const direct = getWaypointTokenCandidate(point);
  if (direct) return direct;

  const placeables = globalThis.canvas?.tokens?.placeables;
  if (!Array.isArray(placeables) || !placeables.length) return null;

  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const candidates = [];
  for (const token of placeables) {
    if (!token || token.destroyed || !pointInsideTokenRect(point, token, rect)) continue;
    const tokenRect = getTokenRect(token, rect);
    if (!tokenRect) continue;

    const centerX = tokenRect.x + tokenRect.width / 2;
    const centerY = tokenRect.y + tokenRect.height / 2;
    const distanceToCenter = Math.hypot(x - centerX, y - centerY);
    const elevation = Math.abs(Number(getTokenElevation(token)) || 0);
    const controlled = token.controlled ? 0 : 1;
    const targeted = token.targeted?.size ? 0 : 1;
    candidates.push({ token, elevation, controlled, targeted, distanceToCenter });
  }

  candidates.sort((a, b) => {
    // Prefer elevated tokens: the bug this solves is mostly the target side of
    // a flying token, where Foundry often supplies a zero-elevation waypoint.
    if (Math.abs(b.elevation - a.elevation) > 0.0001) return b.elevation - a.elevation;
    if (a.controlled !== b.controlled) return a.controlled - b.controlled;
    if (a.targeted !== b.targeted) return a.targeted - b.targeted;
    return a.distanceToCenter - b.distanceToCenter;
  });

  return candidates[0]?.token ?? null;
}

function getExplicitWaypointElevation(point) {
  if (!point || typeof point !== "object") return undefined;

  for (const key of ["elevation", "z", "k"]) {
    if (Object.hasOwn(point, key)) {
      const n = Number(point[key]);
      if (Number.isFinite(n)) return n;
    }
  }

  return firstFiniteNumber(
    point.document?.elevation,
    point.object?.document?.elevation,
    point.placeable?.document?.elevation,
    point.token?.document?.elevation
  );
}

function normalizeMeasurementWaypoint(point, config = getLevelConfig(), rect = getSceneRect()) {
  const p = getPointXY(point);
  const explicitElevation = getExplicitWaypointElevation(point);
  const token = findTokenAtWaypoint(point, rect);
  const tokenElevation = getTokenElevation(token);

  // Foundry/system range checks may pass target waypoints with elevation: 0 even
  // when the point is visibly inside an elevated token. In perspective mode that
  // makes A->B and B->A produce different ranges. Treat non-zero TokenDocument
  // elevation as the authoritative 3D height for token endpoints.
  if (Number.isFinite(tokenElevation) && Math.abs(tokenElevation) > 0.0001) {
    p.elevation = tokenElevation;
  } else if (Number.isFinite(explicitElevation)) {
    p.elevation = explicitElevation;
  }

  return p;
}

export function perspectiveDistanceBetween(a, b, config = getLevelConfig(), rect = getSceneRect()) {
  const paRaw = screenPointToPerspectiveGrid(normalizeMeasurementWaypoint(a, config, rect), config, rect);
  const pbRaw = screenPointToPerspectiveGrid(normalizeMeasurementWaypoint(b, config, rect), config, rect);
  const pa = snapPerspectiveGridToCells(paRaw);
  const pb = snapPerspectiveGridToCells(pbRaw);
  const gridDistance = getSceneGridDistance();

  // i/j are coordinates in drawn perspective-grid squares. Measurements should
  // behave like Foundry square-grid measurements: endpoints are snapped to the
  // nearest perspective cell first, then diagonal rules are applied to integer
  // cell deltas. Without this, inverse projection produces fractional cells and
  // ranges drift around thresholds like 29.6 ft / 30.4 ft.
  const dxGridCells = pb.i - pa.i;
  const dyGridCells = pb.j - pa.j;

  // Elevation is stored in real scene units. Convert it to grid spaces and snap
  // to the nearest cell as well, so 3D distance is symmetric and cell-based.
  const dzGridCells = roundElevationToGridCells(pb.elevation - pa.elevation, gridDistance);

  const distanceSpaces = squareGridDistanceSpaces3D(dxGridCells, dyGridCells, dzGridCells);
  const euclideanSpaces = Math.hypot(dxGridCells, dyGridCells, dzGridCells);
  const diagonalAxes = [Math.abs(dxGridCells), Math.abs(dyGridCells), Math.abs(dzGridCells)].sort((a, b) => a - b);

  return {
    distance: distanceSpaces * gridDistance,
    euclidean: euclideanSpaces * gridDistance,
    cost: distanceSpaces * gridDistance,
    spaces: distanceSpaces,
    diagonals: diagonalAxes[1] ?? 0
  };
}

export function buildPerspectiveMeasurement(waypoints, config = getLevelConfig(), rect = getSceneRect()) {
  const points = safeArray(waypoints).map(point => normalizeMeasurementWaypoint(point, config, rect));
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
    waypoints: measuredWaypoints,
    _perspectiveLevels: true
  };
}

export function mergePerspectiveMeasurement(baseResult, perspectiveResult) {
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

export function applyPerspectiveMeasurement(baseResult, waypoints, config = getLevelConfig(), rect = getSceneRect()) {
  const points = safeArray(waypoints);
  if (points.length < 2) return baseResult;
  return mergePerspectiveMeasurement(baseResult, buildPerspectiveMeasurement(points, config, rect));
}
