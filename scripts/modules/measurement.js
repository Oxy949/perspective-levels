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

export function perspectiveDistanceBetween(a, b, config = getLevelConfig(), rect = getSceneRect()) {
  const pa = screenPointToPerspectiveGrid(a, config, rect);
  const pb = screenPointToPerspectiveGrid(b, config, rect);
  const gridDistance = getSceneGridDistance();

  const dxCells = pb.i - pa.i;
  const dyCells = pb.j - pa.j;
  
  // Convert perspective grid cells to regular grid cells using gridScale
  const gridScale = Math.max(0.1, Number(config.gridScale) || 1);
  const dxGridCells = dxCells / gridScale;
  const dyGridCells = dyCells / gridScale;
  
  const horizontalSpaces = squareGridDistanceSpaces(dxGridCells, dyGridCells);
  const euclideanSpaces = Math.hypot(dxGridCells, dyGridCells);
  const horizontalDistance = horizontalSpaces * gridDistance;
  const euclideanDistance = euclideanSpaces * gridDistance;

  const dz = Number(pb.elevation - pa.elevation) || 0;
  const hasElevation = Math.abs(dz) > 0.0001;

  return {
    distance: hasElevation ? Math.hypot(horizontalDistance, dz) : horizontalDistance,
    euclidean: hasElevation ? Math.hypot(euclideanDistance, dz) : euclideanDistance,
    cost: hasElevation ? Math.hypot(horizontalDistance, dz) : horizontalDistance,
    spaces: horizontalSpaces,
    diagonals: Math.min(Math.abs(dxGridCells), Math.abs(dyGridCells))
  };
}

export function buildPerspectiveMeasurement(waypoints, config = getLevelConfig(), rect = getSceneRect()) {
  const points = safeArray(waypoints).map(getPointXY);
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
