import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeConfig, getRuntimeLevelConfig } from "../scripts/modules/config.js";
import { getPerspectiveGridModel, perspectiveGridModelToScreen } from "../scripts/modules/projection.js";
import { installTokenVisualPatches, updateTokenOutline, clearTokenOutline, adaptSequencerEffect } from "../scripts/modules/token-visuals.js";
import { installRegionPerspectivePatches, getPerspectiveCoveredCells, refreshPerspectiveRegions } from "../scripts/modules/region-perspective.js";
import { clearPerspectiveRegionState } from "../scripts/modules/region-perspective.js";
import { perspectiveGroundPointToElevatedScreen } from "../scripts/modules/projection.js";
import { installPerspectiveMeasurementPatch } from "../scripts/modules/measurement-patches.js";

class Point { constructor(x = 0, y = 0) { this.set(x, y); } set(x, y = x) { this.x = x; this.y = y; } }
class Polygon {
  constructor(points) { this.points = points; }
  contains(x, y) {
    let inside = false; const p = this.points;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if ((p[i + 1] > y) !== (p[j + 1] > y)
        && x < (p[j] - p[i]) * (y - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
    }
    return inside;
  }
}
class Ray { constructor(A, B) { this.A = A; this.B = B; this.dx = B.x - A.x; this.dy = B.y - A.y; } }
class Token {
  constructor(x = 100, y = 600) {
    this.document = { documentName: "Token", parent: canvas.scene, x, y, texture: { scaleX: 1, scaleY: 1 } };
    this.position = new Point(x, y); this.w = this.h = 100;
    this.mesh = { position: new Point(x + 50, y + 50), scale: new Point(2, 2), anchor: new Point(0.5, 1),
      texture: { orig: { width: 100, height: 300 } }, _perspectiveLevelsAppliedScale: 2, filters: [] };
    this.border = { renderable: true }; this.visible = true;
  }
  get center() { return new Point(this.document.x + 50, this.document.y + 50); }
  getCenterPoint(position = this.document) { return { x: position.x + 50, y: position.y + 50 }; }
  _refreshPosition() { this.position.set(this.document.x, this.document.y); this.mesh.position = this.center; }
  _refreshBorder() { this.border.renderable = true; }
  getDispositionColor() { return this.color ?? 0x12ab34; }
}
class Grid {
  size = 100; distance = 5; isSquare = true;
  measurePath(points) { return { distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / 20 }; }
  getOffset({ x, y }) { return { i: Math.floor(y / 100), j: Math.floor(x / 100) }; }
  getVertices({ i, j }) { return [{ x: j * 100, y: i * 100 }, { x: (j + 1) * 100, y: i * 100 },
    { x: (j + 1) * 100, y: (i + 1) * 100 }, { x: j * 100, y: (i + 1) * 100 }]; }
  getSnappedPoint(p) { return { x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100 }; }
}
class CircleShape {
  constructor(data, parent) { Object.assign(this, { radius: 100, x: 0, y: 0 }, data); this.parent = parent; }
  get origin() { return { x: this.x, y: this.y }; }
  get grid() { return canvas.grid; }
  clone() { return new this.constructor(this.toObject(), this.parent); }
  toObject() { return { x: this.x, y: this.y, radius: this.radius }; }
  updateSource(data) { Object.assign(this, data); this._onShapeChange(); }
  _onShapeChange() { this.cacheClears = (this.cacheClears ?? 0) + 1; }
  _createClipperPolyTree() {
    this.constructor.nativeMeasurement = this.grid.measurePath([{ x: this.x, y: this.y }, { x: this.x + this.radius, y: this.y }]);
    return Array.from({ length: 64 }, (_, i) => ({ x: this.x + Math.cos(i * Math.PI / 32) * this.radius,
      y: this.y + Math.sin(i * Math.PI / 32) * this.radius }));
  }
  get polygonTree() { return { drawShape: graphics => { graphics.points = this._createClipperPolyTree(); } }; }
  drawShape(graphics) { graphics.nativeCircle = true; }
  _onDragMove(event) {
    const { origin, destination } = event.interactionData;
    this.updateSource({ x: origin.x, y: origin.y, radius: Math.hypot(destination.x - origin.x, destination.y - origin.y) });
  }
  moveControlHandle(name, destination) {
    if (name === "translate") this.updateSource(destination);
    else this.updateSource({ radius: Math.hypot(destination.x - this.x, destination.y - this.y) });
  }
  _getSnappedPoint(p) { return this.grid.getSnappedPoint(p); }
  _createControlHandles() { return { scale: { position: { x: this.x + this.radius, y: this.y } } }; }
  _createMeasuredSegments() { return [{ ray: new Ray(this.origin, { x: this.x + this.radius, y: this.y }), distance: this.radius / 20 }]; }
  sampleInterior(out = {}) { return Object.assign(out, this.origin); }
  sampleBoundary(out = {}) { return Object.assign(out, { x: this.x + this.radius, y: this.y }); }
}
class RingShape extends CircleShape {
  _createClipperPolyTree() {
    const node = (radius, hole = false) => {
      const contour = Array.from({ length: 4 }, (_, i) => ({ X: (this.x + Math.cos(i * Math.PI / 2) * radius) * 100,
        Y: (this.y + Math.sin(i * Math.PI / 2) * radius) * 100 }));
      const children = []; return { hole, Contour: () => contour, Childs: () => children };
    };
    const outer = node(this.radius), inner = node(this.radius / 2, true);
    outer.Childs().push(inner);
    return { Childs: () => [outer] };
  }
}
class Region {
  _getCoveredGridSpaceOffsets() { throw new Error("native square-grid coverage"); }
  _refreshGeometry() { this.vertices = this._getCoveredGridSpaceOffsets().flatMap(offset => canvas.grid.getVertices(offset)); }
  _draw() { this.children = [{ hitArea: { contains() { return false; } } }]; }
}
class TokenDocument {
  constructor(data) { this._source = data; this.parent = canvas.scene; }
  getSize(data) { return { width: (data.width ?? 1) * 100, height: (data.height ?? 1) * 100 }; }
  testInsideRegion(region, data = this._source) {
    this.testedPosition = data;
    return region.polygonTree.testPoint({ x: data.x + 50, y: data.y + 50 });
  }
  segmentizeRegionMovementPath(region, waypoints) {
    this.testedPath = waypoints.map(p => ({ ...p }));
    return [{ type: 'MOVE', from: { ...waypoints[0] }, to: { ...waypoints.at(-1) }, action: 'walk' }];
  }
}
class MeasuredTemplate {
  _computeShape() { return { x: 0, y: 0, radius: this.document.distance * 20 }; }
  _refreshShape() {
    const d = this.document;
    this.ray = new Ray({ x: d.x, y: d.y }, { x: d.x + d.distance * 20, y: d.y }); this.shape = this._computeShape();
  }
  highlightGrid() { throw new Error("native square-grid highlight"); }
}
const rect = { x: 0, y: 0, width: 2000, height: 1500, gridSize: 100 };
let config, filters;
beforeEach(() => {
  clearPerspectiveRegionState();
  config = normalizeConfig({ enabled: true, gridScale: 2, far: { scale: 0.7 }, near: { scale: 1.4 }, curve: 1.45 });
  filters = [];
  globalThis.PIXI = { Point, Polygon };
  globalThis.CONST = { GRID_SNAPPING_MODES: { VERTEX: 1, CENTER: 2, EDGE_MIDPOINT: 4 } };
  globalThis.game = { user: {} };
  globalThis.canvas = { ready: true, level: { id: "level", getFlag: () => config }, grid: new Grid(),
    scene: { regions: [] }, dimensions: { size: 100, sceneWidth: 2000, sceneHeight: 1500 } };
  globalThis.foundry = { documents: { TokenDocument }, grid: { BaseGrid: Grid }, data: { CircleShapeData: CircleShape, RingShapeData: RingShape }, canvas: {
    placeables: { Token, Region, MeasuredTemplate }, geometry: { Ray }, rendering: { filters: { OutlineOverlayFilter: {
      create(uniforms) { const filter = { uniforms, destroy() { this.destroyed = true; } }; filters.push(filter); return filter; }
    } } } } };
  installTokenVisualPatches(); installPerspectiveMeasurementPatch(); installRegionPerspectivePatches();
});
function close(a, b, tolerance = 0.001) { assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`); }
function point(i, j) { return perspectiveGridModelToScreen(getPerspectiveGridModel(config, rect), i, j); }
function document() { return { parent: canvas.scene, includedInLevel: id => id === canvas.level.id }; }

test("token visual center follows the portrait without shifting native mesh positioning", () => {
  const token = new Token();
  assert.deepEqual({ ...token.center }, { x: 150, y: 350 });
  assert.deepEqual(token.getCenterPoint(), { x: 150, y: 350 });
  assert.deepEqual(token.getCenterPoint({ x: 1000, y: 2000 }), { x: 1050, y: 2050 });
  for (let i = 0; i < 100; i++) token._refreshPosition();
  assert.deepEqual({ ...token.mesh.position }, { x: 150, y: 650 });
  assert.deepEqual({ ...token.center }, { x: 150, y: 350 });
  config.enabled = false;
  assert.deepEqual({ ...token.center }, { x: 150, y: 650 });
});

test("selection outline defaults on, uses disposition color and reuses one filter", () => {
  assert.equal(getRuntimeLevelConfig().selectionOutline, true);
  const token = new Token(), other = {}; token.mesh.filters.push(other);
  updateTokenOutline(token); assert.equal(filters.length, 0);
  token.controlled = true;
  for (let i = 0; i < 100; i++) updateTokenOutline(token);
  assert.equal(filters.length, 1); assert.equal(filters[0].animated, false);
  assert.equal(filters[0].uniforms.knockout, false);
  assert.deepEqual(filters[0].uniforms.outlineColor, [0x12 / 255, 0xab / 255, 0x34 / 255, 1]);
  assert.equal(token.border.renderable, false);
  token.color = 0xff0000; updateTokenOutline(token); assert.deepEqual(filters[0].uniforms.outlineColor, [1, 0, 0, 1]);
  config.selectionOutline = false; updateTokenOutline(token);
  assert.deepEqual(token.mesh.filters, [other]); assert.equal(filters[0].destroyed, true); assert.equal(token.border.renderable, true);
});

test("outline follows a recreated mesh and cleans up only its own filters", () => {
  const token = new Token(); token.hover = true; updateTokenOutline(token);
  const previous = token.mesh; token.mesh = { ...previous, filters: [] };
  updateTokenOutline(token); assert.equal(previous.filters.length, 0); assert.equal(filters[0].destroyed, true);
  assert.equal(filters.length, 2);
  clearTokenOutline(token); assert.equal(token.mesh.filters.length, 0); assert.equal(token.border.renderable, true);
});

function effect(source, target) {
  return { source, target, data: {},
    getSourceData() { return { position: { x: 0, y: 0 }, width: 100, height: 100, alpha: 0.4 }; },
    getTargetData() { return { position: { x: 5, y: 5 }, width: 100, height: 100 }; },
    _getBaseScale() { return { baseScaleX: 1, baseScaleY: 2 }; },
    async _getDistanceScaling() { return { scaleX: 3, scaleY: 4 }; }
  };
}
test("Sequencer endpoints and fixed-size effects follow live portrait centers and perspective scale", async () => {
  const source = new Token(), target = new Token(500, 400), fx = effect(source, target);
  adaptSequencerEffect(fx); adaptSequencerEffect(fx);
  assert.deepEqual(fx.getSourceData(), { position: { x: 150, y: 350 }, width: 200, height: 600, alpha: 0.4 });
  assert.deepEqual(fx.getTargetData().position, { x: 550, y: 150 });
  assert.deepEqual(fx._getBaseScale(), { baseScaleX: 2, baseScaleY: 4 });
  assert.deepEqual(await fx._getDistanceScaling(), { scaleX: 3, scaleY: 8 });
  source.mesh._perspectiveLevelsAppliedScale = 3; source.mesh.scale.set(3);
  assert.equal(fx._getBaseScale().baseScaleX, 3); assert.equal(fx.getSourceData().width, 300);
});

test("object-sized effects avoid a second scale and preserve native token-scale handling", () => {
  const source = new Token(), fx = effect(source);
  source.document.texture.scaleX = 2; source.document.texture.scaleY = 3;
  fx.data.scaleToObject = { considerTokenScale: true }; adaptSequencerEffect(fx);
  assert.deepEqual(fx._getBaseScale(), { baseScaleX: 1, baseScaleY: 2 });
  assert.equal(fx.getSourceData().width * 2, 200); assert.equal(fx.getSourceData().height * 3, 600);
  fx.data.screenSpace = true;
  assert.deepEqual(fx.getSourceData().position, { x: 0, y: 0 });
  assert.deepEqual(fx._getBaseScale(), { baseScaleX: 1, baseScaleY: 2 });
});

test("ground-point animation targets and disabled perspective retain native data", () => {
  const fx = effect(new Token(), { x: 50, y: 70 }); adaptSequencerEffect(fx);
  assert.deepEqual(fx.getTargetData().position, { x: 5, y: 5 });
  config.enabled = false;
  assert.deepEqual(fx.getSourceData().position, { x: 0, y: 0 }); assert.equal(fx._getBaseScale().baseScaleX, 1);
});

test("region circle geometry, drawing and hit tests use one projected contour", () => {
  const origin = point(5, 6), shape = new CircleShape({ ...origin, radius: 200 }, document());
  const before = shape.toObject(), points = shape._createClipperPolyTree(), expected = point(7, 6);
  close(points[0].x, expected.x); close(points[0].y, expected.y);
  assert.deepEqual(shape.toObject(), before);
  close(CircleShape.nativeMeasurement.distance, 10); assert.equal(CircleShape.nativeMeasurement._perspectiveLevels, undefined);
  const graphics = {}; shape.drawShape(graphics); assert.ok(graphics.points.length >= 64); assert.equal(graphics.nativeCircle, undefined);
  const polygon = new Polygon(points.flatMap(p => [p.x, p.y]));
  assert.equal(polygon.contains(origin.x, origin.y), true);
  const outside = point(8, 6); assert.equal(polygon.contains(outside.x, outside.y), false);
});

test("region dragging, resizing and handles retain sizes in perspective cells", () => {
  const origin = point(5, 6), target = point(7, 6), shape = new CircleShape({ ...origin, radius: 100 }, document());
  shape._onDragMove({ shiftKey: true, interactionData: { origin, destination: target } });
  close(shape.radius, 200);
  let handle = shape._createControlHandles().scale.position;
  close(handle.x, target.x); close(handle.y, target.y);
  const segment = shape._createMeasuredSegments()[0]; close(segment.distance, 10); close(segment.ray.B.x, target.x);
  const farther = point(8, 6); shape.moveControlHandle('scale', farther); close(shape.radius, 300);
  const moved = point(4, 8); shape.moveControlHandle('translate', moved);
  close(shape.x, moved.x); close(shape.y, moved.y); close(shape.radius, 300);
});

test("region coverage uses perspective cell centers and projected vertices in its native rendering", () => {
  const a = point(4, 4), b = point(6, 6), polygon = new Polygon([a.x, a.y, ...Object.values(point(6, 4)), b.x, b.y, ...Object.values(point(4, 6))]);
  const bounds = { x: Math.min(a.x, point(4, 6).x), y: a.y, width: Math.max(b.x, point(6, 4).x) - Math.min(a.x, point(4, 6).x), height: b.y - a.y };
  const cells = getPerspectiveCoveredCells(bounds, p => polygon.contains(p.x, p.y));
  assert.equal(cells.length, 4);
  const region = new Region(); region.document = document(); region.animationState = { bounds, polygonTree: { testPoint: p => polygon.contains(p.x, p.y) } };
  region._refreshGeometry(); assert.equal(region.vertices.length, 16);
  close(region.vertices[0].x, cells[0].vertices[0].x); close(region.vertices[0].y, cells[0].vertices[0].y);
  assert.deepEqual(canvas.grid.getVertices({ i: 4, j: 4 })[0], { x: 400, y: 400 });
});

test("region config changes invalidate shape and document caches without document writes", () => {
  let documents = 0, renders = 0; const shape = new CircleShape({}, document());
  canvas.scene.regions = [{ shapes: [shape], _clearPolygonTree() { documents++; }, object: { renderFlags: { set() { renders++; } } } }];
  refreshPerspectiveRegions(); assert.equal(documents, 1); assert.equal(shape.cacheClears, 1); assert.equal(renders, 1);
});

test("foreign scenes and inactive levels keep native region geometry", () => {
  const foreign = new CircleShape({ x: 100, y: 200, radius: 10 }, { parent: {} });
  close(foreign._createClipperPolyTree()[0].x, 110);
  const inactive = new CircleShape({ x: 100, y: 200, radius: 10 }, { parent: canvas.scene, includedInLevel: () => false });
  close(inactive._createClipperPolyTree()[0].x, 110);
});

test("legacy templates share perspective geometry and cell highlighting", () => {
  const origin = point(5, 6), template = new MeasuredTemplate();
  template.document = { ...origin, parent: canvas.scene, distance: 10 };
  template._refreshShape();
  const expected = point(7, 6);
  close(template.shape.points[0] + origin.x, expected.x); close(template.shape.points[1] + origin.y, expected.y);
  close(template.ray.B.x, expected.x);
  let polygons = 0; canvas.interface = { grid: { clearHighlightLayer() {}, highlightPosition(id, data) { assert.ok(data.shape instanceof Polygon); polygons++; } } };
  template.highlightGrid(); assert.ok(polygons > 0);
});

test("region holes and point sampling follow the projected geometry", () => {
  const origin = point(5, 6), shape = new RingShape({ ...origin, radius: 200 }, document());
  const outer = shape._createClipperPolyTree().Childs()[0], inner = outer.Childs()[0];
  assert.equal(inner.hole, true);
  close(outer.Contour()[0].X / 100, point(7, 6).x, 0.01);
  close(inner.Contour()[0].X / 100, point(6, 6).x, 0.01);
  const circle = new CircleShape({ ...origin, radius: 200 }, document()), out = {};
  assert.equal(circle.sampleBoundary(out), out); close(out.x, point(7, 6).x);
  const sample = circle.sampleInterior(); close(sample.x, origin.x); close(sample.y, origin.y);
});

test("projected coverage hit testing uses the same cell as the rendered highlight", () => {
  const points = [point(4.4, 4.4), point(4.6, 4.4), point(4.6, 4.6), point(4.4, 4.6)];
  const polygon = new Polygon(points.flatMap(p => [p.x, p.y]));
  const region = new Region(); region.document = { ...document(), highlightMode: 'coverage' };
  region.animationState = { polygonTree: { testPoint: p => polygon.contains(p.x, p.y) } };
  region._draw(); const hit = region.children[0].hitArea;
  const covered = point(4.1, 4.1), outside = point(3.9, 4.1);
  assert.equal(hit.contains(covered.x, covered.y), true); assert.equal(hit.contains(outside.x, outside.y), false);
});

test("flying token region checks and movement segments use its ground position", () => {
  const ground = { ...point(5, 8), elevation: 25 };
  const visual = perspectiveGroundPointToElevatedScreen(ground, config, rect);
  const source = { x: visual.x - 50, y: visual.y - 100, elevation: 25, width: 1, height: 1 };
  const doc = new TokenDocument(source);
  const region = { ...document(), polygonTree: { testPoint: p => Math.hypot(p.x - ground.x, p.y - ground.y) < 10 } };
  assert.equal(doc.testInsideRegion(region), true);
  close(doc.testedPosition.x + 50, ground.x); close(doc.testedPosition.y + 50, ground.y);
  const end = perspectiveGroundPointToElevatedScreen({ ...point(7, 10), elevation: 40 }, config, rect);
  const path = [source, { ...source, x: end.x - 50, y: end.y - 100, elevation: 40 }];
  const saved = structuredClone(path), segments = doc.segmentizeRegionMovementPath(region, path);
  assert.deepEqual(path, saved);
  close(segments[0].from.x, source.x); close(segments[0].from.y, source.y);
  close(segments[0].to.x, path[1].x); close(segments[0].to.y, path[1].y);
  close(doc.testedPath[1].x + 50, point(7, 10).x); close(doc.testedPath[1].y + 50, point(7, 10).y);
});

test("region membership writes coalesce and visual settings do not invalidate geometry", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  game.user = { id: 'gm', isGM: true }; game.users = { activeGM: game.user };
  let clears = 0, writes = 0;
  canvas.scene.regions = new Set([{ shapes: [], _clearPolygonTree() { clears++; } }]);
  canvas.scene.updateTokenRegions = async () => { writes++; };
  for (let i = 0; i < 100; i++) refreshPerspectiveRegions();
  config.selectionOutline = false; config.grid = false; refreshPerspectiveRegions();
  assert.equal(clears, 1);
  t.mock.timers.tick(350); await Promise.resolve(); assert.equal(writes, 1);
  config.gridScale = 3; refreshPerspectiveRegions(); clearPerspectiveRegionState();
  t.mock.timers.tick(350); await Promise.resolve(); assert.equal(writes, 1);
});
