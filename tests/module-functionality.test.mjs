import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeConfig, getLevelConfig, getRuntimeLevelConfig, setLevelConfigOverride, clearLevelConfigOverride } from "../scripts/modules/config.js";
import { anchorToPoint, pointToAnchor, getElevation, getPerspectiveGridModel, perspectiveGridModelToScreen, screenPointToPerspectiveGrid, perspectiveGroundPointToElevatedScreen, screenPointToElevationGroundPoint } from "../scripts/modules/projection.js";
import { squareGridDistanceSpaces, squareGridDistanceSpaces3D, perspectiveDistanceBetween, buildPerspectiveMeasurement, mergePerspectiveMeasurement } from "../scripts/modules/measurement.js";
import { installPerspectiveMeasurementPatch } from "../scripts/modules/measurement-patches.js";
import { installPerspectiveTokenLayerMovementPatch } from "../scripts/modules/keyboard-movement.js";
import { clearPerspectiveUpdateState } from "../scripts/modules/token-update-queue.js";
import { clearPerspectiveSortState } from "../scripts/modules/tokens.js";
import { PerspectiveCalibrator } from "../scripts/modules/calibrator.js";
import { PerspectiveGridOverlay } from "../scripts/modules/grid-overlay.js";
import { applyGridSettings, extractGridSettings } from "../scripts/modules/level-config-ui.js";
import { scheduleTokenStatusIconRefresh, scheduleTokenStatusIconRefreshBurst, scheduleActorStatusIconRefreshBurst, clearTokenStatusIconRefreshState } from "../scripts/modules/status-effects.js";
import { collectTokensForActor } from "../scripts/modules/actor-tokens.js";
import { getCachedPerspectiveGridModel } from "../scripts/modules/projection.js";

const DIAG = { EQUIDISTANT: 0, EXACT: 1, APPROXIMATE: 2, RECTILINEAR: 3, ALTERNATING_1: 4, ALTERNATING_2: 5, ILLEGAL: 6 };
const rect = { x: 100, y: 150, width: 2000, height: 1500, gridSize: 100 };
const point = () => ({ x: 0, y: 0, set(x, y = x) { this.x = x; this.y = y; } });
class Container {
  children = []; position = point(); scale = point(); events = new Map();
  addChild(...children) { for (const child of children) this.addChildAt(child, this.children.length); }
  addChildAt(child, index) { child.parent?.removeChild(child); this.children.splice(index, 0, child); child.parent = this; }
  getChildIndex(child) { return this.children.indexOf(child); }
  removeChild(child) { this.children.splice(this.getChildIndex(child), 1); child.parent = null; }
  on(name, callback) { this.events.set(name, callback); return this; }
  destroy({ children } = {}) { if (children) for (const child of [...this.children]) child.destroy?.({ children: true }); this.parent?.removeChild(this); this.destroyed = true; }
}
class Graphics extends Container {
  lines = []; clear() { this.lines = []; } lineStyle() {} stroke() {}
  moveTo(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); this.lines.push([x, y]); }
  lineTo(x, y) { this.moveTo(x, y); } drawCircle() {} beginFill() {} endFill() {}
}
class Rectangle {
  constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
  contains(x, y) { return x >= this.x && x <= this.x + this.width && y >= this.y && y <= this.y + this.height; }
}
class Text extends Container { anchor = point(); height = 20; }
let config, frames, updates, writes;
const hooks = new Map();
beforeEach(() => {
  clearLevelConfigOverride(); clearPerspectiveUpdateState(); clearPerspectiveSortState(); clearTokenStatusIconRefreshState();
  config = normalizeConfig({ enabled: true, far: { scale: 1 }, near: { scale: 1 }, curve: 1, sceneDepthCells: 12 });
  frames = []; updates = []; writes = [];
  globalThis.CONST = { GRID_DIAGONALS: DIAG };
  globalThis.PIXI = { Container, Graphics, Rectangle, Text };
  globalThis.requestAnimationFrame = fn => frames.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.game = { user: { isGM: true }, keyboard: { isModifierActive: () => false } };
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  globalThis.canvas = {
    ready: true, dimensions: { size: 100, sceneX: rect.x, sceneY: rect.y, sceneWidth: rect.width, sceneHeight: rect.height },
    level: { id: "a", uuid: "Scene.a.Level.a", name: "A", getFlag: () => config, setFlag: async () => {} },
    grid: { size: 100, distance: 5, diagonals: DIAG.EQUIDISTANT },
    scene: { grid: { diagonals: DIAG.EQUIDISTANT }, updateEmbeddedDocuments: async (_, data) => { updates.push(data); } },
    interface: new Container(), tokens: { placeables: [] }
  };
});
function closeTo(a, b, epsilon = 0.001) { assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`); }
function gridPoint(i, j, elevation = 0) {
  const p = { ...perspectiveGridModelToScreen(getPerspectiveGridModel(config, rect), i, j), elevation };
  return perspectiveGroundPointToElevatedScreen(p, config, rect);
}
function diagonalMode(mode) { canvas.scene.grid.diagonals = canvas.grid.diagonals = mode; }

test("anchors outside every scene edge survive coordinate conversion and configuration reload", () => {
  for (const anchor of [{ x: -0.4, y: -0.6 }, { x: 1.7, y: 2.2 }]) {
    const screen = anchorToPoint(anchor, rect), restored = pointToAnchor(screen, rect);
    closeTo(restored.x, anchor.x); closeTo(restored.y, anchor.y);
  }
  const outside = normalizeConfig({ far: { x: -0.4, y: -0.6, scale: 0.01 }, near: { x: 1.7, y: 2.2, scale: 16 } });
  assert.equal(outside.far.x, -0.4); assert.equal(outside.far.y, -0.6); assert.equal(outside.far.scale, 0.01);
  assert.equal(outside.near.x, 1.7); assert.equal(outside.near.y, 2.2); assert.equal(outside.near.scale, 16);
  assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(outside))), outside);
  const invalid = normalizeConfig({ far: { x: Infinity, y: NaN }, near: { x: '-Infinity', y: 'invalid' } });
  for (const anchor of [invalid.far, invalid.near]) assert.ok(Number.isFinite(anchor.x) && Number.isFinite(anchor.y));
});

test("projection and flight remain reversible with off-scene anchors and expanded scale extremes", () => {
  for (const [farScale, nearScale] of [[0.01, 16], [16, 0.01], [0.01, 0.01], [16, 16]]) {
    for (const curve of [0.4, 1, 1.45, 4]) {
      const cfg = normalizeConfig({ curve, far: { x: -0.25, y: -0.5, scale: farScale },
        near: { x: 1.25, y: 1.5, scale: nearScale } });
      const model = getPerspectiveGridModel(cfg, rect);
      assert.equal(model.columns, getPerspectiveGridModel(config, rect).columns);
      for (const i of [0, model.columns / 2, model.columns]) for (const j of [0, 2, 6, 12]) {
        const screen = perspectiveGridModelToScreen(model, i, j);
        const grid = screenPointToPerspectiveGrid(screen, cfg, rect);
        closeTo(grid.i, i, 0.001); closeTo(grid.j, j, 0.001);
        const elevated = perspectiveGroundPointToElevatedScreen({ ...screen, elevation: 10 }, cfg, rect);
        const ground = screenPointToElevationGroundPoint({ ...elevated, elevation: 10 }, cfg, rect);
        closeTo(ground.x, screen.x, 0.01); closeTo(ground.y, screen.y, 0.01);
      }
    }
  }
});

test("dragging anchors outside the scene saves and reopens with selectable lines and working rotation", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let saved = config;
  canvas.level.getFlag = () => saved;
  canvas.level.setFlag = async (_, __, value) => { saved = structuredClone(value); };
  const c = new PerspectiveCalibrator(); c._createPanel = () => {};
  c.open();
  for (const [key, coordinates] of [['far', { x: -0.5, y: -0.4 }], ['near', { x: 1.4, y: 1.5 }]]) {
    const destination = anchorToPoint(coordinates, rect);
    c.dragging = key;
    c._onPointerMove({ getLocalPosition: () => destination }); c._stopDrag();
    assert.equal(c.config[key].x, coordinates.x); assert.equal(c.config[key].y, coordinates.y);
    assert.ok(c.container.hitArea.contains(destination.x, destination.y));
  }
  await c.save({ notify: false }); c.close(false);
  await c._autoSavePromise;
  c.open();
  for (const key of ['far', 'near']) {
    const anchor = c.anchors[key], hit = anchor.hitArea;
    assert.ok(c.container.hitArea.contains(anchor.position.x + hit.x, anchor.position.y + hit.y));
    assert.ok(c.container.hitArea.contains(anchor.position.x + hit.x + hit.width, anchor.position.y + hit.y + hit.height));
  }
  c._onWheel({ deltaY: 100, getLocalPosition: () => c.anchors.far.position });
  assert.equal(c.config.far.rotation, 5);
  assert.equal(c.config.far.x, -0.5); assert.equal(c.config.near.y, 1.5);
  c.close(false); await c._autoSavePromise;
});

test("extreme anchor scales do not add overlay subdivisions or camera redraw work", () => {
  const overlay = new PerspectiveGridOverlay(); overlay.draw();
  const count = overlay.grid.lines.length;
  config.far = { ...config.far, x: -2, y: -1, scale: 0.01 };
  config.near = { ...config.near, x: 3, y: 2, scale: 16 };
  overlay.draw(); assert.equal(overlay.grid.lines.length, count);
  const geometry = overlay.grid.lines;
  for (let i = 0; i < 100; i++) overlay.draw();
  assert.equal(overlay.grid.lines, geometry);
});

test("copied calibration preserves outside coordinates and both expanded anchor scale limits", () => {
  const values = { 'far.x': -1.25, 'far.y': -0.5, 'near.x': 2.5, 'near.y': 1.75, 'far.scale': 0.01, 'near.scale': 16 };
  const inputs = new Map(Object.keys(values).map(key => [key, { value: '', dispatchEvent() {} }]));
  const form = { querySelector: selector => inputs.get(selector.match(/perspective\.(.*)"\]/)?.[1]) };
  assert.equal(applyGridSettings(form, values), true);
  assert.deepEqual(extractGridSettings(form), values);
  applyGridSettings(form, { 'far.scale': -1, 'near.scale': 100 });
  assert.equal(Number(inputs.get('far.scale').value), 0.01);
  assert.equal(Number(inputs.get('near.scale').value), 16);
});

test("config normalization is stable, migrates old fields and never leaves coincident anchors", () => {
  for (const y of [-2, 0, 0.5, 0.99, 1, 3]) {
    const value = normalizeConfig({ enabled: "true", grid: "false", tokenVerticalAlign: 0.2, far: { y }, near: { y } });
    assert.equal(value.enabled, true); assert.equal(value.grid, false); assert.equal(value.tokenArtVerticalAlign, 0.2);
    assert.ok(Math.abs(value.far.y - value.near.y) >= 0.02);
    assert.deepEqual(normalizeConfig(value), value);
  }
});
test("calibration overrides are isolated by full level identity and clear correctly", () => {
  const a = canvas.level;
  const b = { ...a, uuid: "Scene.b.Level.a", getFlag: () => ({ enabled: false }) };
  setLevelConfigOverride(a, { enabled: true, gridScale: 3 });
  assert.equal(getLevelConfig(a).gridScale, 3); assert.equal(getLevelConfig(b).enabled, false);
  clearLevelConfigOverride(b); assert.equal(getLevelConfig(a).gridScale, 3);
  clearLevelConfigOverride(a); assert.equal(getLevelConfig(a).gridScale, 1);
});
test("anchors respect scene offsets and missing elevation values use a valid fallback", () => {
  assert.deepEqual(pointToAnchor(anchorToPoint({ x: 0.3, y: 0.8 }, rect), rect), { x: 0.3, y: 0.8 });
  assert.equal(getElevation({ elevation: null, z: 10 }), 10);
});
test("projection round trips rotated, curved grids and points outside both anchors", () => {
  for (const curve of [0.4, 1, 1.45, 4]) for (const rotation of [-15, 0, 15]) {
    const cfg = normalizeConfig({ curve, far: { rotation, scale: 0.65 }, near: { rotation: rotation / 2, scale: 1.2 } });
    const model = getPerspectiveGridModel(cfg, rect);
    for (const i of [1.3, model.columns / 2, model.columns - 1]) for (const j of [-0.25, 0, 3.75, 8.2, 12, 13]) {
      const screen = perspectiveGridModelToScreen(model, i, j);
      const recovered = screenPointToPerspectiveGrid(screen, cfg, rect, model);
      closeTo(recovered.i, i, 0.01); closeTo(recovered.j, j, 0.01);
    }
  }
});
test("ground/elevation projection round trips ordinary flying and underground points", () => {
  config = normalizeConfig({ enabled: true });
  for (const elevation of [-10, -5, 5, 10]) for (const row of [4, 8, 11]) {
    const p = { ...perspectiveGridModelToScreen(getPerspectiveGridModel(config, rect), 8, row), elevation };
    const recovered = screenPointToElevationGroundPoint(perspectiveGroundPointToElevatedScreen(p, config, rect), config, rect);
    closeTo(recovered.x, p.x); closeTo(recovered.y, p.y, 0.01);
  }
});

test("flying above far boundaries stays invertible across curves, rotations and large altitudes", () => {
  for (const curve of [0.4, 1, 1.45, 4]) for (const rotation of [-15, 0, 15]) {
    const cfg = normalizeConfig({ enabled: true, curve, far: { rotation }, near: { rotation: rotation / 2 } });
    const model = getPerspectiveGridModel(cfg, rect);
    for (const i of [1, model.columns / 2, model.columns - 1]) for (const row of [0, 0.2, 1, 4, 8, 12]) {
      for (const elevation of [-10, 5, 10, 25, 50]) {
        const ground = { ...perspectiveGridModelToScreen(model, i, row), elevation };
        const raised = perspectiveGroundPointToElevatedScreen(ground, cfg, rect, model);
        const restored = screenPointToElevationGroundPoint(raised, cfg, rect, model);
        closeTo(restored.x, ground.x, 0.01); closeTo(restored.y, ground.y, 0.01);
      }
    }
  }
});

test("resetting calibration preserves both values of grid visibility", () => {
  for (const grid of [false, true]) {
    const c = new PerspectiveCalibrator(); c.config = normalizeConfig({ grid, curve: 3 }); c._applyConfigChange = () => {};
    c.reset(); assert.equal(c.config.grid, grid); assert.equal(c.config.curve, 1.45);
  }
});
for (const [mode, expected] of [[DIAG.EQUIDISTANT, 4], [DIAG.EXACT, 1 + 2 * Math.SQRT2 + Math.sqrt(3)], [DIAG.APPROXIMATE, 5.75], [DIAG.RECTILINEAR, 8], [DIAG.ALTERNATING_1, 5], [DIAG.ALTERNATING_2, 6], [DIAG.ILLEGAL, 8]]) {
  test(`3D diagonal rule ${mode} matches native v14 movement cost`, () => {
    diagonalMode(mode); closeTo(squareGridDistanceSpaces3D(4, 3, 1), expected);
  });
}
test("EXACT grid distance follows grid diagonals and keeps euclidean separately", () => {
  diagonalMode(DIAG.EXACT);
  closeTo(squareGridDistanceSpaces(4, 3), 1 + 3 * Math.SQRT2);
  const result = perspectiveDistanceBetween(gridPoint(4, 2), gridPoint(8, 5), config, rect);
  closeTo(result.distance, (1 + 3 * Math.SQRT2) * 5); closeTo(result.euclidean, 25); assert.equal(result.spaces, 4);
});
for (const mode of [DIAG.ALTERNATING_1, DIAG.ALTERNATING_2]) {
  test(`alternating rule ${mode} preserves diagonal count across waypoints`, () => {
    diagonalMode(mode);
    const a = gridPoint(4, 2), b = gridPoint(5, 3), c = gridPoint(6, 4);
    const direct = buildPerspectiveMeasurement([a, c], config, rect);
    const split = buildPerspectiveMeasurement([a, b, c], config, rect);
    assert.equal(split.distance, direct.distance); assert.equal(split.distance, 15);
    assert.equal(split.waypoints.at(-1).distance, 15); assert.equal(split.segments[0].to.backward, split.segments[0]);
  });
}
test("explicit ruler heights are not replaced by unrelated tokens underneath", () => {
  const a = gridPoint(4, 2, 10), b = gridPoint(5, 4, 10);
  const expected = perspectiveDistanceBetween(a, b, config, rect);
  canvas.tokens.placeables = [{ document: { elevation: 0, x: a.x - 50, y: a.y - 50, width: 1, height: 1 }, w: 100, h: 100 }];
  assert.deepEqual(perspectiveDistanceBetween(a, b, config, rect), expected);
});
test("unmeasured waypoints stay free and terrain ratios and blocked paths survive merging", () => {
  const points = [gridPoint(4, 2), { ...gridPoint(5, 3), measure: false }, gridPoint(6, 4)];
  const measured = buildPerspectiveMeasurement(points, config, rect);
  assert.equal(measured.segments[0].cost, 0); assert.equal(measured.distance, 5);
  const base = { segments: [{ distance: 10, cost: 20 }, { distance: 10, cost: Infinity }], waypoints: [{}, {}, {}] };
  const merged = mergePerspectiveMeasurement(base, measured);
  assert.equal(merged.segments[0].cost, 0); assert.equal(merged.cost, Infinity);
  assert.equal(merged.waypoints[2].cost, Infinity);
});
test("grid patch honors disabled distance, bypass, and patches only once", () => {
  class Grid { measurePath() { return { untouched: true }; } }
  globalThis.foundry = { grid: { BaseGrid: Grid } };
  assert.equal(installPerspectiveMeasurementPatch(), true); assert.equal(installPerspectiveMeasurementPatch(), false);
  const grid = new Grid(), path = [gridPoint(4, 2), gridPoint(5, 3)];
  assert.equal(grid.measurePath(path)._perspectiveLevels, true);
  assert.deepEqual(grid.measurePath(path, { _perspectiveLevelsBypass: true }), { untouched: true });
  config.distance = false; assert.deepEqual(grid.measurePath(path), { untouched: true });
});

function makeKeyboardLayer() {
  class Layer {
    controlled = [];
    _prepareKeyboardMovementUpdates(objects, dx, dy, dz) {
      return [objects.map(o => ({ _id: o.document.id, x: o.document.x + dx * 100, y: o.document.y + dy * 100,
        elevation: o.document.elevation + dz * 5 })), { nativeOption: true }];
    }
    async moveMany({ dx = 0, dy = 0, dz = 0, includeLocked = false, rotate = false } = {}) {
      if (![dx, dy, dz].every(n => [-1, 0, 1].includes(n))) throw new Error("invalid direction");
      if (game.paused && !game.user.isGM) return [];
      const objects = this.controlled.filter(o => includeLocked || !o.document.locked);
      if (!objects.length) return [];
      const [data, options] = rotate ? [objects.map(o => ({ _id: o.document.id, rotation: 90 })), {}]
        : this._prepareKeyboardMovementUpdates(objects, dx, dy, dz);
      await canvas.scene.updateEmbeddedDocuments("Token", data, options);
      return objects;
    }
  }
  globalThis.foundry = { canvas: { layers: { TokenLayer: Layer } } };
  installPerspectiveTokenLayerMovementPatch();
  const layer = new Layer(), p = gridPoint(8, 5);
  layer.controlled = [{ document: { id: "a", x: p.x - 50, y: p.y - 100, elevation: 0 }, w: 100, h: 100 }];
  return layer;
}
test("keyboard movement uses perspective cells and preserves native elevation options", async () => {
  const layer = makeKeyboardLayer();
  await layer.moveMany({ dx: 1, dy: 1, dz: 1 });
  const u = updates[0][0]; assert.equal(u.elevation, 5);
  const destination = screenPointToPerspectiveGrid({ x: u.x + 50, y: u.y + 100, elevation: u.elevation }, config, rect);
  closeTo(destination.i, 9, 0.03); closeTo(destination.j, 6, 0.03);
});
test("keyboard preserves pause/locked/rotation checks and does not retry a rejected write", async () => {
  const layer = makeKeyboardLayer();
  game.paused = true; game.user.isGM = false; assert.deepEqual(await layer.moveMany({ dx: 1 }), []);
  game.paused = false; layer.controlled[0].document.locked = true; assert.deepEqual(await layer.moveMany({ dx: 1 }), []);
  await layer.moveMany({ dx: 1, includeLocked: true }); assert.equal(updates.length, 1);
  await layer.moveMany({ dx: 1, includeLocked: true, rotate: true }); assert.equal(updates[1][0].rotation, 90);
  let attempts = 0; canvas.scene.updateEmbeddedDocuments = async () => { attempts++; throw new Error("failed write"); };
  await assert.rejects(layer.moveMany({ dx: 1, includeLocked: true }), /failed write/); assert.equal(attempts, 1);
  await assert.rejects(layer.moveMany({ dx: 9 }), /invalid direction/);
});

test("grid overlay draws, switches visibility, reattaches and destroys without intercepting input", () => {
  const overlay = new PerspectiveGridOverlay();
  overlay.draw(); assert.ok(overlay.grid.lines.length > 0); assert.equal(overlay.container.eventMode, "none");
  config.grid = false; overlay.draw(); assert.equal(overlay.container.visible, false);
  overlay.forceVisible = true; overlay.draw(); assert.equal(overlay.container.visible, true);
  const parent = canvas.interface = new Container(); overlay.draw(); assert.equal(overlay.container.parent, parent);
  const graphics = overlay.grid; overlay.destroy(); assert.equal(graphics.destroyed, true); assert.equal(parent.children.length, 0);
});
test("calibrator wheel rotates only hovered anchors, with fine Shift increments", () => {
  const c = new PerspectiveCalibrator(); c.config = config; c.container = new Container(); c.level = canvas.level;
  c.anchors = { far: { position: { x: 20, y: 20 }, hitArea: new Rectangle(-10, -10, 20, 20) } };
  c._applyConfigChange = () => {};
  const event = { deltaY: 100, getLocalPosition: () => ({ x: 20, y: 20 }) };
  c._onWheel(event); assert.equal(c.config.far.rotation, 5);
  c._onWheel({ ...event, shiftKey: true, deltaY: -100 }); assert.equal(c.config.far.rotation, 4);
  c._onWheel({ ...event, getLocalPosition: () => ({ x: 80, y: 80 }) }); assert.equal(c.config.far.rotation, 4);
});
test("autosave serializes the final settings of multiple levels without losing queued edits", async () => {
  const c = new PerspectiveCalibrator(); let release;
  const first = new Promise(resolve => { release = resolve; });
  const a = { setFlag: async (_, __, cfg) => { writes.push(["a", cfg.gridScale]); if (writes.length === 1) await first; } };
  const b = { setFlag: async (_, __, cfg) => { writes.push(["b", cfg.gridScale]); } };
  c._pendingAutoSave = { level: a, config: normalizeConfig({ gridScale: 1 }) }; const one = c._flushAutoSave();
  c._pendingAutoSave = { level: a, config: normalizeConfig({ gridScale: 2 }) }; const two = c._flushAutoSave();
  c._pendingAutoSave = { level: b, config: normalizeConfig({ gridScale: 3 }) }; const three = c._flushAutoSave();
  release(); await Promise.all([one, two, three]); assert.deepEqual(writes, [["a", 1], ["a", 2], ["b", 3]]);
});
test("manual calibration save can finish after the panel was closed", async () => {
  const c = new PerspectiveCalibrator(); c.level = { name: "A", setFlag: async () => {} }; c.config = config;
  const pending = c.save(); c.level = null; await pending;
});
test("copied settings accept only known fields, validate values and normalize bounds", () => {
  const inputs = new Map([['gridScale', { value: '1' }], ['far.rotation', { value: '0' }], ['gridColor', { value: '#ffffff' }]]);
  for (const input of inputs.values()) input.dispatchEvent = () => {};
  const form = { querySelector: selector => inputs.get(selector.match(/perspective\.(.*)"\]/)?.[1]) };
  assert.equal(extractGridSettings(form).gridScale, 1);
  inputs.get('gridScale').value = '';
  assert.equal(applyGridSettings(form, {}), false); assert.equal(applyGridSettings(form, []), false);
  assert.equal(applyGridSettings(form, { gridScale: null }), false);
  assert.equal(applyGridSettings(form, { gridScale: 100, 'far.rotation': 370, unexpected: 1 }), true);
  assert.equal(Number(inputs.get('gridScale').value), 8); assert.equal(Number(inputs.get('far.rotation').value), 10);
});

test("a failed calibration save does not block subsequent saves", async t => {
  t.mock.method(console, 'warn', () => {});
  const c = new PerspectiveCalibrator(); c.config = config;
  c.level = { setFlag: async () => { throw new Error('offline'); } };
  await assert.rejects(c.save({ notify: false }), /offline/);
  c.level = { setFlag: async () => { writes.push('saved'); } };
  await c.save({ notify: false }); assert.deepEqual(writes, ['saved']);
});

test("calibrator installs a non-passive wheel listener and removes it on close", () => {
  let registered, removed;
  canvas.app = { view: { addEventListener: (...args) => { registered = args; }, removeEventListener: (...args) => { removed = args; } } };
  const c = new PerspectiveCalibrator(); c._createPanel = () => {};
  c.open();
  assert.equal(registered[0], 'wheel'); assert.equal(registered[2].passive, false);
  c.close(); assert.equal(removed[0], 'wheel'); assert.equal(removed[1], registered[1]);
});

test("keyboard Shift precision and disabled perspective retain native behavior", async () => {
  const layer = makeKeyboardLayer();
  game.keyboard.isModifierActive = () => true;
  await layer.moveMany({ dx: 1 });
  const u = updates[0][0];
  closeTo(screenPointToPerspectiveGrid({ x: u.x + 50, y: u.y + 100 }, config, rect).i, 8.5, 0.03);
  config.enabled = false; updates = [];
  await layer.moveMany({ dx: 1 });
  assert.equal(updates[0][0].x, layer.controlled[0].document.x + 100);
});
test("status redraw does not expose hidden effects and stops after token destruction", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, refreshes = 0;
  const token = { effects: { visible: false }, drawEffects: () => new Promise(resolve => { finish = resolve; }), _refreshEffects: () => { refreshes++; } };
  scheduleTokenStatusIconRefresh(token); t.mock.timers.tick(0); frames.shift()();
  assert.equal(token.effects.visible, false); token.destroyed = true; finish(); await Promise.resolve();
  assert.equal(refreshes, 0);
});

test("camera motion reuses grid geometry and does not dirty the scene graph", () => {
  const overlay = new PerspectiveGridOverlay();
  overlay.draw();
  let clears = 0;
  const clear = overlay.grid.clear.bind(overlay.grid);
  overlay.grid.clear = () => { clears++; clear(); };
  canvas.interface.sortDirty = false;
  for (let i = 0; i < 100; i++) overlay.draw();
  assert.equal(clears, 0); assert.equal(canvas.interface.sortDirty, false);
  config.far.x += 0.05; overlay.draw(); assert.equal(clears, 1);
  canvas.dimensions.sceneWidth += 500; overlay.draw(); assert.equal(clears, 2);
  config.gridColor = '#123456'; overlay.draw(); assert.equal(clears, 3);
  config.grid = false; overlay.draw();
  overlay.forceVisible = true; overlay.draw(); assert.equal(clears, 3);
  overlay.destroy(); overlay.draw(); assert.ok(overlay.grid.lines.length > 0);
});

test("overlay detaches the original ticker and notices levels with identical local IDs", () => {
  const callbacks = new Set();
  const oldTicker = { add: fn => callbacks.add(fn), remove: fn => callbacks.delete(fn) };
  canvas.app = { ticker: oldTicker };
  const overlay = new PerspectiveGridOverlay(); let changes = 0;
  overlay.onLevelChange = () => { changes++; };
  overlay.startTicker(); overlay.startTicker(); assert.equal(callbacks.size, 1);
  canvas.level = { ...canvas.level, uuid: 'Scene.b.Level.a' };
  overlay._ticker(); assert.equal(changes, 1);
  canvas.app.ticker = { remove() {} };
  overlay.destroy(); assert.equal(callbacks.size, 0);
});

test("runtime settings reuse normalization but detect nested edits and remain isolated from public copies", () => {
  const first = getRuntimeLevelConfig();
  for (let i = 0; i < 100; i++) assert.equal(getRuntimeLevelConfig(), first);
  const editable = getLevelConfig(); editable.far.x = 0.2;
  assert.notEqual(first.far.x, 0.2);
  assert.throws(() => { first.far.x = 0.2; }, TypeError);
  config.far.x = 0.2;
  const changed = getRuntimeLevelConfig(); assert.notEqual(changed, first); assert.equal(changed.far.x, 0.2);
  setLevelConfigOverride(canvas.level, { gridScale: 3 }); assert.equal(getRuntimeLevelConfig().gridScale, 3);
  clearLevelConfigOverride(); assert.equal(getRuntimeLevelConfig().gridScale, 1);
  config.enabled = ['false', 'true']; assert.equal(getRuntimeLevelConfig().enabled, true);
  config.enabled[1] = 'false'; assert.equal(getRuntimeLevelConfig().enabled, false);
  config.grid = undefined; assert.equal(getRuntimeLevelConfig().grid, false);
  delete config.grid; assert.equal(getRuntimeLevelConfig().grid, true);
});

test("actor lookup uses the native index without scanning every scene token", () => {
  const token = {}; const actor = { getActiveTokens: () => [token] };
  canvas.tokens.placeables = { [Symbol.iterator]() { throw new Error('full scan'); } };
  assert.deepEqual([...collectTokensForActor(actor)], [token]);
});

test("synthetic actor lookup does not match another token with the same base actor ID", () => {
  const actor = { id: 'same', uuid: 'Scene.a.Token.one.Actor.same', isToken: true };
  const own = { actor }, other = { actor: { ...actor, uuid: 'Scene.a.Token.two.Actor.same' } };
  canvas.tokens.placeables = [own, other, { actor: { id: 'same', uuid: 'Actor.same' } }];
  assert.deepEqual([...collectTokensForActor(actor)], [own]);
});

test("effect event bursts coalesce to one redraw per retry deadline", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let draws = 0;
  const token = { async drawEffects() { draws++; } };
  for (let i = 0; i < 100; i++) scheduleTokenStatusIconRefreshBurst(token);
  for (const delta of [0, 60, 120, 180]) {
    t.mock.timers.tick(delta);
    while (frames.length) frames.shift()();
    await Promise.resolve();
  }
  assert.equal(draws, 4);
});

test("effect redraws serialize and coalesce updates arriving during a slow draw", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, draws = 0, positions = 0;
  const token = { drawEffects() { draws++; return new Promise(resolve => { finish = resolve; }); }, _refreshEffects() { positions++; } };
  const flush = () => { t.mock.timers.tick(0); while (frames.length) frames.shift()(); };
  scheduleTokenStatusIconRefresh(token); flush();
  for (let i = 0; i < 100; i++) scheduleTokenStatusIconRefresh(token);
  flush(); assert.equal(draws, 1);
  finish(); await Promise.resolve(); flush(); assert.equal(draws, 2);
  finish(); await Promise.resolve(); assert.equal(positions, 2);
});

test("pending effects cannot mutate an old canvas after teardown even if the same scene is reopened", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, positions = 0;
  const token = { drawEffects: () => new Promise(resolve => { finish = resolve; }), _refreshEffects() { positions++; } };
  scheduleTokenStatusIconRefresh(token); t.mock.timers.tick(0); frames.shift()();
  clearTokenStatusIconRefreshState();
  finish(); await Promise.resolve(); assert.equal(positions, 0); assert.equal(frames.length, 0);
});

test("effects completing after a scene change skip position and render updates", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, positions = 0;
  const token = { drawEffects: () => new Promise(resolve => { finish = resolve; }), _refreshEffects() { positions++; } };
  scheduleTokenStatusIconRefresh(token); t.mock.timers.tick(0); frames.shift()();
  canvas.scene = {};
  finish(); await Promise.resolve(); assert.equal(positions, 0);
});

test("inactive perspective does not scan actors or queue effect work", t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  config.enabled = false;
  scheduleActorStatusIconRefreshBurst({ getActiveTokens() { throw new Error('should not query'); } });
  scheduleTokenStatusIconRefreshBurst({ drawEffects() { throw new Error('should not draw'); } });
  t.mock.timers.runAll(); assert.equal(frames.length, 0);
});

test("runtime grid models are shared until geometry changes without caching mutable drafts", () => {
  const cfg = getRuntimeLevelConfig();
  const model = getCachedPerspectiveGridModel(cfg, rect);
  for (let i = 0; i < 100; i++) assert.equal(getCachedPerspectiveGridModel(cfg, { ...rect }), model);
  assert.notEqual(getCachedPerspectiveGridModel(cfg, { ...rect, width: rect.width + 100 }), model);
  config.near.x = 0.8;
  assert.notEqual(getCachedPerspectiveGridModel(getRuntimeLevelConfig(), rect), model);
  const draft = getLevelConfig(); const before = getCachedPerspectiveGridModel(draft, rect);
  draft.near.x = 0.2;
  const after = getCachedPerspectiveGridModel(draft, rect);
  assert.notEqual(before.near.center.x, after.near.center.x);
  const publicModel = getPerspectiveGridModel(cfg, rect); publicModel.near.center.x = -1;
  assert.notEqual(model.near.center.x, -1);
});
