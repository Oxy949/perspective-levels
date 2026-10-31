import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { installTokenPerspectiveLifecyclePatches } from "../scripts/modules/token-lifecycle-patches.js";
import { installTokenPerspectiveShapePatch } from "../scripts/modules/token-hit-testing.js";
import { clearPerspectiveUpdateState, collectTokenAndDragPreviews, schedulePerspectiveUpdate, applyOrSchedulePerspectiveUpdate } from "../scripts/modules/token-update-queue.js";
import { applyPerspectiveToToken, clearPerspectiveSortState, clearTokenScaleState, getTokenGroundPoint, removePerspectiveFromToken, schedulePerspectiveSort } from "../scripts/modules/tokens.js";
import { registerHooks, gridOverlay, calibrator } from "../scripts/modules/runtime.js";
import { getTokenArtMultiplier, isTokenArtMultiplierUpdate } from "../scripts/modules/token-art.js";
import { getPerspectiveGridModel, perspectiveGridModelToScreen, perspectiveGroundPointToElevatedScreen, screenPointToPerspectiveGrid } from "../scripts/modules/projection.js";
import { normalizeConfig } from "../scripts/modules/config.js";

class Point {
  constructor(x = 0, y = 0) { this.set(x, y); }
  set(x, y = x) { this.x = x; this.y = y; }
}

class Container {
  children = [];
  addChild(child) { return this.addChildAt(child, this.children.length); }
  addChildAt(child, index) {
    child.parent?.removeChild(child);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  }
  getChildIndex(child) { return this.children.indexOf(child); }
  removeChild(child) {
    this.children.splice(this.getChildIndex(child), 1);
    child.parent = null;
  }
}

class Graphics {
  position = new Point();
  scale = new Point(1, 1);
  ellipses = [];
  clear() { this.ellipses = []; }
  beginFill(color, alpha) { this.fillAlpha = alpha; }
  drawEllipse(x, y, rx, ry) { this.ellipses.push({ x, y, rx, ry, alpha: this.fillAlpha }); }
  endFill() {}
  destroy() { this.parent?.removeChild(this); this.destroyed = true; }
}

class PrimaryGraphics extends Graphics {}
class Rectangle {
  constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
}

let config;
let frameCallbacks;
let committedMovements;
let shiftDown;

class Token {
  constructor(id, { x = 200, y = 700, elevation = 0, width = 1, height = 1, texture = {} } = {}) {
    const source = { x, y, elevation, width, height };
    this.document = {
      ...source, _source: { ...source }, id, uuid: `Scene.test.Token.${id}`, documentName: "Token", sort: 100000,
      texture: { src: "token.webp", scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, ...texture },
      sourceWrites: 0, extraUpdates: 0,
      updateSource(changes) {
        this.sourceWrites++;
        Object.assign(this._source, changes);
        Object.assign(this, changes);
      },
      update() { this.extraUpdates++; return Promise.resolve(); }
    };
    this.document.getSize = function(data = this) { return { width: data.width * 100, height: data.height * 100 }; };
    this.document.getMovementOrigin = function(data = {}) {
      return { x: (data.x ?? this.x) + (data.width ?? this.width) * 50,
        y: (data.y ?? this.y) + (data.height ?? this.height) * 50, elevation: data.elevation ?? this.elevation };
    };
    this.w = width * 100;
    this.h = height * 100;
    this.position = new Point(x, y);
    this.mesh = {
      texture: { orig: { width: 100, height: 100 } },
      scale: new Point(1, 1), anchor: new Point(this.document.texture.anchorX, this.document.texture.anchorY),
      position: new Point(x + this.w / 2, y + this.h / 2), sort: 100000, sortLayer: 600, alpha: 1
    };
    this.visible = true;
    this.renderFlags = { set: flags => { this.pendingFlags = { ...this.pendingFlags, ...flags }; } };
    this.layer = canvas.tokens;
    this.mouseInteractionManager = { interactionData: {} };
    canvas.primary.addChild(this.mesh);
  }

  getShape() { return new Rectangle(0, 0, this.w, this.h); }
  _refreshShape() { this.hitArea = this.shape = this.getShape(); }
  _refreshElevation() { this.mesh.elevation = this.document.elevation; }
  _refreshState() { this.visible = this.nextVisible ?? true; }
  applyRenderFlags() {
    const flags = this.pendingFlags;
    this.pendingFlags = {};
    if (flags?.refreshElevation) this._refreshElevation();
  }

  // Model the v14 workflow: original tokens calculate waypoints, clones display
  // them, and one movement operation commits the group before clone cleanup.
  _initializeDragLeft(event) {
    const data = event.interactionData;
    data.clones = data.tokens.map(token => ({
      _original: token,
      _onDragEnd: Token.prototype._onDragEnd,
      document: { ...token.document }
    }));
    data.contexts = data.clones.map(clone => ({ token: clone._original, clone, destination: { ...clone.document._source } }));
    this.mouseInteractionManager.interactionData = data;
    this.layer._draggedToken = this;
  }
  _getDragWaypointPosition(current, changes) {
    return { x: Math.round(changes.x ?? current.x), y: Math.round(changes.y ?? current.y), elevation: changes.elevation ?? current.elevation };
  }
  _onDragLeftMove(event) {
    for (const context of event.interactionData.contexts) {
      const source = context.token.document._source;
      context.destination = context.token._getDragWaypointPosition(context.destination,
        { x: source.x + event.dx, y: source.y + event.dy });
      Object.assign(context.clone.document, context.destination);
    }
  }
  _onDragClickLeft(event) { this._onDragLeftMove(event); }
  _onDragLeftDrop(event) {
    if (event.preventDrop) return false;
    committedMovements++;
    for (const context of event.interactionData.contexts) {
      Object.assign(context.token.document._source, context.destination);
      Object.assign(context.token.document, context.destination);
    }
    event.interactionData.dropped = true;
    this._finalizeDragLeft(event);
  }
  _finalizeDragLeft(event) {
    for (const clone of event.interactionData.clones) clone._onDragEnd();
    this.layer._draggedToken = null;
  }
  _onDragEnd() {}
  _onDragStart() {}
  constrainMovementPath(points, { fail = false } = {}) {
    const kept = [];
    for (const point of points) {
      const origin = this.document.getMovementOrigin(point);
      if (fail) throw new Error('native collision failure');
      if (!canvas.dimensions.rect.contains(origin.x, origin.y)) return { points: kept, constrained: true };
      kept.push(point);
    }
    return { points: kept, constrained: false };
  }
}

globalThis.PIXI = { Graphics, Rectangle };
globalThis.foundry = { canvas: { primary: { PrimaryGraphics }, placeables: { Token } } };
installTokenPerspectiveLifecyclePatches();
installTokenPerspectiveShapePatch();
const hooks = new Map();
globalThis.Hooks = { on: (name, callback) => hooks.set(name, callback), once() {} };
registerHooks();

beforeEach(() => {
  clearPerspectiveUpdateState();
  clearPerspectiveSortState();
  clearTokenScaleState();
  config = { enabled: true, tokenScaling: true, tokenArtVerticalAlign: 0, far: { scale: 0.6 }, near: { scale: 0.6 } };
  frameCallbacks = [];
  committedMovements = 0;
  shiftDown = false;
  globalThis.requestAnimationFrame = callback => frameCallbacks.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.game = { user: { isGM: true }, keyboard: { isModifierActive: key => key === "SHIFT" && shiftDown } };
  globalThis.canvas = {
    ready: true, dimensions: { size: 100, sceneWidth: 2000, sceneHeight: 1500 },
    grid: { size: 100, distance: 5 },
    level: { id: "test", getFlag: () => config },
    scene: { grid: { size: 100, distance: 5 } },
    primary: new Container(), tokens: { placeables: [], preview: new Container() }
  };
});

function startDrag(tokens) {
  const event = { interactionData: { tokens }, shiftKey: true, dx: 0, dy: -50 };
  tokens[0]._initializeDragLeft(event);
  return event;
}

function closeTo(actual, expected, tolerance = 0.00001) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${actual} to equal ${expected}`);
}

function artBounds(token) {
  const mesh = token.mesh;
  const signedHeight = mesh.texture.orig.height * mesh.scale.y;
  const edge = mesh.position.y - token.position.y - mesh.anchor.y * signedHeight;
  return { top: Math.min(edge, edge + signedHeight), bottom: Math.max(edge, edge + signedHeight) };
}

function shadowOf(token) {
  return canvas.primary.children.find(child => child._perspectiveLevelsToken === token);
}

test("a large scene sorts each display container once per batch", () => {
  const tokens = Array.from({ length: 120 }, (_, i) => new Token(`token-${i}`, { y: 200 + i * 5 }));
  canvas.tokens.placeables = tokens;
  let sorts = 0;
  canvas.primary.sortChildren = () => { sorts++; };
  schedulePerspectiveSort({ force: true });
  framesUntilIdle();
  assert.equal(sorts, 1);
});

test("warm token refreshes do not scan scene children or redraw unchanged shadows", () => {
  const tokens = Array.from({ length: 80 }, (_, i) => new Token(`token-${i}`));
  for (const token of tokens) applyPerspectiveToToken(token, { scheduleSort: false });
  let visits = 0;
  let redraws = 0;
  canvas.primary.children[Symbol.iterator] = function* () {
    for (let i = 0; i < this.length; i++) { visits++; yield this[i]; }
  };
  for (const token of tokens) {
    const shadow = shadowOf(token);
    const clear = shadow.clear.bind(shadow);
    shadow.clear = () => { redraws++; clear(); };
  }
  for (let frame = 0; frame < 3; frame++) {
    for (const token of tokens) applyPerspectiveToToken(token, { scheduleSort: false });
  }
  assert.equal(visits, 0);
  assert.equal(redraws, 0);
});

test("group drag updates each token family once instead of updating unrelated previews", () => {
  const originals = Array.from({ length: 30 }, (_, i) => new Token(`token-${i}`));
  const previews = originals.map(original => {
    const clone = new Token(original.document.id);
    clone._original = original;
    clone.actor = original.actor;
    canvas.tokens.preview.addChild(clone);
    return clone;
  });
  const family = collectTokenAndDragPreviews(originals[0]);
  assert.equal(family.length, 2);
  assert.equal(family[0] === originals[0] && family[1] === previews[0], true);
  const updates = new Map();
  for (const token of [...originals, ...previews]) {
    const set = token.mesh.scale.set.bind(token.mesh.scale);
    token.mesh.scale.set = (...args) => {
      updates.set(token, (updates.get(token) ?? 0) + 1);
      set(...args);
    };
  }
  for (const token of [...originals, ...previews]) schedulePerspectiveUpdate(token);
  // Run only the update batch; depth sorting is queued for the next frame.
  frameCallbacks.shift()();
  for (const token of [...originals, ...previews]) assert.equal(updates.get(token), 1);
});

test("a 120-token drag scans shared previews once per update and once per sort", () => {
  const originals = Array.from({ length: 120 }, (_, i) => new Token(`token-${i}`, { y: 200 + i * 6 }));
  const previews = originals.map((original, i) => {
    const clone = new Token(original.document.id, { y: 1200 - i * 6 }); clone._original = original;
    canvas.tokens.preview.addChild(clone); return clone;
  });
  canvas.tokens.placeables = originals;
  let visits = 0;
  canvas.tokens.preview.children[Symbol.iterator] = function* () {
    for (let i = 0; i < this.length; i++) { visits++; yield this[i]; }
  };
  for (const token of originals) schedulePerspectiveUpdate(token);
  frameCallbacks.shift()(); assert.equal(visits, 120);
  for (const preview of previews) assert.ok(preview.mesh._perspectiveLevelsAppliedScale);
  framesUntilIdle(); assert.equal(visits, 240);
  assert.ok(originals[0].document.sort > originals.at(-1).document.sort);
});

test("a synthetic actor height change only queues its own token", () => {
  const actor = { id: 'same', uuid: 'Scene.test.Token.a.Actor.same', isToken: true };
  const own = new Token('a'), other = new Token('b');
  own.actor = actor; other.actor = { ...actor, uuid: 'Scene.test.Token.b.Actor.same' };
  canvas.tokens.placeables = [own, other];
  hooks.get('updateActor')(actor, { 'flags.ginzzzu-portraits.emotionHeightMultiplier': 2 });
  frameCallbacks.shift()();
  assert.ok(own.mesh._perspectiveLevelsAppliedScale);
  assert.equal(other.mesh._perspectiveLevelsAppliedScale, undefined);
});

test("a group changes height without touching originals and can be dragged again after drop", () => {
  const tokens = [new Token("a"), new Token("b", { x: 500, y: 800, elevation: 5 })];
  const source = tokens.map(token => ({ ...token.document._source }));
  const event = startDrag(tokens);
  tokens[0]._onDragLeftMove(event);
  for (let i = 0; i < tokens.length; i++) {
    assert.deepEqual(tokens[i].document._source, source[i]);
    assert.equal(tokens[i].document.elevation, source[i].elevation);
    assert.equal(tokens[i].document.sourceWrites, 0);
    assert.ok(event.interactionData.contexts[i].destination.elevation > source[i].elevation);
  }
  const destinations = event.interactionData.contexts.map(context => ({ ...context.destination }));
  tokens[0]._onDragLeftDrop(event);
  assert.equal(committedMovements, 1);
  assert.equal(canvas.tokens._draggedToken, null);
  tokens.forEach((token, i) => {
    assert.equal(token.document.y, destinations[i].y);
    assert.equal(token.document.elevation, destinations[i].elevation);
    assert.equal(token.document.extraUpdates, 0);
  });

  const next = startDrag(tokens);
  next.shiftKey = false;
  next.dx = 90;
  next.dy = 30;
  tokens[0]._onDragLeftMove(next);
  tokens[0]._onDragLeftDrop(next);
  assert.equal(committedMovements, 2);
  tokens.forEach((token, i) => {
    assert.equal(token.document.x, destinations[i].x + 90);
    assert.equal(token.document.y, destinations[i].y + 30);
    assert.equal(token.document.elevation, destinations[i].elevation);
  });
});

test("cancelling a group's height preview leaves every original unchanged", () => {
  const tokens = [new Token("a"), new Token("b", { elevation: -5 })];
  const before = tokens.map(token => ({ ...token.document._source }));
  const event = startDrag(tokens);
  tokens[0]._onDragLeftMove(event);
  tokens[0]._finalizeDragLeft(event);
  assert.equal(committedMovements, 0);
  tokens.forEach((token, i) => assert.deepEqual(token.document._source, before[i]));
  tokens.forEach(token => assert.equal(token.document.extraUpdates, 0));

  tokens[1].document.y = tokens[1].document._source.y += 100;
  const next = startDrag(tokens);
  next.dy = 0;
  tokens[0]._onDragLeftMove(next);
  assert.equal(next.interactionData.contexts[1].destination.elevation, -5);
});

test("a prevented drop keeps the active preview and does not save height", () => {
  const token = new Token("a");
  const event = startDrag([token]);
  token._onDragLeftMove(event);
  event.preventDrop = true;
  assert.equal(token._onDragLeftDrop(event), false);
  assert.equal(canvas.tokens._draggedToken, token);
  assert.equal(token.document.elevation, 0);
  event.preventDrop = false;
  token._onDragLeftDrop(event);
  assert.equal(committedMovements, 1);
});

test("explicit elevation changes take precedence over Shift flight", () => {
  const token = new Token("a");
  shiftDown = true;
  const current = token.document._source;
  assert.equal(token._getDragWaypointPosition(current, { elevation: 15 }).elevation, 15);
  assert.equal(token._getDragWaypointPosition(current, { y: 650, elevation: -10 }).elevation, -10);
});

test("high Shift flight keeps the same ground position and perspective size", () => {
  config = normalizeConfig({ enabled: true });
  const token = new Token('a');
  applyPerspectiveToToken(token, { scheduleSort: false });
  const ground = getTokenGroundPoint(token), scale = token.mesh._perspectiveLevelsAppliedScale;
  const event = startDrag([token]);
  for (const dy of [-100, -300, -800]) {
    event.dx = 0; event.dy = dy; token._onDragLeftMove(event);
    const destination = event.interactionData.contexts[0].destination;
    const clone = new Token('a', destination); clone._original = token;
    applyPerspectiveToToken(clone, { scheduleSort: false });
    const restored = getTokenGroundPoint(clone);
    closeTo(restored.x, ground.x, 0.1); closeTo(restored.y, ground.y, 0.1);
    closeTo(clone.mesh._perspectiveLevelsAppliedScale, scale, 0.001);
  }
});

test("token drag snapping follows perspective cell coordinates at altitude", () => {
  config = normalizeConfig({ enabled: true, gridScale: 2 });
  const token = new Token('a');
  const rect = { x: 0, y: 0, width: 2000, height: 1500, gridSize: 100 }, model = getPerspectiveGridModel(config, rect);
  const ground = perspectiveGridModelToScreen(model, 5.76, 6.3);
  const position = perspectiveGroundPointToElevatedScreen({ ...ground, elevation: 25 }, config, rect, model);
  const current = { x: position.x - 50, y: position.y - 100, elevation: 25 };
  const result = token._getDragWaypointPosition(current, { x: current.x, y: current.y }, { snap: true });
  const coords = screenPointToPerspectiveGrid({ x: result.x + 50, y: result.y + 100, elevation: 25 }, config, rect, model);
  closeTo(coords.i, 5.5, 0.02); closeTo(coords.j, 6, 0.02);
});

test("native scene bounds accept a flyer above the canvas while its ground point remains inside", () => {
  config = normalizeConfig({ enabled: true });
  const token = new Token('a'), rect = { x: 0, y: 0, width: 2000, height: 1500, gridSize: 100 };
  canvas.dimensions.rect = { contains: (x, y) => x >= 0 && x <= 2000 && y >= 0 && y <= 1500 };
  const ground = perspectiveGridModelToScreen(getPerspectiveGridModel(config, rect), 10, 2);
  const raised = perspectiveGroundPointToElevatedScreen({ ...ground, elevation: 50 }, config, rect);
  const destination = { x: raised.x - 50, y: raised.y - 100, elevation: 50, width: 1, height: 1 };
  assert.ok(destination.y < 0);
  const nativeOrigin = token.document.getMovementOrigin, nativeContains = canvas.dimensions.rect.contains;
  assert.equal(token.constrainMovementPath([destination]).constrained, false);
  assert.equal(token.constrainMovementPath([destination, { ...destination, elevation: 0 }]).constrained, true);
  assert.equal(canvas.dimensions.rect.contains(raised.x, raised.y), false);
  assert.throws(() => token.constrainMovementPath([destination], { fail: true }), /native collision failure/);
  assert.equal(token.document.getMovementOrigin, nativeOrigin); assert.equal(canvas.dimensions.rect.contains, nativeContains);
  const outside = { ...destination, x: -5000 };
  assert.equal(token.constrainMovementPath([outside]).constrained, true);
});

test("ordinary movement retains the preview elevation when Shift is released", () => {
  const token = new Token("a");
  const event = startDrag([token]);
  token._onDragLeftMove(event);
  const elevation = event.interactionData.contexts[0].destination.elevation;
  event.shiftKey = false;
  event.dy = -80;
  token._onDragLeftMove(event);
  assert.equal(event.interactionData.contexts[0].destination.elevation, elevation);
});

test("flight is inactive when perspective is disabled", () => {
  config.enabled = false;
  const token = new Token("a", { elevation: 5 });
  const event = startDrag([token]);
  token._onDragLeftMove(event);
  assert.equal(event.interactionData.contexts[0].destination.elevation, 5);
});

for (const scaleY of [2, -2]) {
  test(`bottom, middle and top alignment match art and hit area with texture scale Y ${scaleY}`, () => {
    const token = new Token("art", { width: 1, height: 2, texture: { anchorY: 0.75, scaleY } });
    token.mesh.texture.orig = { width: 80, height: 300 };
    for (const perspectiveScale of [0.3, 0.9, 1.8]) {
      config.near.scale = config.far.scale = perspectiveScale;
      for (const align of [0, 0.5, 1]) {
        config.tokenArtVerticalAlign = align;
        for (let refresh = 0; refresh < 3; refresh++) {
          applyPerspectiveToToken(token, { scheduleSort: false });
          const bounds = artBounds(token);
          if (align === 0) closeTo(bounds.bottom, token.h);
          if (align === 0.5) closeTo((bounds.top + bounds.bottom) / 2, token.h / 2);
          if (align === 1) closeTo(bounds.top, 0);
          closeTo(token.hitArea.y, bounds.top);
          closeTo(token.hitArea.y + token.hitArea.height, bounds.bottom);
        }
      }
    }
    config.tokenArtVerticalAlign = 0;
    applyPerspectiveToToken(token, { scheduleSort: false });
    token.document.texture.scaleY *= 1.5;
    applyPerspectiveToToken(token, { scheduleSort: false });
    closeTo(artBounds(token).bottom, token.h);
    removePerspectiveFromToken(token);
    assert.equal(token.mesh.anchor.y, 0.75);
  });
}

test("all elevations have a ground shadow, including when token scaling is disabled", () => {
  for (const tokenScaling of [true, false]) {
    config.tokenScaling = tokenScaling;
    for (const elevation of [0, 10, -10]) {
      const token = new Token(`${tokenScaling}-${elevation}`, { elevation });
      applyPerspectiveToToken(token, { scheduleSort: false });
      const shadow = shadowOf(token);
      assert.ok(shadow instanceof PrimaryGraphics);
      assert.equal(shadow.ellipses.length, 3);
      const ground = getTokenGroundPoint(token);
      closeTo(shadow.position.x, ground.x);
      closeTo(shadow.position.y, ground.y);
      assert.equal(shadow.elevation, Math.max(0, elevation));
      assert.equal(shadow.sortLayer, token.mesh.sortLayer);
      assert.ok(shadow.sort < token.mesh.sort);
      assert.equal(shadow.eventMode, "none");
      removePerspectiveFromToken(token);
      assert.equal(shadow.destroyed, true);
    }
  }
});

test("destroying a drag clone never adopts or destroys its original's shadow", () => {
  const original = new Token("same-id");
  const clone = new Token("same-id", { y: 600 });
  clone._original = original;
  applyPerspectiveToToken(original, { scheduleSort: false });
  const originalShadow = shadowOf(original);
  for (let i = 0; i < 3; i++) {
    applyPerspectiveToToken(clone, { scheduleSort: false });
    applyPerspectiveToToken(original, { scheduleSort: false });
  }
  const cloneShadow = shadowOf(clone);
  assert.notEqual(originalShadow, cloneShadow);
  assert.equal(shadowOf(original), originalShadow);
  removePerspectiveFromToken(clone);
  assert.equal(cloneShadow.destroyed, true);
  assert.equal(originalShadow.destroyed, undefined);
  assert.equal(shadowOf(original), originalShadow);
});

test("shadows follow token visibility and alpha, and are removed with perspective", () => {
  const token = new Token("a");
  applyPerspectiveToToken(token, { scheduleSort: false });
  const shadow = shadowOf(token);
  token.nextVisible = false;
  token._refreshState();
  assert.equal(shadow.visible, false);
  token.nextVisible = true;
  token.mesh.alpha = 0.35;
  token._refreshState();
  assert.equal(shadow.visible, true);
  assert.equal(shadow.alpha, 0.35);
  config.enabled = false;
  applyPerspectiveToToken(token, { scheduleSort: false });
  assert.equal(shadow.destroyed, true);
});

test("sorting and elevation refresh settle without queuing an endless render loop", () => {
  const token = new Token("a");
  canvas.tokens.placeables = [token];
  applyPerspectiveToToken(token);
  assert.equal(frameCallbacks.length, 1);
  frameCallbacks.shift()();
  assert.equal(frameCallbacks.length, 0);
});

test("native Alt state refresh swaps the border for an outline and clears it on release", () => {
  const previous = foundry.canvas.rendering;
  try {
    const filters = [];
    foundry.canvas.rendering = { filters: { OutlineOverlayFilter: { create(uniforms) {
      const filter = { uniforms, destroy() { this.destroyed = true; } }; filters.push(filter); return filter;
    } } } };
    const token = new Token('alt'); token.border = { renderable: true };
    canvas.tokens.highlightObjects = true; token._refreshState();
    assert.equal(filters.length, 1); assert.equal(token.border.renderable, false);
    canvas.tokens.highlightObjects = false; token._refreshState();
    assert.equal(token.border.renderable, true); assert.equal(filters[0].destroyed, true);
  } finally { foundry.canvas.rendering = previous; }
});

test("hit bounds follow a mesh position refresh even when token position was refreshed first", () => {
  const token = new Token("a");
  applyPerspectiveToToken(token, { scheduleSort: false });
  const initialX = token.hitArea.x;
  token.position.x += 100;
  applyPerspectiveToToken(token, { scheduleSort: false });
  token.mesh.position.x += 100;
  applyPerspectiveToToken(token, { scheduleSort: false });
  closeTo(token.hitArea.x, initialX);
});

test("portrait art multiplier is optional, uniform, live and never changes ground footprint", () => {
  const token = new Token("a");
  token.actor = { flags: { 'ginzzzu-portraits': { portraitHeightMultiplier: 1.8 } } };
  game.modules = new Map();
  applyPerspectiveToToken(token, { scheduleSort: false });
  const base = token.mesh.scale.x;
  const radius = shadowOf(token).ellipses[0].rx;
  game.modules.set('ginzzzu-portraits', { active: false });
  applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, base);
  game.modules.get('ginzzzu-portraits').active = true;
  for (let i = 0; i < 3; i++) {
    applyPerspectiveToToken(token, { scheduleSort: false });
    closeTo(token.mesh.scale.x, base * 1.8); closeTo(token.mesh.scale.y, base * 1.8);
    closeTo(artBounds(token).bottom, token.h); closeTo(shadowOf(token).ellipses[0].rx, radius);
  }
  for (const invalid of [undefined, null, '', '  ', false, -1, NaN, Infinity, 'bad']) {
    token.actor.flags['ginzzzu-portraits'].portraitHeightMultiplier = invalid;
    applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, base);
  }
  token.actor.flags['ginzzzu-portraits'].portraitHeightMultiplier = 0;
  applyPerspectiveToToken(token, { scheduleSort: false }); assert.equal(token.mesh.scale.x, 0);
  token.actor.flags['ginzzzu-portraits'].portraitHeightMultiplier = 2;
  applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, base * 2);
  config.enabled = false; applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, 1);
});

test("actor flag updates refresh both the original and its active drag preview", () => {
  game.modules = new Map([['ginzzzu-portraits', { active: true }]]);
  const actor = { id: 'actor', getFlag: (_module, key) => key === 'portraitHeightMultiplier' ? 1.5 : undefined };
  const original = new Token('a'), clone = new Token('a');
  original.actor = clone.actor = actor; clone._original = original;
  canvas.tokens.placeables = [original]; canvas.tokens.preview.addChild(clone);
  hooks.get('updateActor')(actor, { flags: { 'ginzzzu-portraits': { portraitHeightMultiplier: 1.5 } } });
  framesUntilIdle();
  closeTo(original.mesh.scale.x, 0.9); closeTo(clone.mesh.scale.x, 0.9);
});

test("emotion art and height changes update tokens and previews without moving their feet or shadows", () => {
  game.modules = new Map([['ginzzzu-portraits', { active: true }]]);
  const flags = { portraitHeightMultiplier: 1.5 };
  const actor = { id: 'actor', flags: { 'ginzzzu-portraits': flags } };
  const original = new Token('a'), clone = new Token('a');
  original.actor = clone.actor = actor;
  original.document.object = original;
  clone._original = original;
  canvas.tokens.placeables = [original];
  canvas.tokens.preview.addChild(clone);
  applyPerspectiveToToken(original, { scheduleSort: false });
  const radius = shadowOf(original).ellipses[0].rx;
  closeTo(original.mesh.scale.y, 0.9);

  flags.portraitEmotion = 'custom_0';
  flags.emotionHeightMultiplier = 2;
  hooks.get('updateActor')(actor, { flags: { 'ginzzzu-portraits': {
    portraitEmotion: 'custom_0', emotionHeightMultiplier: 2
  } } });
  framesUntilIdle();
  closeTo(original.mesh.scale.y, 1.8);
  closeTo(clone.mesh.scale.y, 1.8);

  // A tall replacement texture arrives after the actor update and native fade starts.
  original.document.texture.src = 'emotion.webp';
  original.mesh.texture.orig = { width: 100, height: 300 };
  hooks.get('updateToken')(original.document, { texture: { src: 'emotion.webp' } }, {
    animate: true, animation: { duration: 320, transition: 'fade' }
  });
  clone.document.texture.src = 'emotion.webp';
  clone.mesh.texture.orig = { width: 100, height: 300 };
  hooks.get('drawToken')(clone);
  framesUntilIdle();

  for (const token of [original, clone]) {
    closeTo(token.mesh.scale.y * token.mesh.texture.orig.height, 180);
    closeTo(artBounds(token).bottom, token.h);
    assert.equal(token.document.height, 1);
    assert.equal(token.document.width, 1);
    assert.equal(token.document.texture.scaleY, 1);
    assert.equal(token.document.sourceWrites, 0);
    assert.equal(token.document.extraUpdates, 0);
  }
  closeTo(shadowOf(clone).ellipses[0].rx, radius);

  delete flags.emotionHeightMultiplier;
  flags.portraitEmotion = null;
  hooks.get('updateActor')(actor, { flags: { 'ginzzzu-portraits': {
    portraitEmotion: null, '-=emotionHeightMultiplier': null
  } } });
  framesUntilIdle();
  for (const token of [original, clone]) {
    closeTo(token.mesh.scale.y * token.mesh.texture.orig.height, 90);
    closeTo(artBounds(token).bottom, token.h);
  }
});

test("emotion height flags support defaults, numeric strings, zero, invalid values and preview actors", () => {
  game.modules = new Map([['ginzzzu-portraits', { active: true }]]);
  const flags = { portraitHeightMultiplier: 1.5 };
  const actor = { flags: { 'ginzzzu-portraits': flags } };
  const preview = { _original: { actor } };
  for (const [value, expected] of [[2, 3], ['0.5', 0.75], [0, 0], [null, 1.5],
    ['', 1.5], [-1, 1.5], [NaN, 1.5], [Infinity, 1.5], [false, 1.5], ['bad', 1.5]]) {
    flags.emotionHeightMultiplier = value;
    assert.equal(getTokenArtMultiplier(preview), expected);
  }
  delete flags.portraitHeightMultiplier;
  flags.emotionHeightMultiplier = 2;
  assert.equal(getTokenArtMultiplier({ document: { actor } }), 2);
});

test("only height-affecting portrait flags queue perspective work, including flag deletions", () => {
  for (const changes of [
    { flags: { 'ginzzzu-portraits': { emotionHeightMultiplier: 1.5 } } },
    { 'flags.ginzzzu-portraits.emotionHeightMultiplier': 1.5 },
    { 'flags.ginzzzu-portraits': { emotionHeightMultiplier: 1.5 } },
    { flags: { 'ginzzzu-portraits': { '-=emotionHeightMultiplier': null } } },
    { 'flags.ginzzzu-portraits.-=portraitHeightMultiplier': null },
    { flags: { '-=ginzzzu-portraits': null } }
  ]) assert.equal(isTokenArtMultiplierUpdate(changes), true);
  for (const changes of [null, {}, { system: { hp: 5 } },
    { flags: { 'ginzzzu-portraits': { portraitEmotion: 'joy', portraitCustomImage: 'new.webp' } } },
    { 'flags.ginzzzu-portraits.displayName': 'Name' }
  ]) assert.equal(isTokenArtMultiplierUpdate(changes), false);

  hooks.get('updateActor')({ id: 'actor' }, { flags: { 'ginzzzu-portraits': { portraitEmotion: 'joy' } } });
  assert.equal(frameCallbacks.length, 0);
});

function framesUntilIdle() {
  let count = 0;
  while (frameCallbacks.length && count++ < 10) frameCallbacks.shift()();
  assert.equal(frameCallbacks.length, 0);
}

test("texture dimensions and fit changes do not leave a stale base scale", () => {
  const token = new Token('a');
  applyPerspectiveToToken(token, { scheduleSort: false });
  token.mesh.texture.orig = { width: 200, height: 100 };
  applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, 0.3);
  token.document.texture.fit = 'cover';
  applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, 0.6);
  config.tokenScaling = false;
  token.document.texture.scaleY = 1.5;
  applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.y, 1.5);
  token.document.texture.fit = 'fill'; token.document.texture.scaleY = 2;
  config.enabled = false;
  applyPerspectiveToToken(token, { scheduleSort: false }); closeTo(token.mesh.scale.x, 0.5); closeTo(token.mesh.scale.y, 2);
});

test("a disappearing mesh removes its shadow even with scaling disabled", () => {
  config.tokenScaling = false;
  const token = new Token('a'); applyPerspectiveToToken(token, { scheduleSort: false });
  const shadow = shadowOf(token); token.mesh.destroyed = true;
  applyPerspectiveToToken(token, { scheduleSort: false }); assert.equal(shadow.destroyed, true);
});

test("depth sorting repairs external sort changes without waiting for depth to change", () => {
  const far = new Token('a', { y: 400 }), near = new Token('b', { y: 900 });
  canvas.tokens.placeables = [far, near];
  schedulePerspectiveSort({ force: true }); framesUntilIdle();
  assert.ok(far.document.sort < near.document.sort);
  far.document.sort = 900000; near.document.sort = 0;
  schedulePerspectiveSort({ tokens: [far, near] }); framesUntilIdle();
  assert.ok(far.document.sort < near.document.sort);
});

test("scene teardown removes token shadows and restores art without stale updates", () => {
  const token = new Token('a'); canvas.tokens.placeables = [token];
  applyPerspectiveToToken(token, { scheduleSort: false }); const shadow = shadowOf(token);
  hooks.get('canvasTearDown')();
  assert.equal(shadow.destroyed, true); assert.equal(token.mesh._perspectiveLevelsAppliedScale, undefined);
  closeTo(token.mesh.scale.x, 1);
});

test("switching levels closes calibration of the previous level", t => {
  t.mock.method(gridOverlay, 'draw', () => {});
  calibrator.container = { destroy() { this.destroyed = true; } };
  calibrator.level = { id: 'previous' };
  gridOverlay.onLevelChange();
  assert.equal(calibrator.active, false); assert.equal(calibrator.level, null); assert.equal(gridOverlay.forceVisible, false);
});

test("a wheel elevation change is retained on the next Shift drag movement", () => {
  const token = new Token('a'); const event = startDrag([token]);
  token._onDragLeftMove(event);
  const context = event.interactionData.contexts[0];
  context.destination = token._getDragWaypointPosition(context.destination, { elevation: 15 });
  token._onDragLeftMove(event);
  assert.equal(context.destination.elevation, 15);
});

test("Foundry draw/refresh/destroy hooks initialize and clean up clone shadows without render loops", () => {
  const original = new Token('a'), clone = new Token('a'); clone._original = original;
  hooks.get('drawToken')(original); hooks.get('drawToken')(clone); framesUntilIdle();
  const originalShadow = shadowOf(original), cloneShadow = shadowOf(clone);
  assert.ok(originalShadow && cloneShadow);
  hooks.get('refreshToken')(original); assert.equal(frameCallbacks.length, 0);
  hooks.get('destroyToken')(clone); assert.equal(cloneShadow.destroyed, true);
  assert.equal(originalShadow.destroyed, undefined);
});

test("native Level and Scene update hooks refresh affected scenes only", t => {
  let draws = 0; t.mock.method(gridOverlay, 'draw', () => { draws++; });
  canvas.scene.id = 'scene';
  hooks.get('updateLevel')({ id: canvas.level.id, documentName: 'Level', parent: { id: 'scene' } }, { flags: {} });
  hooks.get('updateScene')({ documentName: 'Scene', id: 'scene' }, { 'grid.distance': 10 });
  assert.equal(draws, 2);
  hooks.get('updateLevel')({ documentName: 'Level', parent: { id: 'other' } }, {});
  hooks.get('updateLevel')({ id: 'inactive', documentName: 'Level', parent: { id: 'scene' } }, { flags: {} });
  hooks.get('updateScene')({ documentName: 'Scene', id: 'scene' }, { name: 'other' });
  assert.equal(draws, 2);
});

test("foreign scene token hooks do not rebuild or sort the visible scene", () => {
  const token = new Token('foreign'); token.document.parent = { id: 'other' }; token.document.object = token;
  for (const name of ['createToken', 'updateToken', 'moveToken', 'recordToken', 'stopToken']) hooks.get(name)(token.document, { x: 5 });
  assert.equal(frameCallbacks.length, 0);
  assert.equal(token.mesh._perspectiveLevelsAppliedScale, undefined);
  hooks.get('updateToken')({ object: null }, { x: 5 });
  assert.equal(frameCallbacks.length, 0);
});

test("inactive perspective does not schedule a fallback on every native refresh", () => {
  config.enabled = false; const token = new Token('a');
  for (let i = 0; i < 100; i++) applyOrSchedulePerspectiveUpdate(token);
  assert.equal(frameCallbacks.length, 0);
});

test("loading textures queue one size retry per token and discard it on teardown", () => {
  const token = new Token('loading'); token.mesh.texture = {};
  for (let i = 0; i < 10; i++) applyPerspectiveToToken(token, { scheduleSort: false });
  assert.equal(frameCallbacks.length, 1);
  clearTokenScaleState(); removePerspectiveFromToken(token);
  const scale = token.mesh.scale.x;
  frameCallbacks.shift()();
  assert.equal(token.mesh.scale.x, scale);
  assert.equal(token.mesh._perspectiveLevelsAppliedScale, undefined);
  assert.equal(frameCallbacks.length, 0);
});

test("loading texture retries cannot update a token after switching scenes", () => {
  const token = new Token('loading'); token.mesh.texture = {};
  applyPerspectiveToToken(token, { scheduleSort: false });
  canvas.scene = {};
  const scale = token.mesh.scale.x;
  frameCallbacks.shift()();
  assert.equal(token.mesh.scale.x, scale);
  assert.equal(frameCallbacks.length, 0);
});

test("late sort persistence from the previous canvas cannot suppress persistence on a new canvas", async () => {
  let finishOld, finishNew; let oldWrites = 0, newWrites = 0;
  const oldToken = new Token('a'); canvas.tokens.placeables = [oldToken];
  canvas.scene.updateEmbeddedDocuments = () => { oldWrites++; return new Promise(resolve => { finishOld = resolve; }); };
  schedulePerspectiveSort({ persist: true, force: true }); framesUntilIdle(); assert.equal(oldWrites, 1);
  clearPerspectiveSortState();
  canvas.scene = { updateEmbeddedDocuments: () => { newWrites++; return new Promise(resolve => { finishNew = resolve; }); } };
  canvas.tokens.placeables = [new Token('a')];
  // Both scenes produce the same ID/sort signature.
  finishOld(); await Promise.resolve();
  schedulePerspectiveSort({ persist: true, force: true }); framesUntilIdle(); assert.equal(newWrites, 1);
  finishNew(); await Promise.resolve();
});

test("new scene sort writes can start while an old scene write is still pending", async () => {
  let finishOld; let newWrites = 0;
  canvas.tokens.placeables = [new Token('a')];
  canvas.scene.updateEmbeddedDocuments = () => new Promise(resolve => { finishOld = resolve; });
  schedulePerspectiveSort({ persist: true }); framesUntilIdle();
  clearPerspectiveSortState();
  canvas.scene = { updateEmbeddedDocuments: async () => { newWrites++; } };
  canvas.tokens.placeables = [new Token('b')];
  schedulePerspectiveSort({ persist: true }); framesUntilIdle(); assert.equal(newWrites, 1);
  await Promise.resolve(); finishOld(); await Promise.resolve();
  assert.equal(frameCallbacks.length, 0);
});

test("the first canvasReady refresh updates hit bounds after an early draw", () => {
  const token = new Token('a'); canvas.ready = false;
  hooks.get('drawToken')(token);
  canvas.ready = true;
  applyPerspectiveToToken(token, { scheduleSort: false });
  closeTo(token.hitArea.width, 60);
});

function visibleShadows() {
  return canvas.primary.children.filter(child => child._perspectiveLevelsToken && child.visible && !child.destroyed);
}

function assertSingleShadow(token) {
  const visible = visibleShadows();
  assert.equal(visible.length, 1);
  assert.ok(visible[0] === shadowOf(token));
}

test("takeoff shows only the active preview shadow even while its original remains visible", () => {
  const original = new Token('a');
  original.mesh.alpha = 0.5;
  applyPerspectiveToToken(original, { scheduleSort: false });
  const clone = new Token('a', { y: 600, elevation: 10 }); clone._original = original;
  applyPerspectiveToToken(clone, { scheduleSort: false });
  hooks.get('refreshToken')(original);
  assert.equal(visibleShadows().length, 1);
  assert.equal(visibleShadows()[0], shadowOf(clone));
});

test("a group has one visible shadow per token and restores originals on drop or cancel", () => {
  const originals = [new Token('a'), new Token('b', { x: 500 })];
  const clones = originals.map(original => {
    applyPerspectiveToToken(original, { scheduleSort: false });
    const clone = new Token(original.document.id, { elevation: 10, y: 650 }); clone._original = original;
    applyPerspectiveToToken(clone, { scheduleSort: false }); return clone;
  });
  assert.equal(visibleShadows().length, 2);
  for (const clone of clones) {
    const shadow = shadowOf(clone);
    clone._onDragEnd();
    // Late refreshes can arrive before native destruction. They must not
    // resurrect the completed preview's shadow.
    hooks.get('refreshToken')(clone);
    assert.equal(shadow.destroyed, true);
    assert.equal(shadowOf(clone), undefined);
    assert.equal(shadowOf(clone._original).visible, true);
    hooks.get('destroyToken')(clone);
  }
  framesUntilIdle();
  assert.equal(visibleShadows().length, 2);
  for (const original of originals) assert.equal(shadowOf(original).visible, true);
});

test("an undrawn or invisible preview keeps the original shadow until the clone becomes visible", () => {
  const original = new Token('a'); applyPerspectiveToToken(original, { scheduleSort: false });
  const clone = new Token('a', { elevation: 10 }); clone._original = original; clone.visible = false;
  applyPerspectiveToToken(clone, { scheduleSort: false });
  assertSingleShadow(original);
  clone.visible = true; hooks.get('refreshToken')(clone);
  assertSingleShadow(clone);
});

test("ending the newest of multiple previews restores the remaining preview before the original", () => {
  const original = new Token('a'); applyPerspectiveToToken(original, { scheduleSort: false });
  const first = new Token('a', { elevation: 5 }); first._original = original;
  const second = new Token('a', { elevation: 10 }); second._original = original;
  applyPerspectiveToToken(first, { scheduleSort: false });
  applyPerspectiveToToken(second, { scheduleSort: false });
  assertSingleShadow(second);
  second._onDragEnd(); assertSingleShadow(first);
  first._onDragEnd(); assertSingleShadow(original);
  first._onDragStart(); applyPerspectiveToToken(first, { scheduleSort: false });
  assertSingleShadow(first);
});
