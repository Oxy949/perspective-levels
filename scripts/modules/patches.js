import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveDistanceEnabled, isPerspectiveEnabled } from "./config.js";
import { applyPerspectiveMeasurement } from "./measurement.js";
import { applyPerspectiveToToken, isTokenObject, schedulePerspectiveSort } from "./tokens.js";

// Состояние для обработки масштабирования и Z-axis движения
const PENDING_PERSPECTIVE_UPDATES = new Set();
let PENDING_PERSPECTIVE_RAF = null;
const DRAG_STATE = new Map(); // tokenId -> { startX, startY, startElevation, isShiftDrag, isDragging }
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


let PERSPECTIVE_LEVELS_OUTLINE_FILTER_DISABLED = false;
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

function getTokenBorderColorRgb(token) {
  let value = null;

  try { value = token?._getBorderColor?.(); }
  catch (_err) { /* noop */ }

  if (value == null) value = token?.border?.tint ?? token?.frame?.tint ?? 0xffffff;

  try {
    const ColorClass = globalThis.Color ?? globalThis.foundry?.utils?.Color;
    const color = ColorClass?.from?.(value);
    if (Array.isArray(color?.rgb) && color.rgb.length >= 3) return color.rgb;
  } catch (_err) { /* noop */ }

  if (Array.isArray(value) && value.length >= 3) {
    return value.slice(0, 3).map(n => Math.max(0, Math.min(1, Number(n))));
  }
  return intColorToRgb(value);
}

function getOutlineOverlayFilterClass() {
  return globalThis.foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter
    ?? globalThis.OutlineOverlayFilter
    ?? null;
}

function createPerspectiveLevelsOutlineFilter(outlineColor) {
  if (PERSPECTIVE_LEVELS_OUTLINE_FILTER_DISABLED) return null;

  const OutlineOverlayFilter = getOutlineOverlayFilterClass();
  if (!OutlineOverlayFilter?.create) return null;

  try {
    // Важно: не наследуемся от OutlineOverlayFilter. В Foundry v14 фабрика create()
    // использует приватные static-поля/методы базового класса, поэтому вызов create()
    // на subclass может падать с "object is not the right class". На v14 штатный
    // knockout:false оставляет сам mesh видимым, что даёт тот же результат,
    // ради которого MTE в старых версиях переопределял shader.
    const filter = OutlineOverlayFilter.create({
      outlineColor,
      knockout: false,
      wave: false,
      animated: false
    });
    filter.ssOutline = true;
    filter.animated = false;
    filter._perspectiveLevelsMteOutline = true;
    return filter;
  } catch (err) {
    PERSPECTIVE_LEVELS_OUTLINE_FILTER_DISABLED = true;
    if (!PERSPECTIVE_LEVELS_OUTLINE_FILTER_WARNED) {
      PERSPECTIVE_LEVELS_OUTLINE_FILTER_WARNED = true;
      console.warn(MODULE_ID + " | Token outline filter is unavailable in this Foundry build", err);
    }
    return null;
  }
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

      // Как в multi-token-edit Scenescape: обычная прямоугольная рамка Foundry выключается,
      // а вместо неё на mesh ставится outline filter.
      if (this.border) this.border.visible = false;

      if (this.document?.isSecret || !this.controlled) {
        removePerspectiveLevelsMteOutline(mesh);
        return result;
      }

      const outlineColor = getTokenBorderColorRgb(this);
      const colorKey = outlineColor.map(n => Number(n).toFixed(4)).join(",");
      let filters = Array.isArray(mesh.filters) ? mesh.filters : [];
      let outlineFilter = filters.find(filter => filter?._perspectiveLevelsMteOutline);

      if (outlineFilter?._perspectiveLevelsColorKey !== colorKey) {
        filters = filters.filter(filter => !filter?._perspectiveLevelsMteOutline);
        outlineFilter = null;
      }

      if (!outlineFilter) {
        outlineFilter = createPerspectiveLevelsOutlineFilter(outlineColor);
        if (!outlineFilter) return result;
        outlineFilter._perspectiveLevelsColorKey = colorKey;
        filters.push(outlineFilter);
        mesh.filters = filters;
      }
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

  // Специальный обработчик для Shift+drag - Z-axis движение
  const dragMoveHandler = function(original, args) {
    const tokenId = this?.id ?? String(this);
    const isShiftPressed = globalThis.keyboard?.isDown?.("Shift") ?? false;
    
    // Инициализировать состояние при первом вызове
    if (!DRAG_STATE.has(tokenId)) {
      DRAG_STATE.set(tokenId, {
        startX: this.document?.x ?? this.x ?? 0,
        startY: this.document?.y ?? this.y ?? 0,
        startElevation: this.document?.elevation ?? this.elevation ?? 0,
        isShiftDrag: isShiftPressed,
        isDragging: true
      });
    }

    const state = DRAG_STATE.get(tokenId);
    
    // Вызовим оригинальный метод
    const result = original.apply(this, args);
    
    // Если Shift НАЖАТ - преобразуем Y-движение в Z-движение
    if (isShiftPressed) {
      state.isShiftDrag = true;
      
      // Получим текущие позиции
      const currentY = this.document?.y ?? this.y ?? 0;
      const currentElevation = Number(this.document?.elevation ?? this.elevation ?? 0) || 0;
      
      // Вычислим дельту Y от начальной позиции
      const yDelta = currentY - state.startY;
      
      // Преобразуем Y-дельту в elevation-дельту
      const elevationDelta = yDelta * 0.5;
      const newElevation = Math.max(0, state.startElevation + elevationDelta);
      
      // Сбросим Y обратно в начальную позицию и обновим elevation
      if (Math.abs(newElevation - currentElevation) > 0.01) {
        // Используем updateSource для немедленного обновления документа
        if (this.document?.updateSource) {
          this.document.updateSource({ 
            y: state.startY,
            elevation: newElevation
          });
        } else if (this.document) {
          // Fallback: прямое обновление если updateSource не доступен
          try {
            this.document.y = state.startY;
            this.document.elevation = newElevation;
          } catch (err) {
            console.warn(`${MODULE_ID} | Failed to update document properties`, err);
          }
        }
        
        // Обновить визуальную позицию объекта
        if (this.position) {
          this.position.y = state.startY;
        }
      }
    } else {
      state.isShiftDrag = false;
    }
    
    schedulePerspectiveUpdate(this);
    return result;
  };

  // Обработчик завершения drag - сохранить финальное elevation
  const dragEndHandler = function(original, args) {
    const tokenId = this?.id ?? String(this);
    const state = DRAG_STATE.get(tokenId);
    
    const result = original.apply(this, args);
    
    // Если был Shift-drag, сохранить финальную высоту
    if (state?.isShiftDrag && this.document) {
      const finalElevation = Number(this.document.elevation) || 0;
      const finalY = state.startY;
      
      // Сохранить на сервер только если текущий пользователь реально может обновлять TokenDocument.
      // Обычное перемещение остаётся на core Foundry; здесь мы сохраняем только наш Shift-drag elevation.
      if (this.document.update && canUpdateTokenDocument(this.document)) {
        this.document.update({
          y: finalY,
          elevation: finalElevation
        }, { animate: false }).catch(err =>
          console.warn(`${MODULE_ID} | Failed to save final elevation`, err)
        );
      }
    }
    
    // Очистить состояние
    DRAG_STATE.delete(tokenId);
    schedulePerspectiveUpdate(this);
    schedulePerspectiveSort({ persist: true, debounce: true });
    
    return result;
  };

  // Применить патчи к методам Start
  wrapPrototypeMethod(proto, "_onDragLeftStart", function(original, args) {
    const tokenId = this?.id ?? String(this);
    const isShift = globalThis.keyboard?.isDown?.("Shift") ?? false;
    DRAG_STATE.set(tokenId, {
      startX: this.document?.x ?? this.x ?? 0,
      startY: this.document?.y ?? this.y ?? 0,
      startElevation: this.document?.elevation ?? this.elevation ?? 0,
      isShiftDrag: isShift,
      isDragging: true
    });
    return original.apply(this, args);
  });

  wrapPrototypeMethod(proto, "_onDragRightStart", function(original, args) {
    const tokenId = this?.id ?? String(this);
    const isShift = globalThis.keyboard?.isDown?.("Shift") ?? false;
    DRAG_STATE.set(tokenId, {
      startX: this.document?.x ?? this.x ?? 0,
      startY: this.document?.y ?? this.y ?? 0,
      startElevation: this.document?.elevation ?? this.elevation ?? 0,
      isShiftDrag: isShift,
      isDragging: true
    });
    return original.apply(this, args);
  });

  // Специально для движения
  if (typeof proto._onDragLeftMove === "function") {
    wrapPrototypeMethod(proto, "_onDragLeftMove", dragMoveHandler);
  }
  if (typeof proto._onDragRightMove === "function") {
    wrapPrototypeMethod(proto, "_onDragRightMove", dragMoveHandler);
  }

  // End drag методы
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
  installPerspectiveMeasurementPatch();
}

