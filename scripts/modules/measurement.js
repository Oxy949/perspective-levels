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
    if (value === null || value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return globalThis.CONST?.GRID_DIAGONALS?.EQUIDISTANT ?? 0;
}

function alternatingDiagonalSpaces(major, middle, minor, previous, secondFirst) {
  const offset = secondFirst ? 1 : 0;
  const before = (Number(previous) || 0) + offset * 1.5;
  return major + Math.floor((before + middle + minor * 0.5) / 2) - Math.floor(before / 2);
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
      return straight + diagonals * Math.SQRT2;
    case DIAG.APPROXIMATE:
      return straight + (diagonals * 1.5);
    case DIAG.RECTILINEAR:
    case DIAG.ILLEGAL:
      return absX + absY;
    case DIAG.ALTERNATING_1:
      return alternatingDiagonalSpaces(Math.max(absX, absY), diagonals, 0, 0, false);
    case DIAG.ALTERNATING_2:
      return alternatingDiagonalSpaces(Math.max(absX, absY), diagonals, 0, 0, true);
    case DIAG.EQUIDISTANT:
    default:
      return straight + diagonals;
  }
}


export function squareGridDistanceSpaces3D(dx, dy, dz, previousDiagonals = 0) {
  const axes = [Math.abs(Number(dx) || 0), Math.abs(Number(dy) || 0), Math.abs(Number(dz) || 0)].sort((a, b) => a - b);
  const [minor, middle, major] = axes;
  const mode = getSquareDiagonalMode();
  const DIAG = globalThis.CONST?.GRID_DIAGONALS ?? {};

  switch (mode) {
    case DIAG.EXACT:
      return major + (Math.SQRT2 - 1) * (middle - minor) + (Math.sqrt(3) - 1) * minor;
    case DIAG.APPROXIMATE:
      return major + 0.5 * (middle - minor) + 0.75 * minor;
    case DIAG.RECTILINEAR:
    case DIAG.ILLEGAL:
      return minor + middle + major;
    case DIAG.ALTERNATING_1:
      return alternatingDiagonalSpaces(major, middle, minor, previousDiagonals, false);
    case DIAG.ALTERNATING_2:
      return alternatingDiagonalSpaces(major, middle, minor, previousDiagonals, true);
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
    if (value === null || value === undefined || value === "") continue;
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
  const width = firstFiniteNumber(token?.w, document?.width ? document.width * rect.gridSize : undefined, token?.width, rect.gridSize);
  const height = firstFiniteNumber(token?.h, document?.height ? document.height * rect.gridSize : undefined, token?.height, rect.gridSize);
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  return { x, y, width, height };
}

function getTokenBottomCenter(token, rect = getSceneRect()) {
  const tokenRect = getTokenRect(token, rect);
  if (!tokenRect) return null;
  return {
    x: tokenRect.x + tokenRect.width / 2,
    y: tokenRect.y + tokenRect.height
  };
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
    if (a.controlled !== b.controlled) return a.controlled - b.controlled;
    if (a.targeted !== b.targeted) return a.targeted - b.targeted;
    if (Math.abs(a.distanceToCenter - b.distanceToCenter) > 0.0001) return a.distanceToCenter - b.distanceToCenter;

    // Keep elevation only as a final tie-breaker. When a ground token stands
    // under a flying token, choosing "highest token under the point" can make
    // A->B and B->A disagree depending on which side supplied the waypoint.
    return b.elevation - a.elevation;
  });

  return candidates[0]?.token ?? null;
}

function getExplicitWaypointElevation(point) {
  if (!point || typeof point !== "object") return undefined;

  for (const key of ["elevation", "z", "k"]) {
    if (Object.hasOwn(point, key)) {
      if (point[key] === null || point[key] === undefined || point[key] === "") continue;
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
  const token = getWaypointTokenCandidate(point) ?? (explicitElevation === undefined ? findTokenAtWaypoint(point, rect) : null);
  const tokenElevation = getTokenElevation(token);

  // Foundry/system range checks may pass endpoint elevations derived from a
  // center point or from the other side of the measurement. For token endpoints
  // the TokenDocument elevation is the authoritative bottom elevation, including
  // zero for creatures standing on the grid.
  if (Number.isFinite(tokenElevation)) {
    p.elevation = tokenElevation;

    // Elevated tokens store their canvas position as the drawn visual point.
    // Use the token bottom instead of an arbitrary center/hover waypoint so the
    // projection inverse recovers the same ground cell that the shadow uses.
    if (Math.abs(tokenElevation) > 0.0001) {
      const tokenPoint = getTokenBottomCenter(token, rect);
      if (tokenPoint) {
        p.x = tokenPoint.x;
        p.y = tokenPoint.y;
      }
    }
  } else if (Number.isFinite(explicitElevation)) {
    p.elevation = explicitElevation;
  }

  return p;
}

export function perspectiveDistanceBetween(a, b, config = getLevelConfig(), rect = getSceneRect(), previousDiagonals = 0) {
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

  const distanceSpaces = squareGridDistanceSpaces3D(dxGridCells, dyGridCells, dzGridCells, previousDiagonals);
  const euclideanSpaces = Math.hypot(dxGridCells, dyGridCells, dzGridCells);
  const diagonalAxes = [Math.abs(dxGridCells), Math.abs(dyGridCells), Math.abs(dzGridCells)].sort((a, b) => a - b);

  return {
    distance: distanceSpaces * gridDistance,
    euclidean: euclideanSpaces * gridDistance,
    cost: distanceSpaces * gridDistance,
    spaces: getSquareDiagonalMode() === globalThis.CONST?.GRID_DIAGONALS?.ILLEGAL
      ? diagonalAxes.reduce((sum, axis) => sum + axis, 0) : diagonalAxes[2],
    diagonals: getSquareDiagonalMode() === globalThis.CONST?.GRID_DIAGONALS?.ILLEGAL ? 0 : diagonalAxes[1],
    diagonalWeight: diagonalAxes[1] + diagonalAxes[0] * 0.5
  };
}

export function buildPerspectiveMeasurement(waypoints, config = getLevelConfig(), rect = getSceneRect()) {
  const points = safeArray(waypoints);
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
  let diagonalWeight = 0;

  for (let i = 1; i < points.length; i++) {
    const measurement = points[i]?.measure === false
      ? { distance: 0, euclidean: 0, cost: 0, spaces: 0, diagonals: 0, diagonalWeight: 0 }
      : perspectiveDistanceBetween(points[i - 1], points[i], config, rect, diagonalWeight);
    diagonalWeight += measurement.diagonalWeight;
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
