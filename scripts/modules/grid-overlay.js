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

    // Scene Levels v14 рисует фон/foreground активного уровня в primary/effects
    // выше обычного grid/token-layer контейнера. Чтобы сетка гарантированно не
    // пряталась под фоном уровня, держим её в InterfaceCanvasGroup: этот group
    // отрисовывается поверх primary/effects, но контейнер ставим самым нижним
    // ребёнком interface, чтобы он не перекрывал HUD, контролы и drag-helpers.
    for (const parent of [canvasRef?.interface, canvasRef?.rendered, canvasRef?.stage]) {
      if (parent && typeof parent.addChild === "function") return parent;
    }
    return null;
  }

  configureDepth(parent) {
    if (!this.container) return;

    // Внутри interface overlay должен быть самым нижним слоем, но весь
    // InterfaceCanvasGroup всё равно находится выше фона/тайлов уровня.
    this.container.zIndex = -1_000_000;
    this.container.sort = this.container.zIndex;

    try { parent.sortableChildren = true; } catch (_err) { /* noop */ }
    try { parent.sortDirty = true; } catch (_err) { /* noop */ }
  }

  attachToParent(parent) {
    if (!this.container) return;

    if (this.container.parent !== parent) {
      this.container.parent?.removeChild?.(this.container);
      if (typeof parent.addChildAt === "function") {
        try { parent.addChildAt(this.container, 0); }
        catch (_err) { parent.addChild(this.container); }
      } else {
        parent.addChild(this.container);
      }
      this.parent = parent;
    }

    // Foundry/Levels может пересобрать children interface group после смены
    // уровня или режима инструмента. Возвращаем сетку в самый низ interface,
    // чтобы она была выше сцены, но ниже интерфейсных контролов.
    if (this.container.parent === parent && typeof parent.getChildIndex === "function" && typeof parent.addChildAt === "function") {
      try {
        const index = parent.getChildIndex(this.container);
        if (index > 0) {
          parent.removeChild(this.container);
          parent.addChildAt(this.container, 0);
        }
      } catch (_err) { /* noop */ }
    }

    this.configureDepth(parent);
  }

  ensure() {
    if (!globalThis.canvas?.ready) return false;

    const parent = this.getParent();
    if (!parent) return false;

    if (!this.container || this.container.destroyed) {
      this.container = new PIXI.Container();
      this.container.name = "PerspectiveLevels.GridOverlay";
      this.container.eventMode = "none";
      this.container.interactive = false;
      this.container.interactiveChildren = false;
      this.container.cullable = false;

      this.grid = new PIXI.Graphics();
      this.grid.name = "PerspectiveLevels.Grid";
      this.grid.eventMode = "none";
      this.grid.interactive = false;
      this.grid.interactiveChildren = false;
      this.grid.cullable = false;
      this.container.addChild(this.grid);
    }

    this.attachToParent(parent);

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

    // Если другой модуль/Foundry переставил interface children уже после ensure,
    // перед самой отрисовкой ещё раз поднимаем overlay над сценой.
    if (this.parent) this.attachToParent(this.parent);

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
