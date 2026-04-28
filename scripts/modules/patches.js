import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveDistanceEnabled, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveMeasurement } from "./measurement.js";
import { elevationToScreenOffsetAtRow, perspectiveGridToScreen, perspectiveGroundPointToElevatedScreen, screenPointToPerspectiveGrid } from "./projection.js";
import { getSceneGridDistance, getSceneRect } from "./scene.js";
import { applyPerspectiveToToken, isTokenObject, schedulePerspectiveSort } from "./tokens.js";
import { clamp } from "./utils.js";

// Состояние для обработки масштабирования и Z-axis движения
const PENDING_PERSPECTIVE_UPDATES = new Set();
let PENDING_PERSPECTIVE_RAF = null;
const DRAG_STATE = new Map(); // tokenId -> { startX, startY, startElevation, isShiftDrag, isDragging }
let ACTIVE_DRAG_EVENT_SHIFT = false;
const TOKEN_ALPHA_HIT_THRESHOLD = 0.1;

function addTokenLikeToSet(value, set, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (isTokenObject(value)) {
    set.add(value);
    return;
  }

  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) addTokenLikeToSet(entry, set, seen);
    return;
  }

  if (value instanceof Map) {
    for (const entry of value.values()) addTokenLikeToSet(entry, set, seen);
    return;
  }

  if (Array.isArray(value.children)) {
    for (const child of value.children) addTokenLikeToSet(child, set, seen);
  }

  if (Array.isArray(value.placeables)) {
    for (const placeable of value.placeables) addTokenLikeToSet(placeable, set, seen);
  }
}

export function collectTokenAndDragPreviews(token) {
  const set = new Set();
  const seen = new Set();
  addTokenLikeToSet(token, set, seen);

  for (const key of ["_preview", "preview", "_dragPreview", "_movementPreview", "_previewObject"]) {
    try { addTokenLikeToSet(token?.[key], set, seen); }
    catch (_err) { /* private access may throw in some builds */ }
  }

  const canvasRef = globalThis.canvas;
  const layer = token?.layer ?? canvasRef?.tokens;
  for (const source of [
    layer?.preview,
    layer?._preview,
    layer?.previews,
    layer?._previews,
    layer?.objects?.preview,
    canvasRef?.tokens?.preview,
    canvasRef?.tokens?._preview
  ]) {
    addTokenLikeToSet(source, set, seen);
  }

  return [...set];
}

// Обновить масштаб токенов через RAF (чтобы избежать мерцания)
function flushPerspectiveUpdates() {
  const tokens = [...PENDING_PERSPECTIVE_UPDATES];
  PENDING_PERSPECTIVE_UPDATES.clear();
  PENDING_PERSPECTIVE_RAF = null;

  const config = getLevelConfig();
  if (!isPerspectiveEnabled(config)) return;

  for (const token of tokens) {
    try {
      // Применить масштаб к основному токену и его превью
      applyPerspectiveToToken(token);
      for (const preview of collectTokenAndDragPreviews(token)) {
        if (preview !== token) {
          applyPerspectiveToToken(preview);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to update perspective`, err);
    }
  }

  schedulePerspectiveSort();
}

function schedulePerspectiveUpdate(token) {
  if (!token) return;
  PENDING_PERSPECTIVE_UPDATES.add(token);
  if (PENDING_PERSPECTIVE_RAF) return;

  const raf = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
  PENDING_PERSPECTIVE_RAF = raf(flushPerspectiveUpdates);
}

function wrapPrototypeMethod(proto, methodName, wrapper) {
  const original = proto?.[methodName];
  if (typeof original !== "function" || original._perspectiveLevelsWrapped) return false;

  const wrapped = function perspectiveLevelsWrappedMethod(...args) {
    return wrapper.call(this, original, args);
  };
  wrapped._perspectiveLevelsWrapped = true;
  wrapped._perspectiveLevelsOriginal = original;
  proto[methodName] = wrapped;
  return true;
}

function getTokenClass() {
  return globalThis.foundry?.canvas?.placeables?.Token
    ?? globalThis.CONFIG?.Token?.objectClass
    ?? globalThis.Token;
}

function canUpdateTokenDocument(document) {
  const user = globalThis.game?.user;
  if (!document || !user) return false;
  if (user.isGM) return true;

  try {
    if (typeof document.canUserModify === "function") return Boolean(document.canUserModify(user, "update"));
  } catch (_err) { /* noop */ }

  try {
    if (typeof document.testUserPermission === "function") {
      return Boolean(document.testUserPermission(user, "OWNER"));
    }
  } catch (_err) { /* noop */ }

  return false;
}

function getKeyboardModifierConstants() {
  return globalThis.foundry?.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS
    ?? globalThis.KeyboardManager?.MODIFIER_KEYS
    ?? {};
}

function isShiftActive(event = null) {
  const native = event?.nativeEvent ?? event?.originalEvent ?? event?.data?.originalEvent ?? event;
  if (native?.shiftKey === true) return true;

  try {
    const key = getKeyboardModifierConstants().SHIFT;
    if (key && globalThis.game?.keyboard?.isModifierActive?.(key)) return true;
  } catch (_err) { /* noop */ }

  try {
    if (globalThis.game?.keyboard?.isModifierActive?.("SHIFT")) return true;
  } catch (_err) { /* noop */ }

  try {
    if (globalThis.keyboard?.isDown?.("Shift") || globalThis.keyboard?.isDown?.("ShiftLeft") || globalThis.keyboard?.isDown?.("ShiftRight")) return true;
  } catch (_err) { /* noop */ }

  return false;
}

function getTokenIdentity(token) {
  return token?._original?.document?.id
    ?? token?.document?.id
    ?? token?._original?.id
    ?? token?.id
    ?? String(token);
}

function getTokenPositionForFlight(token) {
  const source = token?._original ?? token;
  return {
    x: Number(token?.position?.x ?? token?.x ?? source?.position?.x ?? source?.x ?? token?.document?.x ?? source?.document?.x ?? 0) || 0,
    y: Number(token?.position?.y ?? token?.y ?? source?.position?.y ?? source?.y ?? token?.document?.y ?? source?.document?.y ?? 0) || 0
  };
}

function getFlightDragState(token, { event = null, create = false } = {}) {
  const tokenId = getTokenIdentity(token);
  if (!create || DRAG_STATE.has(tokenId)) return DRAG_STATE.get(tokenId);

  const config = getLevelConfig();
  const rect = getSceneRect();
  const document = token?._original?.document ?? token?.document;
  const { width, height } = getDocumentPixelSize(document, token?._original ?? token);
  const pos = getTokenPositionForFlight(token);
  const elevation = Number(document?.elevation ?? token?.document?.elevation ?? token?.elevation ?? 0) || 0;
  const bottom = { x: pos.x + (width / 2), y: pos.y + height, elevation };
  const grid = screenPointToPerspectiveGrid(bottom, config, rect);
  const gridDistance = getSceneGridDistance();
  const pxPerGridDistance = Math.max(1, Math.abs(elevationToScreenOffsetAtRow(gridDistance, grid.j, config, rect)) || rect.gridSize);

  const state = {
    startX: pos.x,
    startY: pos.y,
    startElevation: elevation,
    startWidth: width,
    startHeight: height,
    pxPerGridDistance,
    gridDistance,
    isShiftDrag: isShiftActive(event),
    isDragging: true,
    lastElevation: elevation
  };

  DRAG_STATE.set(tokenId, state);
  return state;
}

function computeFlightElevationFromY(state, y) {
  if (!state) return 0;
  const dy = (Number(y) || 0) - state.startY;
  const delta = -(dy / Math.max(1, state.pxPerGridDistance)) * Math.max(0.0001, state.gridDistance);
  let elevation = state.startElevation + delta;

  // Для обычного полёта над сеткой не даём случайно уйти ниже пола, но если токен
  // уже был на отрицательной высоте — сохраняем Foundry-совместимое поведение.
  if (state.startElevation >= 0) elevation = Math.max(0, elevation);
  return Math.round((elevation + Number.EPSILON) * 1000) / 1000;
}

function applyFlightElevationPreview(token, elevation) {
  if (!token?.document) return;

  try { token.document.updateSource?.({ elevation }, { _perspectiveLevelsFlightPreview: true }); }
  catch (_err) {
    try { token.document.elevation = elevation; }
    catch (_innerErr) { /* noop */ }
  }

  try { token.elevation = elevation; }
  catch (_err) { /* noop */ }
}

function deleteFlightState(token) {
  DRAG_STATE.delete(getTokenIdentity(token));
}


let PerspectiveLevelsMteOutlineFilterClass = null;
let PERSPECTIVE_LEVELS_OUTLINE_FILTER_WARNED = false;

function normalizeColorInt(value, fallback = 0xffffff) {
  if (typeof value === "number" && Number.isFinite(value)) return value & 0xffffff;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^#/, "").replace(/^0x/i, "");
    const parsed = Number.parseInt(cleaned, 16);
    if (Number.isFinite(parsed)) return parsed & 0xffffff;
  }
  try {
    const numeric = Number(value?.valueOf?.());
    if (Number.isFinite(numeric)) return numeric & 0xffffff;
  } catch (_err) { /* noop */ }
  return fallback;
}

function intColorToRgb(color) {
  const n = normalizeColorInt(color);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function normalizeRgbArray(value, fallback = [1, 1, 1]) {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return value.slice(0, 3).map(component => {
    const n = Number(component);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  });
}

function getTokenBorderColorRgb(token) {
  let value = null;

  try { value = token?._getBorderColor?.(); }
  catch (_err) { /* noop */ }

  if (value == null) value = token?.border?.tint ?? token?.frame?.tint ?? 0xffffff;

  try {
    const ColorClass = globalThis.Color ?? globalThis.foundry?.utils?.Color;
    const color = ColorClass?.from?.(value);
    if (Array.isArray(color?.rgb) && color.rgb.length >= 3) return normalizeRgbArray(color.rgb);
  } catch (_err) { /* noop */ }

  if (Array.isArray(value) && value.length >= 3) return normalizeRgbArray(value);
  return intColorToRgb(value);
}

function getOutlineQualityStep() {
  switch (globalThis.canvas?.performance?.mode) {
    case globalThis.CONST?.CANVAS_PERFORMANCE_MODES?.LOW:
      return (Math.PI * 2) / 10;
    case globalThis.CONST?.CANVAS_PERFORMANCE_MODES?.MED:
      return (Math.PI * 2) / 20;
    default:
      return (Math.PI * 2) / 30;
  }
}

function getPerspectiveLevelsMteOutlineFilterClass() {
  if (PerspectiveLevelsMteOutlineFilterClass) return PerspectiveLevelsMteOutlineFilterClass;

  const AbstractBaseFilter = globalThis.foundry?.canvas?.rendering?.filters?.AbstractBaseFilter;
  if (!AbstractBaseFilter) return null;

  const quality = getOutlineQualityStep().toFixed(7);

  // Логика шейдера взята из multi-token-edit Scenescape: считать альфу вокруг PNG
  // и рисовать outline, не knockout'я исходный mesh. Важно: НЕ наследуемся от
  // OutlineOverlayFilter — в Foundry 13/14 он может превращать арт в один контур
  // даже с knockout:false, а subclass может падать на private-полях.
  class PerspectiveLevelsMteOutlineFilter extends AbstractBaseFilter {
    static defaultUniforms = {
      outlineColor: [1, 1, 1, 1],
      thickness: [0.004, 0.004],
      alphaThreshold: 0.5
    };

    static fragmentShader = `
      precision mediump float;
      varying vec2 vTextureCoord;
      uniform sampler2D uSampler;
      uniform vec2 thickness;
      uniform vec4 outlineColor;
      uniform float alphaThreshold;

      #define TWOPI 6.28318530718

      void main(void) {
        vec4 ownColor = texture2D(uSampler, vTextureCoord);
        float texAlpha = smoothstep(alphaThreshold, 1.0, ownColor.a);
        vec4 curColor;
        float maxAlpha = 0.0;
        vec2 displaced;

        for (float angle = 0.0; angle <= TWOPI; angle += ${quality}) {
          displaced.x = vTextureCoord.x + thickness.x * cos(angle);
          displaced.y = vTextureCoord.y + thickness.y * sin(angle);
          curColor = texture2D(uSampler, clamp(displaced, vec2(0.0), vec2(1.0)));

          // Важно: как в multi-token-edit, прозрачный фон отсекается высоким
          // порогом. Иначе Foundry/PIXI может дать слабую альфу на всём
          // прямоугольнике текстуры, и фильтр превращается в жёлтый квадрат.
          curColor.a = clamp((curColor.a - 0.6) * 2.5, 0.0, 1.0);
          maxAlpha = max(maxAlpha, curColor.a);
        }

        float resultAlpha = max(maxAlpha, texAlpha);
        gl_FragColor = vec4((ownColor.rgb + outlineColor.rgb * (1.0 - ownColor.a)) * resultAlpha, resultAlpha);
      }
    `;

    constructor(...args) {
      super(...args);
      this.padding = 8;
      this.autoFit = false;
      this.animated = false;
      this._perspectiveLevelsThicknessPixels = 4;
    }

    apply(filterManager, input, output, clear, currentState) {
      this._updatePerspectiveLevelsThickness(input, currentState);
      return super.apply(filterManager, input, output, clear, currentState);
    }

    _updatePerspectiveLevelsThickness(input, currentState) {
      const frame = input?.sourceFrame ?? currentState?.sourceFrame ?? input?.filterFrame ?? input?.frame;
      const width = Math.max(1, Number(frame?.width ?? input?.width ?? 1) || 1);
      const height = Math.max(1, Number(frame?.height ?? input?.height ?? 1) || 1);
      const px = Math.max(1, Number(this._perspectiveLevelsThicknessPixels) || 4);

      const thickness = this.uniforms?.thickness;
      if (Array.isArray(thickness) || ArrayBuffer.isView(thickness)) {
        thickness[0] = px / width;
        thickness[1] = px / height;
      } else if (this.uniforms) {
        this.uniforms.thickness = [px / width, px / height];
      }
    }
  }

  PerspectiveLevelsMteOutlineFilterClass = PerspectiveLevelsMteOutlineFilter;
  return PerspectiveLevelsMteOutlineFilterClass;
}

function createPerspectiveLevelsMteOutlineFilter(outlineColor) {
  const OutlineFilter = getPerspectiveLevelsMteOutlineFilterClass();
  if (!OutlineFilter) return null;

  const color = normalizeRgbArray(outlineColor);
  try {
    const filter = OutlineFilter.create({ outlineColor: [...color, 1] });
    filter.ssOutline = true;
    filter.animated = false;
    filter._perspectiveLevelsMteOutline = true;
    filter._perspectiveLevelsThicknessPixels = 4;
    filter.padding = 8;
    filter.autoFit = false;
    return filter;
  } catch (err) {
    if (!PERSPECTIVE_LEVELS_OUTLINE_FILTER_WARNED) {
      PERSPECTIVE_LEVELS_OUTLINE_FILTER_WARNED = true;
      console.warn(`${MODULE_ID} | MTE-style token outline filter is unavailable in this Foundry build`, err);
    }
    return null;
  }
}

function updatePerspectiveLevelsMteOutlineFilter(filter, outlineColor) {
  if (!filter) return;
  const color = normalizeRgbArray(outlineColor);
  const value = [...color, 1];

  try {
    const current = filter.uniforms?.outlineColor;
    if (Array.isArray(current) || ArrayBuffer.isView(current)) {
      current[0] = value[0];
      current[1] = value[1];
      current[2] = value[2];
      current[3] = value[3];
    } else if (filter.uniforms) {
      filter.uniforms.outlineColor = value;
    }
  } catch (_err) { /* noop */ }

  filter._perspectiveLevelsThicknessPixels = 4;
  filter.padding = 8;
  filter.autoFit = false;
  filter.animated = false;
}

function removePerspectiveLevelsMteOutline(mesh) {
  if (!mesh || !Array.isArray(mesh.filters)) return;
  const kept = mesh.filters.filter(filter => !filter?._perspectiveLevelsMteOutline);
  mesh.filters = kept.length ? kept : null;
}

function installTokenMteOutlinePatch() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsMteOutlinePatch) return false;
  proto._perspectiveLevelsMteOutlinePatch = true;

  wrapPrototypeMethod(proto, "_refreshState", function(original, args) {
    const result = original.apply(this, args);

    try {
      const config = getLevelConfig();
      const enabled = globalThis.canvas?.ready && isPerspectiveEnabled(config);
      const mesh = this.mesh;

      if (!enabled || !mesh || mesh.destroyed) {
        removePerspectiveLevelsMteOutline(mesh);
        return result;
      }

      // Как в multi-token-edit Scenescape: обычная квадратная рамка Foundry выключается,
      // а вместо неё на mesh ставится outline filter по альфе токена.
      if (this.border) this.border.visible = false;

      if (this.document?.isSecret || !this.controlled) {
        removePerspectiveLevelsMteOutline(mesh);
        return result;
      }

      const outlineColor = getTokenBorderColorRgb(this);
      const colorKey = outlineColor.map(n => Number(n).toFixed(4)).join(",");
      let filters = Array.isArray(mesh.filters) ? mesh.filters : [];
      let outlineFilter = filters.find(filter => filter?._perspectiveLevelsMteOutline);

      if (!outlineFilter) {
        outlineFilter = createPerspectiveLevelsMteOutlineFilter(outlineColor);
        if (!outlineFilter) return result;
        filters.push(outlineFilter);
        mesh.filters = filters;
      }

      outlineFilter._perspectiveLevelsColorKey = colorKey;
      updatePerspectiveLevelsMteOutlineFilter(outlineFilter, outlineColor);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply MTE-style token outline`, err);
    }

    return result;
  });

  console.log(`${MODULE_ID} | MTE-style token outline patch installed`);
  return true;
}

function installTokenPixelPerfectShapePatch() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsPixelShapePatch) return false;
  proto._perspectiveLevelsPixelShapePatch = true;

  wrapPrototypeMethod(proto, "getShape", function(original, args) {
    const shape = original.apply(this, args);
    if (!shape || shape._perspectiveLevelsPixelShape || typeof shape.contains !== "function") return shape;

    const originalContains = shape.contains.bind(shape);
    shape._perspectiveLevelsPixelShape = true;
    shape._perspectiveLevelsMesh = this.mesh;
    shape.contains = function perspectiveLevelsPixelContains(...containsArgs) {
      const insideRectangle = originalContains(...containsArgs);
      if (!insideRectangle) return false;

      try {
        const config = getLevelConfig();
        const mesh = this._perspectiveLevelsMesh;
        const point = globalThis.canvas?.mousePosition;

        if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || !mesh?.containsCanvasPoint || !point) {
          return insideRectangle;
        }

        return Boolean(mesh.containsCanvasPoint(point, TOKEN_ALPHA_HIT_THRESHOLD));
      } catch (_err) {
        return insideRectangle;
      }
    };

    return shape;
  });

  console.log(`${MODULE_ID} | Token pixel-perfect shape patch installed`);
  return true;
}

function installTokenPreviewScalingPatch() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsPreviewPatch) return false;
  proto._perspectiveLevelsPreviewPatch = true;

  // Обработчик для инициализации - применить масштаб сразу
  const initHandler = function(original, args) {
    const result = original.apply(this, args);
    try {
      const config = getLevelConfig();
      if (isPerspectiveEnabled(config)) schedulePerspectiveUpdate(this);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to initialize token perspective`, err);
    }
    return result;
  };

  // Инициализация токена при создании
  wrapPrototypeMethod(proto, "draw", initHandler);

  // Обработчик для обычных операций
  const genericUpdateHandler = function(original, args) {
    const result = original.apply(this, args);
    schedulePerspectiveUpdate(this);
    return result;
  };

  // Shift+drag в перспективе = полёт. Токен остаётся в canvas X/Y там, куда
  // его тянет пользователь, но вертикальная экранная дельта записывается ещё и
  // в TokenDocument.elevation. Масштаб при этом считается от восстановленной
  // точки на земле, поэтому размер не меняется как при ходьбе по сетке.
  const dragMoveHandler = function(original, args) {
    const event = args[0];
    const shift = isShiftActive(event);
    let result;

    try {
      const config = getLevelConfig();
      if (globalThis.canvas?.ready && isPerspectiveEnabled(config)) getFlightDragState(this, { event, create: true });
    } catch (_err) { /* noop */ }

    ACTIVE_DRAG_EVENT_SHIFT = shift;
    try { result = original.apply(this, args); }
    finally { ACTIVE_DRAG_EVENT_SHIFT = false; }

    try {
      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config)) return result;

      const state = getFlightDragState(this, { event, create: true });
      if (!shift || !state) {
        if (state) state.isShiftDrag = false;
        schedulePerspectiveUpdate(this);
        return result;
      }

      state.isShiftDrag = true;
      const pos = getTokenPositionForFlight(this);
      const elevation = computeFlightElevationFromY(state, pos.y);
      state.lastElevation = elevation;
      applyFlightElevationPreview(this, elevation);
      schedulePerspectiveUpdate(this);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective flight preview`, err);
    }

    return result;
  };

  const dragEndHandler = function(original, args) {
    const state = DRAG_STATE.get(getTokenIdentity(this));
    const result = original.apply(this, args);

    try {
      const originalToken = this?._original ?? this;
      const document = originalToken?.document ?? this.document;

      if (state?.isShiftDrag && document) {
        const elevation = Number.isFinite(Number(state.lastElevation)) ? Number(state.lastElevation) : Number(document.elevation ?? 0) || 0;
        applyFlightElevationPreview(this, elevation);
        if (originalToken !== this) applyFlightElevationPreview(originalToken, elevation);

        if (document.update && canUpdateTokenDocument(document)) {
          document.update({ elevation }, {
            animate: false,
            _perspectiveLevelsFlight: true
          }).catch(err => console.warn(`${MODULE_ID} | Failed to save flight elevation`, err));
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to finalize perspective flight`, err);
    } finally {
      deleteFlightState(this);
      if (state?.isShiftDrag) schedulePerspectiveUpdate(this);
      schedulePerspectiveSort({ debounce: true });
    }

    return result;
  };

  wrapPrototypeMethod(proto, "_onDragLeftStart", function(original, args) {
    getFlightDragState(this, { event: args[0], create: true });
    return original.apply(this, args);
  });

  wrapPrototypeMethod(proto, "_onDragRightStart", function(original, args) {
    getFlightDragState(this, { event: args[0], create: true });
    return original.apply(this, args);
  });

  if (typeof proto._getDragWaypointPosition === "function") {
    wrapPrototypeMethod(proto, "_getDragWaypointPosition", function(original, args) {
      const result = original.apply(this, args);

      try {
        const config = getLevelConfig();
        if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || !(ACTIVE_DRAG_EVENT_SHIFT || isShiftActive())) return result;

        const state = getFlightDragState(this, { create: true });
        if (!state) return result;

        const y = Number(result?.y ?? args[1]?.y ?? getTokenPositionForFlight(this).y) || 0;
        const elevation = computeFlightElevationFromY(state, y);
        state.isShiftDrag = true;
        state.lastElevation = elevation;

        if (result && typeof result === "object") result.elevation = elevation;
        applyFlightElevationPreview(this, elevation);
        schedulePerspectiveUpdate(this);
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to prepare perspective flight waypoint`, err);
      }

      return result;
    });
  }

  if (typeof proto._onDragLeftMove === "function") wrapPrototypeMethod(proto, "_onDragLeftMove", dragMoveHandler);
  if (typeof proto._onDragRightMove === "function") wrapPrototypeMethod(proto, "_onDragRightMove", dragMoveHandler);

  for (const method of ["_onDragLeftDrop", "_onDragRightDrop", "_onDragLeftCancel", "_onDragRightCancel", "_onDragEnd", "_onDragLeftUp", "_onDragRightUp"]) {
    wrapPrototypeMethod(proto, method, dragEndHandler);
  }

  // Общие методы обновления
  for (const method of ["_refreshPosition", "_refreshMesh", "_refreshMeshSizeAndScale", "_updateDragDestination", "_onHoverIn", "_onHoverOut", "control", "release", "setTarget"]) {
    wrapPrototypeMethod(proto, method, genericUpdateHandler);
  }

  // Patch для измерения пути движения
  if (typeof proto.measureMovementPath === "function" && !proto.measureMovementPath._perspectiveLevelsWrapped) {
    wrapPrototypeMethod(proto, "measureMovementPath", function(original, args) {
      const result = original.apply(this, args);
      try {
        const config = getLevelConfig();
        if (isPerspectiveDistanceEnabled(config) && !result?._perspectiveLevels) {
          return applyPerspectiveMeasurement(result, args[0], config);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to apply perspective token movement measurement`, err);
      }
      return result;
    });
  }

  console.log(`${MODULE_ID} | Token preview scaling patch installed`);
  return true;
}


function getKeyboardIncrementScale() {
  try {
    const key = globalThis.foundry?.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS?.SHIFT;
    if (key && globalThis.game?.keyboard?.isModifierActive?.(key)) return 0.5;
  } catch (_err) { /* noop */ }

  try {
    if (globalThis.keyboard?.isDown?.("Shift")) return 0.5;
  } catch (_err) { /* noop */ }

  return 1;
}

function getDocumentPixelSize(document, object) {
  const rect = getSceneRect();
  const width = Number(object?.w ?? object?.width ?? ((document?.width || 1) * rect.gridSize)) || rect.gridSize;
  const height = Number(object?.h ?? object?.height ?? ((document?.height || 1) * rect.gridSize)) || rect.gridSize;
  return { width, height };
}

function getDocumentBottomPoint(document, object) {
  const { width, height } = getDocumentPixelSize(document, object);
  const x = Number(object?.position?.x ?? object?.x ?? document?.x ?? 0) || 0;
  const y = Number(object?.position?.y ?? object?.y ?? document?.y ?? 0) || 0;
  const elevation = Number(document?.elevation ?? object?.elevation ?? 0) || 0;
  return { x: x + (width / 2), y: y + height, elevation };
}

function perspectiveKeyboardMovePoint(bottom, dx, dy, config, rect) {
  const coords = screenPointToPerspectiveGrid(bottom, config, rect);
  const gridScale = Math.max(0.1, Number(config.gridScale) || 1);
  return perspectiveGridToScreen(
    coords.i + (dx * gridScale),
    coords.j + (dy * gridScale),
    config,
    rect
  );
}

function buildPerspectiveKeyboardMoveUpdate(object, dx, dy, config, rect) {
  const document = object?.document;
  if (!document?.id) return null;

  const { width, height } = getDocumentPixelSize(document, object);
  const bottom = getDocumentBottomPoint(document, object);
  const movedGroundBottom = perspectiveKeyboardMovePoint(bottom, dx, dy, config, rect);
  const movedBottom = perspectiveGroundPointToElevatedScreen({
    x: movedGroundBottom.x,
    y: movedGroundBottom.y,
    elevation: bottom.elevation
  }, config, rect);

  const minX = rect.x;
  const minY = rect.y;
  const maxX = rect.x + rect.width - width;
  const maxY = rect.y + rect.height - height;

  return {
    _id: document.id,
    x: Math.round(clamp(movedBottom.x - (width / 2), minX, maxX)),
    y: Math.round(clamp(movedBottom.y - height, minY, maxY))
  };
}

function installPerspectiveTokenLayerMovementPatch() {
  const TokenLayerClass = globalThis.foundry?.canvas?.layers?.TokenLayer ?? globalThis.TokenLayer;
  const proto = TokenLayerClass?.prototype;
  if (!proto || proto._perspectiveLevelsMoveManyPatch || typeof proto.moveMany !== "function") return false;
  proto._perspectiveLevelsMoveManyPatch = true;

  wrapPrototypeMethod(proto, "moveMany", async function(original, args) {
    const [options = {}] = args;
    const dx = Number(options?.dx ?? 0) || 0;
    const dy = Number(options?.dy ?? 0) || 0;

    try {
      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || (dx === 0 && dy === 0) || options?.rotate) {
        return original.apply(this, args);
      }

      const objects = typeof this._getMovableObjects === "function"
        ? this._getMovableObjects(options?.ids, options?.includeLocked)
        : (Array.isArray(options?.ids) && options.ids.length
          ? (this.placeables ?? []).filter(object => options.ids.includes(object?.id ?? object?.document?.id))
          : (this.controlled ?? []));

      if (!objects?.length) return [];
      this.hud?.clear?.();

      const rect = getSceneRect();
      const incrementScale = getKeyboardIncrementScale();
      const updates = [];

      for (const object of objects) {
        if (!object || object.destroyed || object.document?.locked) continue;
        if (typeof object._canDrag === "function" && !object._canDrag(globalThis.game?.user, null)) continue;
        const update = buildPerspectiveKeyboardMoveUpdate(object, dx * incrementScale, dy * incrementScale, config, rect);
        if (update) updates.push(update);
      }

      if (!updates.length) return [];

      const scene = globalThis.canvas?.scene;
      if (scene?.updateEmbeddedDocuments) {
        await scene.updateEmbeddedDocuments("Token", updates, {
          animate: true,
          _perspectiveLevelsKeyboardMove: true
        });
      } else {
        await Promise.all(updates.map(update => {
          const object = objects.find(candidate => candidate?.document?.id === update._id);
          return object?.document?.update?.(update, { animate: true, _perspectiveLevelsKeyboardMove: true });
        }));
      }

      for (const object of objects) schedulePerspectiveUpdate(object);
      schedulePerspectiveSort({ debounce: true });
      return objects;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective keyboard movement`, err);
      return original.apply(this, args);
    }
  });

  console.log(`${MODULE_ID} | Perspective keyboard movement patch installed`);
  return true;
}

function installPerspectiveMeasurementPatch() {
  const proto = globalThis.foundry?.grid?.BaseGrid?.prototype;
  if (!proto || proto._perspectiveLevelsMeasurementPatch) return false;
  proto._perspectiveLevelsMeasurementPatch = true;

  wrapPrototypeMethod(proto, "measurePath", function(original, args) {
    const result = original.apply(this, args);
    try {
      const [waypoints, options = {}] = args;
      if (options?._perspectiveLevelsBypass || result?._perspectiveLevels) return result;

      const config = getLevelConfig();
      if (!globalThis.canvas?.ready || !isPerspectiveDistanceEnabled(config)) return result;
      return applyPerspectiveMeasurement(result, waypoints, config);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply perspective grid measurement`, err);
      return result;
    }
  });

  console.log(`${MODULE_ID} | Perspective distance measurement patch installed`);
  return true;
}

export function installRuntimePatches() {
  installTokenMteOutlinePatch();
  installTokenPreviewScalingPatch();
  installTokenPixelPerfectShapePatch();
  installPerspectiveTokenLayerMovementPatch();
  installPerspectiveMeasurementPatch();
}

