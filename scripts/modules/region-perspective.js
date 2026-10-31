import { getRuntimeLevelConfig } from "./config.js";
import { getSceneRect } from "./scene.js";
import { getCachedPerspectiveGridModel, perspectiveGridModelToScreen, screenPointToPerspectiveGrid,
  screenPointToElevationGroundPoint, perspectiveGroundPointToElevatedScreen } from "./projection.js";
import { withNativeGridMeasurements } from "./measurement-patches.js";

const NATIVE_SHAPES = new WeakSet();
const METRIC_SHAPES = ["RectangleShapeData", "CircleShapeData", "EllipseShapeData", "ConeShapeData", "RingShapeData", "LineShapeData"];
let coverageDepth = 0;
let regionRefreshTimer = null;
let lastRegionSignature = null;
let lastRegionScene = null;
let regionRefreshGeneration = 0;
let regionWrites = Promise.resolve();

function context(document = null) {
  if (!globalThis.canvas?.ready) return null;
  const config = getRuntimeLevelConfig();
  if (!config.enabled) return null;
  const scene = document?.scene ?? document?.parent;
  if (scene && scene !== globalThis.canvas.scene) return null;
  if (document?.includedInLevel && !document.includedInLevel(globalThis.canvas.level?.id)) return null;
  const rect = getSceneRect();
  return { config, rect, model: getCachedPerspectiveGridModel(config, rect) };
}

function toGround(point, ctx) {
  const coords = screenPointToPerspectiveGrid({ ...point, elevation: 0 }, ctx.config, ctx.rect, ctx.model);
  return { x: ctx.rect.x + coords.i * ctx.rect.gridSize, y: ctx.rect.y + coords.j * ctx.rect.gridSize };
}

function toScreen(point, ctx) {
  return perspectiveGridModelToScreen(ctx.model,
    (point.x - ctx.rect.x) / ctx.rect.gridSize, (point.y - ctx.rect.y) / ctx.rect.gridSize);
}

export function projectShapePath(points, origin, config = getRuntimeLevelConfig(), rect = getSceneRect()) {
  const ctx = { config, rect, model: getCachedPerspectiveGridModel(config, rect) };
  const anchor = toGround(origin, ctx);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const steps = Math.max(1, Math.min(128, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (rect.gridSize / 2))));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      out.push(toScreen({ x: anchor.x + a.x + (b.x - a.x) * t - origin.x,
        y: anchor.y + a.y + (b.y - a.y) * t - origin.y }, ctx));
    }
  }
  return out;
}

function projectGeometry(result, origin, ctx) {
  const factor = globalThis.CONST?.CLIPPER_SCALING_FACTOR ?? 100;
  if (Array.isArray(result)) {
    if (!result.length) return [];
    if (typeof result[0] === "number") {
      const points = [];
      for (let i = 0; i < result.length; i += 2) points.push({ x: result[i], y: result[i + 1] });
      return projectShapePath(points, origin, ctx.config, ctx.rect).flatMap(p => [p.x, p.y]);
    }
    const clipper = "X" in result[0];
    const points = result.map(p => clipper ? { x: p.X / factor, y: p.Y / factor } : p);
    const projected = projectShapePath(points, origin, ctx.config, ctx.rect);
    return clipper ? projected.map(p => ({ X: Math.round(p.x * factor), Y: Math.round(p.y * factor) })) : projected;
  }
  // This is a fresh native tree, so holes and winding order can be preserved.
  const walk = node => {
    const contour = node.Contour?.();
    if (contour?.length) contour.splice(0, contour.length, ...projectGeometry(contour, origin, ctx));
    for (const child of node.Childs?.() ?? []) walk(child);
  };
  if (result?.Childs) walk(result);
  return result;
}

function wrap(proto, key, handler) {
  const original = proto?.[key];
  if (typeof original !== "function" || original._perspectiveLevelsRegionWrapped) return;
  const wrapped = function(...args) { return handler.call(this, original, args); };
  wrapped._perspectiveLevelsRegionWrapped = true;
  proto[key] = wrapped;
}

function shapeContext(shape) {
  return NATIVE_SHAPES.has(shape) ? null : context(shape.parent);
}

function nativeClone(shape) {
  const clone = shape.clone();
  NATIVE_SHAPES.add(clone);
  clone._onShapeChange?.();
  return clone;
}

function editInGroundPlane(shape, original, args, ctx, drag) {
  const clone = nativeClone(shape);
  const origin = toGround(shape.origin, ctx);
  clone.updateSource({ x: origin.x, y: origin.y });
  const transformed = [...args];
  if (drag) {
    const event = args[0];
    transformed[0] = { shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey,
      interactionData: { ...event.interactionData, origin: toGround(event.interactionData.origin, ctx),
        destination: toGround(event.interactionData.destination, ctx) } };
  } else transformed[1] = toGround(args[1], ctx);
  withNativeGridMeasurements(() => original.apply(clone, transformed));
  const data = clone.toObject();
  const position = toScreen({ x: data.x, y: data.y }, ctx);
  shape.updateSource({ ...data, x: position.x, y: position.y });
}

export function getPerspectiveCoveredCells(bounds, contains, config = getRuntimeLevelConfig(), rect = getSceneRect()) {
  const model = getCachedPerspectiveGridModel(config, rect);
  const corners = [];
  for (const dx of [0, 0.5, 1]) for (const dy of [0, 0.5, 1]) {
    corners.push(screenPointToPerspectiveGrid({ x: bounds.x + bounds.width * dx, y: bounds.y + bounds.height * dy }, config, rect, model));
  }
  const i0 = Math.floor(Math.min(...corners.map(p => p.i))), i1 = Math.ceil(Math.max(...corners.map(p => p.i)));
  const j0 = Math.floor(Math.min(...corners.map(p => p.j))), j1 = Math.ceil(Math.max(...corners.map(p => p.j)));
  if (![i0, i1, j0, j1].every(Number.isFinite) || (i1 - i0) * (j1 - j0) > 50000) return [];
  const cells = [];
  for (let row = j0; row < j1; row++) for (let col = i0; col < i1; col++) {
    const center = perspectiveGridModelToScreen(model, col + 0.5, row + 0.5);
    if (!contains(center)) continue;
    cells.push({ row, col, center, vertices: [[col, row], [col + 1, row], [col + 1, row + 1], [col, row + 1]]
      .map(([i, j]) => perspectiveGridModelToScreen(model, i, j)) });
  }
  return cells;
}

export function installRegionPerspectivePatches() {
  for (const name of METRIC_SHAPES) {
    const proto = globalThis.foundry?.data?.[name]?.prototype;
    if (!proto) continue;
    wrap(proto, "_createClipperPolyTree", function(original, args) {
      const ctx = shapeContext(this);
      if (!ctx) return original.apply(this, args);
      const clone = nativeClone(this);
      const native = withNativeGridMeasurements(() => original.apply(clone, args));
      return projectGeometry(native, this.origin, ctx);
    });
    wrap(proto, "drawShape", function(original, args) {
      if (!shapeContext(this)) return original.apply(this, args);
      return this.polygonTree.drawShape(args[0]);
    });
    wrap(proto, "drawReferenceLines", function(original, args) {
      if (!shapeContext(this)) return original.apply(this, args);
      for (const { ray } of this.measuredSegments) args[0].moveTo(ray.A.x, ray.A.y).lineTo(ray.B.x, ray.B.y);
    });
    for (const method of ["sampleInterior", "sampleBoundary"]) {
      wrap(proto, method, function(original, args) {
        const ctx = shapeContext(this);
        if (!ctx) return original.apply(this, args);
        const point = withNativeGridMeasurements(() => original.apply(nativeClone(this), args));
        const origin = this.origin, anchor = toGround(origin, ctx);
        const projected = toScreen({ x: anchor.x + point.x - origin.x, y: anchor.y + point.y - origin.y }, ctx);
        return Object.assign(point, projected);
      });
    }
    for (const method of ["_onDragMove", "moveControlHandle"]) {
      wrap(proto, method, function(original, args) {
        const ctx = shapeContext(this);
        if (!ctx) return original.apply(this, args);
        return editInGroundPlane(this, original, args, ctx, method === "_onDragMove");
      });
    }
    wrap(proto, "_getSnappedPoint", function(original, args) {
      const ctx = shapeContext(this);
      if (!ctx) return original.apply(this, args);
      return toScreen(original.call(nativeClone(this), toGround(args[0], ctx)), ctx);
    });
    for (const method of ["_createControlHandles", "_createMeasuredSegments"]) {
      wrap(proto, method, function(original, args) {
        const ctx = shapeContext(this);
        if (!ctx) return original.apply(this, args);
        const clone = nativeClone(this), origin = toGround(this.origin, ctx);
        clone.updateSource({ x: origin.x, y: origin.y });
        const data = withNativeGridMeasurements(() => original.apply(clone, args));
        if (method === "_createControlHandles") {
          for (const handle of Object.values(data)) if (handle.position) handle.position = toScreen(handle.position, ctx);
        } else {
          const Ray = globalThis.foundry?.canvas?.geometry?.Ray;
          for (const segment of data) {
            const a = toScreen(segment.ray.A, ctx), b = toScreen(segment.ray.B, ctx);
            segment.ray = Ray ? new Ray(a, b) : { A: a, B: b };
          }
        }
        return data;
      });
    }
  }
  const region = globalThis.foundry?.canvas?.placeables?.Region?.prototype;
  wrap(region, "_refreshShapes", function(original, args) {
    // Shape-control clones also cache their handles, even if the document's
    // shape fields did not change during a calibration update.
    for (const container of this.children ?? []) for (const control of container.children ?? []) control.shape?._onShapeChange?.();
    return original.apply(this, args);
  });
  wrap(region, "_draw", function(original, args) {
    const attach = result => {
      for (const child of this.children ?? []) {
        const hit = child.hitArea;
        if (typeof hit?.contains !== "function") continue;
        const native = hit.contains.bind(hit);
        hit.contains = (x, y) => {
          const ctx = context(this.document);
          if (!ctx) return native(x, y);
          if (this.animationState.polygonTree.testPoint({ x, y })) return true;
          if (this.document.highlightMode !== "coverage") return false;
          const coords = screenPointToPerspectiveGrid({ x, y }, ctx.config, ctx.rect, ctx.model);
          const center = perspectiveGridModelToScreen(ctx.model, Math.floor(coords.i) + 0.5, Math.floor(coords.j) + 0.5);
          return this.animationState.polygonTree.testPoint(center, 0.75);
        };
      }
      return result;
    };
    const result = original.apply(this, args);
    return result?.then ? result.then(attach) : attach(result);
  });
  wrap(region, "_refreshGeometry", function(original, args) {
    if (!context(this.document)) return original.apply(this, args);
    coverageDepth++;
    try { return original.apply(this, args); } finally { coverageDepth--; }
  });
  wrap(region, "_getCoveredGridSpaceOffsets", function(original, args) {
    const ctx = context(this.document);
    if (!ctx) return original.apply(this, args);
    const state = this.animationState;
    return getPerspectiveCoveredCells(state.bounds, p => state.polygonTree.testPoint(p, 0.75), ctx.config, ctx.rect)
      .map(cell => canvas.grid.getOffset({ x: ctx.rect.x + (cell.col + 0.5) * ctx.rect.gridSize,
        y: ctx.rect.y + (cell.row + 0.5) * ctx.rect.gridSize }));
  });
  const grid = globalThis.canvas?.grid;
  wrap(grid, "getVertices", function(original, args) {
    const points = original.apply(this, args), ctx = coverageDepth && context();
    return ctx ? points.map(point => toScreen(point, ctx)) : points;
  });
  const layer = globalThis.foundry?.canvas?.layers?.RegionLayer?.prototype;
  wrap(layer, "getSnappedPoint", function(original, args) {
    const ctx = context();
    if (!ctx) return original.apply(this, args);
    const modes = globalThis.CONST?.GRID_SNAPPING_MODES ?? {};
    return toScreen(canvas.grid.getSnappedPoint(toGround(args[0], ctx), {
      mode: canvas.forceSnapVertices ? modes.VERTEX : modes.CENTER | modes.VERTEX | modes.EDGE_MIDPOINT, resolution: 4 }), ctx);
  });
  installLegacyTemplatePatches();
  installTokenRegionPatches();
}

function regionTokenPosition(document, data, ctx, inverse = false) {
  const size = document.getSize(data);
  const elevation = data.elevation ?? 0;
  if (inverse) {
    const point = perspectiveGroundPointToElevatedScreen({ x: data.x + size.width / 2,
      y: data.y + size.height / 2, elevation }, ctx.config, ctx.rect, ctx.model);
    return { ...data, x: point.x - size.width / 2, y: point.y - size.height };
  }
  const point = screenPointToElevationGroundPoint({ x: data.x + size.width / 2,
    y: data.y + size.height, elevation }, ctx.config, ctx.rect, ctx.model);
  return { ...data, x: point.x - size.width / 2, y: point.y - size.height / 2 };
}

function installTokenRegionPatches() {
  const proto = globalThis.foundry?.documents?.TokenDocument?.prototype ?? globalThis.CONFIG?.Token?.documentClass?.prototype;
  wrap(proto, "testInsideRegion", function(original, [region, data = {}]) {
    const ctx = context(region);
    if (!ctx || this.parent !== canvas.scene) return original.call(this, region, data);
    return original.call(this, region, regionTokenPosition(this, { ...this._source, ...data }, ctx));
  });
  wrap(proto, "segmentizeRegionMovementPath", function(original, [region, waypoints]) {
    const ctx = context(region);
    if (!ctx || this.parent !== canvas.scene) return original.call(this, region, waypoints);
    let previous = this._source;
    const groundPath = waypoints.map(waypoint => {
      previous = { ...previous, ...waypoint };
      return regionTokenPosition(this, previous, ctx);
    });
    const segments = original.call(this, region, groundPath);
    const seen = new Set();
    for (const segment of segments) for (const point of [segment.from, segment.to]) {
      if (!point || seen.has(point)) continue;
      seen.add(point);
      Object.assign(point, regionTokenPosition(this, point, ctx, true));
    }
    return segments;
  });
}

function templatePoints(shape) {
  if (Array.isArray(shape?.points)) {
    if (typeof shape.points[0] !== "number") return shape.points;
    const points = [];
    for (let i = 0; i < shape.points.length; i += 2) points.push({ x: shape.points[i], y: shape.points[i + 1] });
    return points;
  }
  if (Number.isFinite(shape?.radius)) {
    return Array.from({ length: 64 }, (_, i) => ({ x: shape.x + Math.cos(i * Math.PI / 32) * shape.radius,
      y: shape.y + Math.sin(i * Math.PI / 32) * shape.radius }));
  }
  return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y },
    { x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height }];
}

function installLegacyTemplatePatches() {
  const proto = globalThis.foundry?.canvas?.placeables?.MeasuredTemplate?.prototype;
  wrap(proto, "_computeShape", function(original, args) {
    const ctx = context(this.document);
    const shape = withNativeGridMeasurements(() => original.apply(this, args));
    if (!ctx || !shape) return shape;
    const origin = { x: this.document.x, y: this.document.y };
    const points = templatePoints(shape).map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
    return new PIXI.Polygon(projectShapePath(points, origin, ctx.config, ctx.rect)
      .flatMap(p => [p.x - origin.x, p.y - origin.y]));
  });
  wrap(proto, "_refreshShape", function(original, args) {
    const result = original.apply(this, args), ctx = context(this.document);
    if (ctx && this.ray) {
      const origin = this.ray.A, anchor = toGround(origin, ctx);
      const end = toScreen({ x: anchor.x + this.ray.B.x - origin.x, y: anchor.y + this.ray.B.y - origin.y }, ctx);
      this.ray = new foundry.canvas.geometry.Ray(origin, end);
    }
    return result;
  });
  wrap(proto, "highlightGrid", function(original, args) {
    const ctx = context(this.document);
    if (!ctx || !this.shape?.points) return original.apply(this, args);
    const origin = this.document;
    const points = templatePoints(this.shape).map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    const bounds = { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
    const grid = canvas.interface.grid;
    grid.clearHighlightLayer(this.highlightId);
    const cells = getPerspectiveCoveredCells(bounds, p => this.shape.contains(p.x - origin.x, p.y - origin.y), ctx.config, ctx.rect);
    const polygons = cells.length ? cells.map(cell => cell.vertices) : [points];
    for (const polygon of polygons) grid.highlightPosition(this.highlightId, { border: this.document.borderColor,
      color: this.document.fillColor, shape: new PIXI.Polygon(polygon.flatMap(p => [p.x, p.y])) });
  });
}

export function refreshPerspectiveRegions() {
  const scene = globalThis.canvas?.scene, config = getRuntimeLevelConfig();
  const signature = regionGeometrySignature(config);
  if (lastRegionScene === scene && lastRegionSignature === signature) return;
  lastRegionScene = scene; lastRegionSignature = signature;
  const generation = ++regionRefreshGeneration;
  for (const document of globalThis.canvas?.scene?.regions ?? []) {
    for (const shape of document.shapes ?? []) shape._onShapeChange?.();
    document._clearPolygonTree?.();
    document.object?.renderFlags?.set?.({ refreshShapes: true, refreshGeometry: true, refreshBorder: true });
  }
  for (const template of globalThis.canvas?.templates?.placeables ?? []) template.renderFlags?.set?.({ refreshShape: true });
  if (regionRefreshTimer !== null) clearTimeout(regionRefreshTimer);
  regionRefreshTimer = null;
  const user = globalThis.game?.user, activeGM = globalThis.game?.users?.activeGM;
  if (!user?.isGM || (activeGM && activeGM.id !== user.id) || !scene?.updateTokenRegions || !scene.regions?.size) return;
  const level = globalThis.canvas?.level;
  regionRefreshTimer = setTimeout(() => {
    regionRefreshTimer = null;
    regionWrites = regionWrites.then(() => {
      if (globalThis.canvas?.ready && canvas.scene === scene && canvas.level === level
        && regionRefreshGeneration === generation && regionGeometrySignature(getRuntimeLevelConfig()) === signature) {
        return scene.updateTokenRegions();
      }
    }).catch(error => console.warn("perspective-levels | Failed to refresh token regions", error));
  }, 350);
}

function regionGeometrySignature(config) {
  const rect = getSceneRect();
  return [globalThis.canvas?.level?.id, config.enabled, config.gridScale, config.sceneDepthCells, config.curve,
    ...Object.values(config.far), ...Object.values(config.near), ...Object.values(rect)].join("|");
}

export function clearPerspectiveRegionState() {
  if (regionRefreshTimer !== null) clearTimeout(regionRefreshTimer);
  regionRefreshTimer = null; lastRegionSignature = null; lastRegionScene = null;
  regionRefreshGeneration++;
}
