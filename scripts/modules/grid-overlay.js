import { getLevelConfig } from "./config.js";
import { getPerspectiveGridModel, perspectiveGridModelToScreen } from "./projection.js";
import { getSceneRect } from "./scene.js";
import { parseColor } from "./utils.js";

export class PerspectiveGridOverlay {
  constructor() {
    this.container = null;
    this.grid = null;
    this.parent = null;
    this._lastLevelId = null;
    this._ticker = this._ticker.bind(this);
  }

  get active() {
    return Boolean(this.container && !this.container.destroyed);
  }

  getParent() {
    const canvasRef = globalThis.canvas;
    for (const parent of [canvasRef?.grid, canvasRef?.primary, canvasRef?.interface, canvasRef?.stage]) {
      if (parent && typeof parent.addChild === "function") return parent;
    }
    return null;
  }

  ensure() {
    if (!globalThis.canvas?.ready) return false;

    const parent = this.getParent();
    if (!parent) return false;

    if (!this.container || this.container.destroyed) {
      this.container = new PIXI.Container();
      this.container.name = "PerspectiveLevels.GridOverlay";
      this.container.eventMode = "none";
      this.container.zIndex = 1000;

      this.grid = new PIXI.Graphics();
      this.grid.name = "PerspectiveLevels.Grid";
      this.grid.eventMode = "none";
      this.container.addChild(this.grid);
    }

    if (this.container.parent !== parent) {
      this.container.parent?.removeChild?.(this.container);
      parent.addChild(this.container);
      parent.sortableChildren = true;
      this.parent = parent;
    }

    this.container.position.set(0, 0);
    this.container.scale.set(1, 1);
    return true;
  }

  destroy() {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
    this.grid = null;
    this.parent = null;
  }

  startTicker() {
    const ticker = globalThis.canvas?.app?.ticker;
    if (!ticker) return;
    try { ticker.remove(this._ticker); } catch (_err) { /* noop */ }
    ticker.add(this._ticker);
  }

  stopTicker() {
    try { globalThis.canvas?.app?.ticker?.remove(this._ticker); } catch (_err) { /* noop */ }
  }

  _ticker() {
    const id = globalThis.canvas?.level?.id ?? null;
    if (id !== this._lastLevelId) {
      this._lastLevelId = id;
      this.onLevelChange?.();
    }
  }

  draw() {
    if (!this.ensure()) return;

    const config = getLevelConfig(globalThis.canvas?.level);
    this.container.visible = Boolean(config.enabled && config.grid);
    this.grid.clear();
    if (!this.container.visible) return;

    const rect = getSceneRect();
    const lineStyle = {
      width: config.gridLineWidth,
      color: parseColor(config.gridColor, 0xffffff),
      alpha: config.gridAlpha
    };
    const model = getPerspectiveGridModel(config, rect);
    const g = this.grid;

    g.lineStyle?.(lineStyle);

    for (let row = 0; row <= model.rows; row++) {
      const left = perspectiveGridModelToScreen(model, 0, row);
      const right = perspectiveGridModelToScreen(model, model.columns, row);
      g.moveTo(left.x, left.y);
      g.lineTo(right.x, right.y);
    }

    const steps = Math.max(12, Math.min(48, model.rows * 2));
    for (let col = 0; col <= model.columns; col++) {
      for (let step = 0; step <= steps; step++) {
        const row = (step / steps) * model.rows;
        const point = perspectiveGridModelToScreen(model, col, row);
        if (step === 0) g.moveTo(point.x, point.y);
        else g.lineTo(point.x, point.y);
      }
    }

    g.stroke?.(lineStyle);
  }
}
