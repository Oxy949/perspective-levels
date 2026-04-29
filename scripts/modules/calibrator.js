import { getLevelConfig, normalizeConfig, setLevelConfig } from "./config.js";
import { anchorToPoint, getPerspectiveGridModel, pointToAnchor } from "./projection.js";
import { getSceneRect } from "./scene.js";
import { clamp, i18n } from "./utils.js";

function normalizeRotation(value) {
  const n = Number(value) || 0;
  const wrapped = ((n % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function round4(value) {
  const n = Number(value) || 0;
  return Number(n.toFixed(4));
}

export class PerspectiveCalibrator {
  constructor({ refresh = () => {}, drawGrid = () => {} } = {}) {
    this.level = null;
    this.config = null;
    this.container = null;
    this.anchors = {};
    this.panel = null;
    this.dragging = null;
    this.refresh = refresh;
    this.drawGrid = drawGrid;
  }

  get active() {
    return Boolean(this.container && !this.container.destroyed);
  }

  open() {
    if (!canvas?.ready || !canvas.level) {
      ui.notifications?.warn("Открой сцену и выбери уровень, который нужно настроить.");
      return;
    }

    this.close(false);
    this.level = canvas.level;
    this.config = getLevelConfig(this.level);
    this.config.enabled = true;
    this.config.grid = true;

    this.container = new PIXI.Container();
    this.container.name = "PerspectiveLevels.Calibrator";
    this.container.eventMode = "static";
    this.container.sortableChildren = true;

    const rect = getSceneRect();
    this.container.hitArea = new PIXI.Rectangle(rect.x, rect.y, rect.width, rect.height);
    canvas.interface.addChild(this.container);

    this.anchors.far = this._createAnchor("far", i18n("PERSPECTIVE_LEVELS.FarAnchor"), 0x4aa3ff);
    this.anchors.near = this._createAnchor("near", i18n("PERSPECTIVE_LEVELS.NearAnchor"), 0xffb84a);
    this.container.addChild(this.anchors.far, this.anchors.near);

    this.container.on("pointermove", event => this._onPointerMove(event));
    this.container.on("pointerup", () => this._stopDrag());
    this.container.on("pointerupoutside", () => this._stopDrag());

    this._createPanel();
    this.redraw();
    this.refresh();
  }

  close(refresh = true) {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
    this.anchors = {};
    this.dragging = null;
    this.level = null;
    if (this.panel) this.panel.remove();
    this.panel = null;
    if (refresh) this.refresh();
  }

  toggle() {
    if (this.active) this.close();
    else this.open();
  }

  async save() {
    if (!this.level || !this.config) return;
    await setLevelConfig(this.level, this.config);
    ui.notifications?.info(`Perspective Levels: настройки сохранены на уровень «${this.level.name}».`);
    this.refresh();
  }

  reset() {
    this.config = normalizeConfig({ enabled: true });
    this._syncPanelFromConfig();
    this.redraw();
    this.refresh();
  }

  _createAnchor(key, label, color) {
    const anchor = new PIXI.Container();
    anchor.name = `PerspectiveLevels.Anchor.${key}`;
    anchor.eventMode = "static";
    anchor.cursor = "move";
    anchor.zIndex = 1000;
    anchor._plKey = key;
    anchor._plColor = color;

    anchor.gfx = new PIXI.Graphics();
    anchor.label = new PIXI.Text(label, {
      fontFamily: "Arial",
      fontSize: 16,
      fill: 0xffffff,
      stroke: 0x000000,
      strokeThickness: 4
    });
    anchor.label.anchor.set(0.5, 0);
    anchor.addChild(anchor.gfx, anchor.label);

    anchor.on("pointerdown", event => {
      event.stopPropagation();
      this.dragging = key;
      anchor.alpha = 0.75;
    });

    // Как у токенов Foundry: навёл на якорь и крути колёсико мыши.
    // Без Shift — крупный шаг, с Shift — точная доводка.
    anchor.on("wheel", event => {
      event.stopPropagation?.();
      event.preventDefault?.();
      const original = event.originalEvent ?? event;
      const step = original?.shiftKey ? 5 : 15;
      const direction = Number(original?.deltaY ?? 0) > 0 ? step : -step;
      this._rotateAnchor(key, direction);
    });

    return anchor;
  }

  _rotateAnchor(key, delta) {
    if (!this.config?.[key]) return;
    this.config[key].rotation = round4(normalizeRotation((Number(this.config[key].rotation) || 0) + delta));
    this._syncPanelFromConfig();
    this.redraw();
    this.refresh();
  }

  _onPointerMove(event) {
    if (!this.dragging || !this.container) return;

    const point = event.getLocalPosition(this.container.parent);
    const normalized = pointToAnchor(point, getSceneRect());
    this.config[this.dragging].x = Number(normalized.x.toFixed(4));
    this.config[this.dragging].y = Number(normalized.y.toFixed(4));
    this.redraw();
    this.refresh();
  }

  _stopDrag() {
    if (this.dragging && this.anchors[this.dragging]) this.anchors[this.dragging].alpha = 1;
    this.dragging = null;
  }

  _createPanel() {
    const existing = document.getElementById("perspective-levels-calibrator");
    if (existing) existing.remove();

    const div = document.createElement("div");
    div.id = "perspective-levels-calibrator";
    div.innerHTML = `
      <header>${i18n("PERSPECTIVE_LEVELS.Calibrator")}</header>
      <p class="hint">Перетащи две линии-якоря на сцене. Колёсико мыши над линией вращает её, Shift+колёсико — точная доводка. Эти линии задают плоскость земли.</p>
      <label>${i18n("PERSPECTIVE_LEVELS.FarAnchor")} scale <input type="range" data-pl-scale="far" min="0.05" max="2.5" step="0.01"></label>
      <label>${i18n("PERSPECTIVE_LEVELS.FarAnchor")} rotation <input type="range" data-pl-rotation="far" min="-180" max="180" step="1"></label>
      <label>${i18n("PERSPECTIVE_LEVELS.NearAnchor")} scale <input type="range" data-pl-scale="near" min="0.05" max="3.5" step="0.01"></label>
      <label>${i18n("PERSPECTIVE_LEVELS.NearAnchor")} rotation <input type="range" data-pl-rotation="near" min="-180" max="180" step="1"></label>
      <label>Кривизна сетки <input type="range" data-pl-curve min="0.4" max="4" step="0.01"></label>
      <label>Масштаб клетки сетки <input type="range" data-pl-grid-scale min="0.1" max="4" step="0.05"></label>
      <label>Глубина сцены, клеток <input type="range" data-pl-scene-depth min="1" max="80" step="1"></label>
      <label>Множитель размера токенов <input type="range" data-pl-token-scale min="0.05" max="4" step="0.05"></label>
      <footer>
        <button type="button" data-pl-action="save"><i class="fa-solid fa-floppy-disk"></i> ${i18n("PERSPECTIVE_LEVELS.Save")}</button>
        <button type="button" data-pl-action="reset">${i18n("PERSPECTIVE_LEVELS.Reset")}</button>
        <button type="button" data-pl-action="close">${i18n("PERSPECTIVE_LEVELS.Close")}</button>
      </footer>
    `;
    document.body.appendChild(div);
    this.panel = div;

    div.querySelectorAll("input[data-pl-scale]").forEach(input => {
      input.addEventListener("input", event => {
        const key = event.currentTarget.dataset.plScale;
        this.config[key].scale = clamp(event.currentTarget.value, 0.05, 4);
        this.redraw();
        this.refresh();
      });
    });
    div.querySelectorAll("input[data-pl-rotation]").forEach(input => {
      input.addEventListener("input", event => {
        const key = event.currentTarget.dataset.plRotation;
        this.config[key].rotation = normalizeRotation(event.currentTarget.value);
        this.redraw();
        this.refresh();
      });
    });
    div.querySelector("input[data-pl-curve]")?.addEventListener("input", event => {
      this.config.curve = clamp(event.currentTarget.value, 0.4, 4);
      this.redraw();
      this.refresh();
    });
    div.querySelector("input[data-pl-grid-scale]")?.addEventListener("input", event => {
      this.config.gridScale = clamp(event.currentTarget.value, 0.1, 8);
      this.redraw();
      this.refresh();
    });
    div.querySelector("input[data-pl-scene-depth]")?.addEventListener("input", event => {
      this.config.sceneDepthCells = Math.round(clamp(event.currentTarget.value, 1, 200));
      this.redraw();
      this.refresh();
    });
    div.querySelector("input[data-pl-token-scale]")?.addEventListener("input", event => {
      this.config.tokenScaleMultiplier = clamp(event.currentTarget.value, 0.05, 8);
      this.redraw();
      this.refresh();
    });
    div.querySelector("[data-pl-action='save']")?.addEventListener("click", () => this.save());
    div.querySelector("[data-pl-action='reset']")?.addEventListener("click", () => this.reset());
    div.querySelector("[data-pl-action='close']")?.addEventListener("click", () => this.close());

    this._syncPanelFromConfig();
  }

  _syncPanelFromConfig() {
    if (!this.panel || !this.config) return;

    const far = this.panel.querySelector("input[data-pl-scale='far']");
    const near = this.panel.querySelector("input[data-pl-scale='near']");
    const farRotation = this.panel.querySelector("input[data-pl-rotation='far']");
    const nearRotation = this.panel.querySelector("input[data-pl-rotation='near']");
    const curve = this.panel.querySelector("input[data-pl-curve]");
    const gridScale = this.panel.querySelector("input[data-pl-grid-scale]");
    const sceneDepth = this.panel.querySelector("input[data-pl-scene-depth]");
    const tokenScale = this.panel.querySelector("input[data-pl-token-scale]");
    if (far) far.value = this.config.far.scale;
    if (near) near.value = this.config.near.scale;
    if (farRotation) farRotation.value = this.config.far.rotation ?? 0;
    if (nearRotation) nearRotation.value = this.config.near.rotation ?? 0;
    if (curve) curve.value = this.config.curve;
    if (gridScale) gridScale.value = this.config.gridScale;
    if (sceneDepth) sceneDepth.value = this.config.sceneDepthCells;
    if (tokenScale) tokenScale.value = this.config.tokenScaleMultiplier;
  }

  redraw() {
    if (!this.container || !this.config) return;

    const rect = getSceneRect();
    const model = getPerspectiveGridModel(this.config, rect);

    for (const key of ["far", "near"]) {
      const anchor = this.anchors[key];
      const line = model[key];
      if (!anchor || !line) continue;

      const center = anchorToPoint(this.config[key], rect);
      anchor.position.set(center.x, center.y);
      anchor.gfx.clear();

      const left = { x: line.left.x - center.x, y: line.left.y - center.y };
      const right = { x: line.right.x - center.x, y: line.right.y - center.y };
      const handleLength = Math.min(36, Math.max(12, rect.gridSize * 0.28));

      // Широкая почти невидимая линия нужна как удобная область наведения/колёсика.
      anchor.gfx.lineStyle({ width: 18, color: anchor._plColor, alpha: 0.04 });
      anchor.gfx.moveTo(left.x, left.y);
      anchor.gfx.lineTo(right.x, right.y);

      anchor.gfx.lineStyle({ width: 4, color: anchor._plColor, alpha: 1 });
      anchor.gfx.moveTo(left.x, left.y);
      anchor.gfx.lineTo(right.x, right.y);

      anchor.gfx.lineStyle({ width: 2, color: 0xffffff, alpha: 0.95 });
      anchor.gfx.drawCircle(0, 0, handleLength * 0.35);
      anchor.gfx.moveTo(-handleLength, 0);
      anchor.gfx.lineTo(handleLength, 0);
      anchor.gfx.moveTo(0, -handleLength);
      anchor.gfx.lineTo(0, handleLength);

      // Маленькая метка направления: помогает видеть, куда повернута линия.
      anchor.gfx.beginFill(anchor._plColor, 0.95);
      anchor.gfx.drawCircle(right.x, right.y, Math.max(4, rect.gridSize * 0.06));
      anchor.gfx.endFill?.();

      anchor.label.y = handleLength + 8;
    }

    this.drawGrid();
  }
}
