import { FLAG, MODULE_ID } from "./constants.js";
import { getLevelConfig } from "./config.js";
import { i18n } from "./utils.js";

function fieldName(path) {
  return `flags.${MODULE_ID}.${FLAG}.${path}`;
}

function checkedAttr(value) {
  return value ? "checked" : "";
}

function formatNumber(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number(number.toFixed(digits)).toString();
}

function booleanControl(path, value) {
  const name = fieldName(path);
  return `
    <input type="hidden" name="${name}" value="${value ? "true" : "false"}" data-perspective-levels-boolean-value="${path}">
    <input type="checkbox" data-perspective-levels-boolean="${path}" ${checkedAttr(value)}>
  `;
}

function syncBooleanControls(root, formData = null) {
  for (const checkbox of root.querySelectorAll("input[type='checkbox'][data-perspective-levels-boolean]")) {
    const path = checkbox.dataset.perspectiveLevelsBoolean;
    const escapedPath = globalThis.CSS?.escape ? CSS.escape(path) : String(path).replaceAll('"', '\\"');
    const hidden = root.querySelector(`input[type="hidden"][data-perspective-levels-boolean-value="${escapedPath}"]`);
    const value = checkbox.checked ? "true" : "false";
    if (hidden) hidden.value = value;
    if (formData && hidden?.name) formData.set(hidden.name, value);
  }
}

function toElement(htmlString) {
  const template = document.createElement("template");
  template.innerHTML = htmlString.trim();
  return template.content.firstElementChild;
}

function isUsableContainer(element) {
  return element instanceof HTMLElement && !element.closest("footer, .form-footer");
}

function uniqueElements(elements) {
  return elements.filter((element, index, array) => element && array.indexOf(element) === index);
}

function findScrollableInsertionTarget(root, form) {
  // Foundry v14 ApplicationV2 sheets commonly keep the save footer outside the
  // scrollable area. If the perspective fieldset is inserted before that footer
  // as a direct form child, it stays visually fixed under the scroller. Prefer
  // the real scroll container first, then fall back to an active tab/body.
  const selectors = [
    "form > .scrollable",
    "form > section.scrollable",
    "form > div.scrollable",
    ":scope > .scrollable",
    ":scope > section.scrollable",
    ":scope > div.scrollable",
    ".window-content form > .scrollable",
    ".standard-form > .scrollable",
    ".sheet-body.scrollable",
    ".sheet-body .scrollable",
    ".form-body.scrollable",
    ".form-body .scrollable",
    "[data-application-part='body'].scrollable",
    "[data-application-part='form'].scrollable",
    ".tab.active.scrollable",
    ".tab.active .scrollable"
  ];

  const candidates = uniqueElements(selectors.flatMap(selector => {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }));

  for (const candidate of candidates) {
    if (!isUsableContainer(candidate)) continue;
    if (!form.contains(candidate) && candidate !== form) continue;
    return candidate;
  }

  const computedCandidates = Array.from(form.querySelectorAll("*")).filter(isUsableContainer);
  for (const candidate of computedCandidates) {
    const style = globalThis.getComputedStyle?.(candidate);
    if (!style) continue;
    const overflowY = `${style.overflowY} ${style.overflow}`;
    const canScroll = /(auto|scroll)/.test(overflowY);
    if (!canScroll) continue;
    if (candidate.querySelector("input, select, textarea, button")) return candidate;
  }

  return null;
}

function findInsertionPoint(root, form) {
  const scrollable = findScrollableInsertionTarget(root, form);
  if (scrollable) return { mode: "append", element: scrollable };

  const activeTab = form.querySelector("[data-tab='basics'].active, .tab[data-tab='basics'].active, .tab.active");
  if (activeTab) return { mode: "append", element: activeTab };

  const body = form.querySelector(".form-body, .sheet-body, .window-content");
  if (body) return { mode: "append", element: body };

  const footer = form.querySelector(":scope > footer, :scope > .form-footer, footer.form-footer, .form-footer");
  if (footer) return { mode: "before", element: footer };

  return { mode: "append", element: form };
}

function insertConfigBlock(root, form, block) {
  const target = findInsertionPoint(root, form);
  if (target.mode === "before") target.element.insertAdjacentElement("beforebegin", block);
  else target.element.insertAdjacentElement("beforeend", block);
}

export function injectLevelConfig(app, html, { openCalibrator } = {}) {
  if (!game.user?.isGM) return;

  const level = app?.document;
  if (!level || level.documentName !== "Level") return;

  const element = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!element || element.querySelector?.(".perspective-levels-config-host")) return;

  const form = element.querySelector("form") ?? element;

  const cfg = getLevelConfig(level);
  const htmlString = `
    <section class="perspective-levels-config-host" data-module="${MODULE_ID}">
      <fieldset class="perspective-levels-config">
        <legend><i class="fa-solid fa-vector-square"></i> ${i18n("PERSPECTIVE_LEVELS.Title")}</legend>

        <div class="perspective-levels-row">
          <label>${i18n("PERSPECTIVE_LEVELS.Enable")}</label>
          <div class="perspective-levels-control">
            ${booleanControl("enabled", cfg.enabled)}
          </div>
        </div>

        <div class="perspective-levels-row">
          <label>${i18n("PERSPECTIVE_LEVELS.Grid")}</label>
          <div class="perspective-levels-control">
            ${booleanControl("grid", cfg.grid)}
          </div>
        </div>

        <div class="perspective-levels-row">
          <label>${i18n("PERSPECTIVE_LEVELS.TokenScaling")}</label>
          <div class="perspective-levels-control">
            ${booleanControl("tokenScaling", cfg.tokenScaling)}
          </div>
        </div>

        <div class="perspective-levels-row">
          <label>${i18n("PERSPECTIVE_LEVELS.Distance")}</label>
          <div class="perspective-levels-control">
            ${booleanControl("distance", cfg.distance)}
          </div>
        </div>

        <div class="perspective-levels-section">
          <div class="perspective-levels-section-title">Сетка</div>
          <div class="perspective-levels-fields-grid perspective-levels-grid-settings">
            <label>Цвет <input type="color" name="${fieldName("gridColor")}" value="${cfg.gridColor}"></label>
            <label>Прозрачность <input type="number" name="${fieldName("gridAlpha")}" value="${formatNumber(cfg.gridAlpha)}" min="0" max="1" step="any"></label>
            <label>Толщина <input type="number" name="${fieldName("gridLineWidth")}" value="${formatNumber(cfg.gridLineWidth)}" min="0.25" max="8" step="any"></label>
            <label>Масштаб клетки <input type="number" name="${fieldName("gridScale")}" value="${formatNumber(cfg.gridScale)}" min="0.1" max="8" step="any"></label>
            <label>Глубина сцены <input type="number" name="${fieldName("sceneDepthCells")}" value="${cfg.sceneDepthCells}" min="1" max="200" step="1"></label>
            <label>Множитель токенов <input type="number" name="${fieldName("tokenScaleMultiplier")}" value="${formatNumber(cfg.tokenScaleMultiplier)}" min="0.05" max="8" step="any"></label>
          </div>
        </div>

        <div class="perspective-levels-section">
          <div class="perspective-levels-section-title">Якоря перспективы</div>
          <div class="perspective-levels-fields-grid perspective-levels-anchor-grid">
            <label>Far X <input type="number" name="${fieldName("far.x")}" value="${formatNumber(cfg.far.x)}" min="0" max="1" step="any"></label>
            <label>Far Y <input type="number" name="${fieldName("far.y")}" value="${formatNumber(cfg.far.y)}" min="0" max="1" step="any"></label>
            <label>Far Scale <input type="number" name="${fieldName("far.scale")}" value="${formatNumber(cfg.far.scale)}" min="0.05" max="4" step="any"></label>
            <label>Far Rotation <input type="number" name="${fieldName("far.rotation")}" value="${formatNumber(cfg.far.rotation ?? 0)}" min="-180" max="180" step="any"></label>
            <label>Near X <input type="number" name="${fieldName("near.x")}" value="${formatNumber(cfg.near.x)}" min="0" max="1" step="any"></label>
            <label>Near Y <input type="number" name="${fieldName("near.y")}" value="${formatNumber(cfg.near.y)}" min="0" max="1" step="any"></label>
            <label>Near Scale <input type="number" name="${fieldName("near.scale")}" value="${formatNumber(cfg.near.scale)}" min="0.05" max="4" step="any"></label>
            <label>Near Rotation <input type="number" name="${fieldName("near.rotation")}" value="${formatNumber(cfg.near.rotation ?? 0)}" min="-180" max="180" step="any"></label>
            <label>Curve <input type="number" name="${fieldName("curve")}" value="${formatNumber(cfg.curve)}" min="0.4" max="4" step="any"></label>
          </div>
        </div>

        <button type="button" class="perspective-levels-open-calibrator">
          <i class="fa-solid fa-crosshairs"></i> ${i18n("PERSPECTIVE_LEVELS.OpenCalibrator")}
        </button>
        <p class="hint">Настройки сохраняются в flags текущего Level. В калибраторе оба якоря являются линиями: перетаскивание двигает линию, колесико мыши над ней вращает её.</p>
      </fieldset>
    </section>
  `;

  const block = toElement(htmlString);
  insertConfigBlock(element, form, block);

  block.addEventListener("change", event => {
    if (event.target?.matches?.("input[type='checkbox'][data-perspective-levels-boolean]")) syncBooleanControls(block);
  });

  form.addEventListener("submit", () => syncBooleanControls(block), { capture: true });
  form.addEventListener("formdata", event => syncBooleanControls(block, event.formData));

  block.querySelector(".perspective-levels-open-calibrator")?.addEventListener("click", event => {
    event.preventDefault();
    if (canvas.level?.id !== level.id) {
      ui.notifications?.warn("Сначала выбери этот уровень на сцене, затем открой калибровку.");
      return;
    }
    openCalibrator?.();
  });
}
