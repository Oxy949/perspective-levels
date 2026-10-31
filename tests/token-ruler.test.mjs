import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeConfig } from "../scripts/modules/config.js";
import { getTokenArtBounds } from "../scripts/modules/token-hit-testing.js";
import { getTokenVisualCenter, installTokenVisualPatches } from "../scripts/modules/token-visuals.js";
import { applyPerspectiveToToken, removePerspectiveFromToken } from "../scripts/modules/tokens.js";
import { buildPerspectiveMeasurement } from "../scripts/modules/measurement.js";

class Point {
  constructor(x = 0, y = x) { this.set(x, y); }
  set(x, y = x) { this.x = x; this.y = y; }
}
class Ray {
  constructor(A, B) { this.A = A; this.B = B; this.distance = Math.hypot(B.x - A.x, B.y - A.y); }
}
class Ruler {
  constructor(token) { this.token = token; this.refreshes = 0; }
  _preparePath() { this.preparations = (this.preparations ?? 0) + 1; }
  refresh() {
    this.refreshes++;
    const path = this.token.history.map(position => ({ ...position,
      center: this.token.document.getCenterPoint(position), size: this.token.document.getSize(position) }));
    this.measurement = buildPerspectiveMeasurement(path);
    path.forEach((waypoint, i) => {
      waypoint.previous = path[i - 1] ?? null;
      waypoint.ray = i ? new Ray(path[i - 1].center, waypoint.center) : null;
    });
    this._preparePath(path);
    this.path = path;
    // Native v14 selects rendered waypoints and then rebuilds their rays.
    this.rendered = path.filter(waypoint => !waypoint.intermediate);
    this.rendered.forEach((waypoint, i) => {
      waypoint.renderedRay = i ? new Ray(this.rendered[i - 1].center, waypoint.center) : null;
    });
  }
}
class Token {
  constructor({ x = 300, y = 600, elevation = 0, width = 1, height = 1, scaleY = 1 } = {}) {
    this.document = { documentName: "Token", parent: canvas.scene, x, y, width, height, elevation, level: "level",
      texture: { scaleX: 1, scaleY, anchorX: 0.5, anchorY: 0.75 },
      getSize(data = {}) { return { width: (data.width ?? this.width) * 100, height: (data.height ?? this.height) * 100 }; },
      getCenterPoint(data = {}) {
        const size = this.getSize(data);
        return { x: (data.x ?? this.x) + size.width / 2, y: (data.y ?? this.y) + size.height / 2 };
      } };
    this.position = new Point(x, y); this.w = width * 100; this.h = height * 100;
    this.mesh = { position: new Point(x + this.w / 2, y + this.h / 2), rotation: 0,
      scale: new Point(1, scaleY), anchor: new Point(0.5, 0.75), texture: { orig: { width: 100, height: 300 } } };
    this.history = [{ x, y, width, height, elevation }];
    this.ruler = this._initializeRuler();
  }
  _initializeRuler() { return new Ruler(this); }
  _refreshRuler() { this.ruler?.refresh(); }
  _refreshRotation() { this.mesh.rotation = this.document.rotation * Math.PI / 180; }
}

let config;
beforeEach(() => {
  config = normalizeConfig({ enabled: true, tokenArtVerticalAlign: 0, gridScale: 2,
    far: { scale: 0.5 }, near: { scale: 1.5 } });
  globalThis.canvas = { ready: true, scene: {}, level: { id: "level", getFlag: () => config },
    grid: { size: 100, distance: 5 }, dimensions: { size: 100, sceneWidth: 2000, sceneHeight: 1500 },
    tokens: { placeables: [] } };
  globalThis.foundry = { canvas: { placeables: { Token }, geometry: { Ray } } };
  globalThis.PIXI = { Point };
  globalThis.game = { modules: new Map() };
  installTokenVisualPatches();
});
function close(a, b) { assert.ok(Math.abs(a - b) < 0.00001, `${a} != ${b}`); }
function apply(token) { applyPerspectiveToToken(token, { scheduleSort: false }); }

test("ruler pivot matches the art bottom, middle and top at every perspective and emotion scale", () => {
  game.modules.set("ginzzzu-portraits", { active: true });
  for (const scaleY of [1, -1, 2]) for (const height of [1, 2]) for (const y of [250, 700, 1200]) {
    const token = new Token({ y, height, scaleY });
    token.actor = { flags: { "ginzzzu-portraits": { portraitHeightMultiplier: 1.8, emotionHeightMultiplier: 1.4 } } };
    for (const align of [0, 0.25, 0.5, 0.75, 1]) {
      config.tokenArtVerticalAlign = align; apply(token);
      const bounds = getTokenArtBounds(token), pivot = token.ruler.path[0].center;
      close(pivot.x, bounds.x + bounds.width / 2);
      close(pivot.y, bounds.y + bounds.height * (1 - align));
    }
  }
});

test("drag rays join aligned pivots for waypoints with different token sizes and altitudes", () => {
  const token = new Token();
  token.history = [
    { x: 200, y: 700, width: 1, height: 1, elevation: 0 },
    { x: 300, y: 450, width: 2, height: 3, elevation: 10, intermediate: true },
    { x: 500, y: 250, width: 2, height: 2, elevation: 20 }
  ].map(Object.freeze);
  const source = structuredClone(token.history);
  token._refreshRuler();
  assert.deepEqual(token.ruler.path.map(p => p.center), [{ x: 250, y: 800 }, { x: 400, y: 750 }, { x: 600, y: 450 }]);
  assert.deepEqual(token.ruler.path[2].ray.A, { x: 400, y: 750 });
  assert.deepEqual(token.ruler.path[2].ray.B, { x: 600, y: 450 });
  assert.deepEqual(token.ruler.rendered[1].renderedRay.A, { x: 250, y: 800 });
  assert.deepEqual(token.ruler.rendered[1].renderedRay.B, { x: 600, y: 450 });
  assert.deepEqual(token.history, source);
  const measurement = token.ruler.measurement;
  config.tokenArtVerticalAlign = 1; token._refreshRuler();
  assert.deepEqual(token.ruler.measurement, measurement);
  assert.deepEqual(token.ruler.path.map(p => p.center), [{ x: 250, y: 700 }, { x: 400, y: 450 }, { x: 600, y: 250 }]);
});

test("rotated art keeps the pivot at its rotated bottom without changing the animation target", () => {
  const token = new Token(); token.mesh.rotation = Math.PI / 2;
  apply(token);
  const center = token.document.getCenterPoint();
  close(token.ruler.path[0].center.x, center.x - 50);
  close(token.ruler.path[0].center.y, center.y);
  const bounds = getTokenArtBounds(token), target = getTokenVisualCenter(token);
  close(target.x, center.x - (bounds.y + bounds.height / 2 - center.y));
  close(target.y, center.y);
  assert.notDeepEqual(target, token.ruler.path[0].center);
});

test("native rotation refresh moves an existing pivot immediately and settles without redundant refreshes", () => {
  const token = new Token(); apply(token);
  token.document.rotation = 90; token._refreshRotation();
  close(token.ruler.path[0].center.x, 300); close(token.ruler.path[0].center.y, 650);
  assert.equal(token.ruler.refreshes, 2);
  for (let i = 0; i < 100; i++) token._refreshRotation();
  assert.equal(token.ruler.refreshes, 2);
});

test("drag clones use their own pivot and adapt existing or replaced custom rulers once", () => {
  const original = new Token(), preview = new Token({ y: 450, elevation: 10 }); preview._original = original;
  preview.ruler = new Ruler(preview);
  original._refreshRuler(); preview._refreshRuler();
  close(original.ruler.path[0].center.y, 700); close(preview.ruler.path[0].center.y, 550);
  const prepared = preview.ruler._preparePath;
  for (let i = 0; i < 100; i++) preview._refreshRuler();
  assert.equal(preview.ruler._preparePath, prepared);
  assert.equal(preview.ruler.preparations, 101);
  preview.ruler = null; assert.doesNotThrow(() => preview._refreshRuler());
});

test("alignment changes refresh the ruler once without extra ruler work on ordinary mesh updates", () => {
  const token = new Token(); apply(token);
  assert.equal(token.ruler.refreshes, 1);
  for (let i = 0; i < 120; i++) {
    token.position.y++; token.mesh.position.y++; apply(token);
  }
  assert.equal(token.ruler.refreshes, 1);
  config.tokenArtVerticalAlign = 0.5; apply(token);
  assert.equal(token.ruler.refreshes, 2);
  apply(token); assert.equal(token.ruler.refreshes, 2);
  removePerspectiveFromToken(token);
  assert.equal(token.ruler.refreshes, 3);
  close(token.ruler.path[0].center.y, 650);
});

test("disabled perspective, disabled token scaling and foreign scenes or levels retain native pivots", () => {
  const token = new Token();
  const native = token.document.getCenterPoint();
  config.enabled = false; token._refreshRuler(); assert.deepEqual(token.ruler.path[0].center, native);
  config.enabled = true; config.tokenScaling = false; token._refreshRuler(); assert.deepEqual(token.ruler.path[0].center, native);
  config.tokenScaling = true; token.document.parent = {}; token._refreshRuler(); assert.deepEqual(token.ruler.path[0].center, native);
  token.document.parent = canvas.scene; token.history[0].level = "other";
  token._refreshRuler(); assert.deepEqual(token.ruler.path[0].center, native);
});
