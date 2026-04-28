import { FLAG, MODULE_ID } from "./constants.js";
import { getLevelConfig } from "./config.js";
import { i18n } from "./utils.js";

function fieldName(path) {
  return `flags.${MODULE_ID}.${FLAG}.${path}`;
}

function checkedAttr(value) {
  return value ? "checked" : "";
}

export function injectLevelConfig(app, html, { openCalibrator } = {}) {
  if (!game.user?.isGM) return;

  const level = app?.document;
  if (!level || level.documentName !== "Level") return;

  const element = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!element || element.querySelector?.(".perspective-levels-config")) return;

  const form = element.querySelector("form") ?? element;
  const target = form.querySelector("[data-tab='basics']")
    ?? form.querySelector(".tab.active")
    ?? form.querySelector(".form-body")
    ?? form;

  const cfg = getLevelConfig(level);
  const htmlString = `
    <fieldset class="perspective-levels-config">
      <legend><i class="fa-solid fa-vector-square"></i> ${i18n("PERSPECTIVE_LEVELS.Title")}</legend>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.Enable")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("enabled")}" value="false">
          <input type="checkbox" name="${fieldName("enabled")}" value="true" ${checkedAttr(cfg.enabled)}>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.Grid")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("grid")}" value="false">
          <input type="checkbox" name="${fieldName("grid")}" value="true" ${checkedAttr(cfg.grid)}>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.TokenScaling")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("tokenScaling")}" value="false">
          <input type="checkbox" name="${fieldName("tokenScaling")}" value="true" ${checkedAttr(cfg.tokenScaling)}>
        </div>
      </div>

      <div class="form-group">
        <label>${i18n("PERSPECTIVE_LEVELS.Distance")}</label>
        <div class="form-fields">
          <input type="hidden" name="${fieldName("distance")}" value="false">
          <input type="checkbox" name="${fieldName("distance")}" value="true" ${checkedAttr(cfg.distance)}>
        </div>
      </div>

      <div class="form-group stacked perspective-levels-grid-settings">
        <label>Сетка</label>
        <div class="form-fields">
          <label>Цвет <input type="color" name="${fieldName("gridColor")}" value="${cfg.gridColor}"></label>
          <label>Прозрачность <input type="number" name="${fieldName("gridAlpha")}" value="${cfg.gridAlpha}" min="0" max="1" step="0.05"></label>
          <label>Толщина <input type="number" name="${fieldName("gridLineWidth")}" value="${cfg.gridLineWidth}" min="0.25" max="8" step="0.25"></label>
          <label>Масштаб клетки <input type="number" name="${fieldName("gridScale")}" value="${cfg.gridScale}" min="0.1" max="8" step="0.05"></label>
        </div>
      </div>

      <div class="form-group stacked perspective-levels-anchor-settings">
        <label>Якоря перспективы</label>
        <div class="form-fields perspective-levels-anchor-grid">
          <label>Far X <input type="number" name="${fieldName("far.x")}" value="${cfg.far.x}" min="0" max="1" step="0.01"></label>
          <label>Far Y <input type="number" name="${fieldName("far.y")}" value="${cfg.far.y}" min="0" max="1" step="0.01"></label>
          <label>Far Scale <input type="number" name="${fieldName("far.scale")}" value="${cfg.far.scale}" min="0.05" max="4" step="0.01"></label>
          <label>Near X <input type="number" name="${fieldName("near.x")}" value="${cfg.near.x}" min="0" max="1" step="0.01"></label>
          <label>Near Y <input type="number" name="${fieldName("near.y")}" value="${cfg.near.y}" min="0" max="1" step="0.01"></label>
          <label>Near Scale <input type="number" name="${fieldName("near.scale")}" value="${cfg.near.scale}" min="0.05" max="4" step="0.01"></label>
          <label>Curve <input type="number" name="${fieldName("curve")}" value="${cfg.curve}" min="0.4" max="4" step="0.01"></label>
        </div>
      </div>

      <button type="button" class="perspective-levels-open-calibrator">
        <i class="fa-solid fa-crosshairs"></i> ${i18n("PERSPECTIVE_LEVELS.OpenCalibrator")}
      </button>
      <p class="hint">Настройки сохраняются в flags текущего Level. Кнопка калибровки работает, если этот уровень сейчас открыт на canvas.</p>
    </fieldset>
  `;

  target.insertAdjacentHTML("beforeend", htmlString);
  element.querySelector(".perspective-levels-open-calibrator")?.addEventListener("click", event => {
    event.preventDefault();
    if (canvas.level?.id !== level.id) {
      ui.notifications?.warn("Сначала выбери этот уровень на сцене, затем открой калибровку.");
      return;
    }
    openCalibrator?.();
  });
}
