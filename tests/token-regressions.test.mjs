import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { installTokenPerspectiveLifecyclePatches } from "../scripts/modules/token-lifecycle-patches.js";
import { installTokenPerspectiveShapePatch } from "../scripts/modules/token-hit-testing.js";
import { clearPerspectiveUpdateState } from "../scripts/modules/token-update-queue.js";
import { applyPerspectiveToToken, clearPerspectiveSortState, clearTokenScaleState, getTokenGroundPoint, removePerspectiveFromToken } from "../scripts/modules/tokens.js";

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
}

globalThis.PIXI = { Graphics, Rectangle };
globalThis.foundry = { canvas: { primary: { PrimaryGraphics }, placeables: { Token } } };
installTokenPerspectiveLifecyclePatches();
installTokenPerspectiveShapePatch();

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

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.00001, `Expected ${actual} to equal ${expected}`);
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
