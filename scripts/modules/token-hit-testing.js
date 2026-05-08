import { MODULE_ID } from "./constants.js";
import { getLevelConfig, isPerspectiveEnabled } from "./config.js";
import { getTokenClass, wrapPrototypeMethod } from "./foundry-helpers.js";
import { clamp } from "./utils.js";

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getPerspectiveShapeScale(token) {
  const scale = finiteNumber(token?.mesh?._perspectiveLevelsAppliedScale, 1);
  return scale && scale > 0.0001 ? scale : 1;
}

function getPerspectiveShapeAlign(config) {
  return clamp(config?.tokenArtVerticalAlign ?? 0.5, 0, 1);
}

function getTextureDimension(mesh, axis) {
  const texture = mesh?.texture ?? mesh?._texture;
  const orig = texture?.orig;
  const frame = texture?.frame;
  const baseTexture = texture?.baseTexture;
  const isX = axis === "x";

  return finiteNumber(
    isX ? orig?.width : orig?.height,
    finiteNumber(
      isX ? frame?.width : frame?.height,
      finiteNumber(
        isX ? texture?.width : texture?.height,
        finiteNumber(
          isX ? baseTexture?.realWidth : baseTexture?.realHeight,
          finiteNumber(isX ? baseTexture?.width : baseTexture?.height)
        )
      )
    )
  );
}

function getMeshArtSize(token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) return null;

  const textureWidth = getTextureDimension(mesh, "x");
  const textureHeight = getTextureDimension(mesh, "y");
  const scaleX = Math.abs(finiteNumber(mesh?.scale?.x, 0));
  const scaleY = Math.abs(finiteNumber(mesh?.scale?.y, 0));

  if (!textureWidth || !textureHeight || !scaleX || !scaleY) return null;
  return {
    width: textureWidth * scaleX,
    height: textureHeight * scaleY
  };
}

function getShapeBounds(shape) {
  const x = finiteNumber(shape?.x);
  const y = finiteNumber(shape?.y);

  const radius = finiteNumber(shape?.radius);
  if (getShapeKind(shape) === "circle" && x !== null && y !== null && radius !== null) {
    return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
  }

  const halfWidth = finiteNumber(shape?.halfWidth);
  const halfHeight = finiteNumber(shape?.halfHeight);
  if (getShapeKind(shape) === "ellipse" && x !== null && y !== null && halfWidth !== null && halfHeight !== null) {
    return { x: x - halfWidth, y: y - halfHeight, width: halfWidth * 2, height: halfHeight * 2 };
  }

  const width = finiteNumber(shape?.width);
  const height = finiteNumber(shape?.height);
  if (x !== null && y !== null && width !== null && height !== null) {
    return { x, y, width, height };
  }

  const points = getPolygonPoints(shape);
  if (points.length >= 6) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]);
      minY = Math.min(minY, points[i + 1]);
      maxX = Math.max(maxX, points[i]);
      maxY = Math.max(maxY, points[i + 1]);
    }

    if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }

  return null;
}

function getPolygonPoints(shape) {
  const raw = shape?.points;
  if (!Array.isArray(raw)) return [];

  if (typeof raw[0] === "number") {
    return raw
      .map(point => finiteNumber(point))
      .filter(point => point !== null);
  }

  const points = [];
  for (const point of raw) {
    const x = finiteNumber(point?.x);
    const y = finiteNumber(point?.y);
    if (x !== null && y !== null) points.push(x, y);
  }
  return points;
}

function getScaledBounds(bounds, scale, align) {
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  return getAlignedBounds(bounds, width, height, align);
}

function getAlignedBounds(bounds, width, height, align) {
  return {
    x: bounds.x + ((bounds.width - width) / 2),
    y: bounds.y + ((bounds.height - height) * (1 - align)),
    width,
    height
  };
}

function mapValue(value, fromStart, fromSize, toStart, toSize) {
  if (Math.abs(fromSize) <= 0.0001) return toStart + (toSize / 2);
  return toStart + (((value - fromStart) / fromSize) * toSize);
}

function transformPoint(x, y, bounds, scaledBounds) {
  return [
    mapValue(x, bounds.x, bounds.width, scaledBounds.x, scaledBounds.width),
    mapValue(y, bounds.y, bounds.height, scaledBounds.y, scaledBounds.height)
  ];
}

function scaleRectangle(shape, scaledBounds) {
  const Rectangle = globalThis.PIXI?.Rectangle;
  if (Rectangle) return new Rectangle(scaledBounds.x, scaledBounds.y, scaledBounds.width, scaledBounds.height);

  const clone = typeof shape?.clone === "function" ? shape.clone() : { ...shape };
  clone.x = scaledBounds.x;
  clone.y = scaledBounds.y;
  clone.width = scaledBounds.width;
  clone.height = scaledBounds.height;
  return clone;
}

function scaleCircle(shape, scale, scaledBounds) {
  const x = scaledBounds.x + (scaledBounds.width / 2);
  const y = scaledBounds.y + (scaledBounds.height / 2);
  const Circle = globalThis.PIXI?.Circle;
  if (Circle) return new Circle(x, y, shape.radius * scale);

  const clone = typeof shape?.clone === "function" ? shape.clone() : { ...shape };
  clone.x = x;
  clone.y = y;
  clone.radius = shape.radius * scale;
  return clone;
}

function ellipseFromBounds(shape, scaledBounds) {
  const x = scaledBounds.x + (scaledBounds.width / 2);
  const y = scaledBounds.y + (scaledBounds.height / 2);
  const halfWidth = scaledBounds.width / 2;
  const halfHeight = scaledBounds.height / 2;
  const Ellipse = globalThis.PIXI?.Ellipse;
  if (Ellipse) return new Ellipse(x, y, halfWidth, halfHeight);

  const clone = typeof shape?.clone === "function" ? shape.clone() : { ...shape };
  delete clone.radius;
  clone.x = x;
  clone.y = y;
  clone.halfWidth = halfWidth;
  clone.halfHeight = halfHeight;
  return clone;
}

function scalePolygon(shape, bounds, scaledBounds) {
  const points = getPolygonPoints(shape);
  if (points.length < 6) return shape;

  const scaledPoints = [];
  for (let i = 0; i < points.length; i += 2) {
    scaledPoints.push(...transformPoint(points[i], points[i + 1], bounds, scaledBounds));
  }

  const Polygon = globalThis.PIXI?.Polygon;
  return Polygon ? new Polygon(scaledPoints) : { ...shape, points: scaledPoints };
}

function getShapeKind(shape) {
  const name = shape?.constructor?.name ?? "";
  if (name === "Circle" || (shape?.radius !== undefined && shape?.width === undefined && shape?.height === undefined)) return "circle";
  if (name === "Ellipse" || shape?.halfWidth !== undefined || shape?.halfHeight !== undefined) return "ellipse";
  if (name === "Polygon" || Array.isArray(shape?.points)) return "polygon";
  if (name === "Rectangle" || (shape?.width !== undefined && shape?.height !== undefined)) return "rectangle";
  return "unknown";
}

function boundsNearlyEqual(a, b) {
  return Boolean(a && b)
    && Math.abs(a.x - b.x) <= 0.001
    && Math.abs(a.y - b.y) <= 0.001
    && Math.abs(a.width - b.width) <= 0.001
    && Math.abs(a.height - b.height) <= 0.001;
}

function getPerspectiveTokenFrameBounds(token, shape, config) {
  if (!shape || !isPerspectiveEnabled(config) || !config?.tokenScaling) return null;

  const bounds = getShapeBounds(shape);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

  const align = getPerspectiveShapeAlign(config);
  const artSize = getMeshArtSize(token);
  if (artSize?.width > 0 && artSize?.height > 0) {
    return getAlignedBounds(bounds, artSize.width, artSize.height, align);
  }

  return getScaledBounds(bounds, getPerspectiveShapeScale(token), align);
}

function getPerspectiveTokenShape(token, shape, config) {
  if (!shape || !isPerspectiveEnabled(config) || !config?.tokenScaling) return shape;

  const bounds = getShapeBounds(shape);
  const scaledBounds = getPerspectiveTokenFrameBounds(token, shape, config);
  if (!bounds || !scaledBounds || boundsNearlyEqual(bounds, scaledBounds)) return shape;

  switch (getShapeKind(shape)) {
    case "circle": return Math.abs(scaledBounds.width - scaledBounds.height) <= 0.001
      ? scaleCircle(shape, scaledBounds.width / bounds.width, scaledBounds)
      : ellipseFromBounds(shape, scaledBounds);
    case "ellipse": return ellipseFromBounds(shape, scaledBounds);
    case "polygon": return scalePolygon(shape, bounds, scaledBounds);
    case "rectangle": return scaleRectangle(shape, scaledBounds);
    default: return scaleRectangle(shape, scaledBounds);
  }
}

function getCurrentPerspectiveFrameBounds(token) {
  const config = getLevelConfig();
  if (!globalThis.canvas?.ready || !isPerspectiveEnabled(config) || !config?.tokenScaling) return null;

  const shape = token?._perspectiveLevelsFrameShape ?? token?.shape;
  const bounds = getShapeBounds(shape);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  return bounds;
}

function getStoredBaseFrameBounds(token) {
  const bounds = token?._perspectiveLevelsBaseFrameBounds;
  if (bounds?.width > 0 && bounds?.height > 0) return bounds;
  return null;
}

function getBaseTokenBounds(token) {
  const stored = getStoredBaseFrameBounds(token);
  if (stored) return stored;

  const gridSize = finiteNumber(globalThis.canvas?.dimensions?.size, finiteNumber(globalThis.canvas?.grid?.size, 100)) ?? 100;
  const documentWidth = finiteNumber(token?.document?.width);
  const documentHeight = finiteNumber(token?.document?.height);
  const width = finiteNumber(
    token?.w,
    documentWidth ? documentWidth * gridSize : finiteNumber(token?.width, gridSize)
  ) ?? gridSize;
  const height = finiteNumber(
    token?.h,
    documentHeight ? documentHeight * gridSize : finiteNumber(token?.height, gridSize)
  ) ?? gridSize;

  return {
    x: 0,
    y: 0,
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}

function getObjectPosition(object) {
  return {
    x: finiteNumber(object?.position?.x, finiteNumber(object?.x, 0)) ?? 0,
    y: finiteNumber(object?.position?.y, finiteNumber(object?.y, 0)) ?? 0
  };
}

function getObjectScale(object) {
  return {
    x: finiteNumber(object?.scale?.x, 1) ?? 1,
    y: finiteNumber(object?.scale?.y, 1) ?? 1
  };
}

function setObjectPosition(object, x, y) {
  if (!object || object.destroyed) return;
  if (typeof object.position?.set === "function") object.position.set(x, y);
  else {
    try { object.x = x; } catch (_err) { /* noop */ }
    try { object.y = y; } catch (_err) { /* noop */ }
  }
}

function setObjectScale(object, x, y) {
  if (!object || object.destroyed) return;
  if (typeof object.scale?.set === "function") object.scale.set(x, y);
  else {
    try { object.scale.x = x; } catch (_err) { /* noop */ }
    try { object.scale.y = y; } catch (_err) { /* noop */ }
  }
}

function clearInfoBase(object) {
  if (object && typeof object === "object") delete object._perspectiveLevelsInfoBase;
}

function getInfoBase(object) {
  if (!object || object.destroyed) return null;
  if (!object._perspectiveLevelsInfoBase) {
    object._perspectiveLevelsInfoBase = {
      position: getObjectPosition(object),
      scale: getObjectScale(object)
    };
  }
  return object._perspectiveLevelsInfoBase;
}

function resetInfoObject(object) {
  const base = object?._perspectiveLevelsInfoBase;
  if (!base) return;
  setObjectPosition(object, base.position.x, base.position.y);
  setObjectScale(object, base.scale.x, base.scale.y);
  delete object._perspectiveLevelsInfoBase;
}

function resetBarForFoundryDraw(bar) {
  resetInfoObject(bar);
  setObjectScale(bar, 1, 1);
  clearInfoBase(bar);
}

function isDisplayObject(value) {
  return Boolean(value && typeof value === "object" && (
    value.position
    || typeof value.clear === "function"
    || typeof value.addChild === "function"
    || value.parent
  ));
}

function getDrawnBar(args, result) {
  for (const candidate of [args?.[1], args?.[0], result]) {
    if (isDisplayObject(candidate)) return candidate;
  }
  return null;
}

function mapPoint(value, fromStart, fromSize, toStart, toSize) {
  if (Math.abs(fromSize) <= 0.0001) return toStart;
  return toStart + (((value - fromStart) / fromSize) * toSize);
}

function mapEdgeAwarePosition(value, fromStart, fromSize, toStart, toSize) {
  const fromEnd = fromStart + fromSize;
  const toEnd = toStart + toSize;
  const edgeTolerance = Math.max(12, Math.min(fromSize * 0.25, 32));
  if (value <= fromStart + edgeTolerance) return toStart + (value - fromStart);
  if (value >= fromEnd - edgeTolerance) return toEnd + (value - fromEnd);
  return mapPoint(value, fromStart, fromSize, toStart, toSize);
}

function positionNameplate(token, frameBounds, baseBounds) {
  const nameplate = token?.nameplate;
  const base = getInfoBase(nameplate);
  if (!base) return;

  const x = frameBounds.x + (frameBounds.width / 2);
  const baseBottom = baseBounds.y + baseBounds.height;
  const margin = clamp(base.position.y - baseBottom, 2, 8);
  const y = frameBounds.y + frameBounds.height + margin;
  setObjectPosition(nameplate, x, y);
  setObjectScale(nameplate, base.scale.x, base.scale.y);
}

function positionBar(bar, frameBounds, baseBounds) {
  const base = getInfoBase(bar);
  if (!base) return;

  const ratioX = frameBounds.width / Math.max(1, baseBounds.width);
  const x = mapEdgeAwarePosition(base.position.x, baseBounds.x, baseBounds.width, frameBounds.x, frameBounds.width);
  const y = mapEdgeAwarePosition(base.position.y, baseBounds.y, baseBounds.height, frameBounds.y, frameBounds.height);

  setObjectPosition(bar, x, y);
  setObjectScale(bar, ratioX, 1);
}

export function resetTokenPerspectiveFrameInfo(token) {
  resetInfoObject(token?.nameplate);
  for (const bar of token?.bars?.children ?? []) resetInfoObject(bar);
}

export function positionTokenPerspectiveFrameInfo(token) {
  const frameBounds = getCurrentPerspectiveFrameBounds(token);
  if (!frameBounds) {
    resetTokenPerspectiveFrameInfo(token);
    return;
  }

  const baseBounds = getBaseTokenBounds(token);
  positionNameplate(token, frameBounds, baseBounds);
  for (const bar of token?.bars?.children ?? []) positionBar(bar, frameBounds, baseBounds);
}

export function installTokenPerspectiveShapePatch() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto || proto._perspectiveLevelsShapePatch) return false;
  proto._perspectiveLevelsShapePatch = true;

  wrapPrototypeMethod(proto, "getShape", function(original, args) {
    const shape = original.apply(this, args);

    try {
      const config = getLevelConfig();
      if (!globalThis.canvas?.ready) return shape;
      this._perspectiveLevelsBaseFrameBounds = getShapeBounds(shape);
      const perspectiveShape = getPerspectiveTokenShape(this, shape, config);
      this._perspectiveLevelsFrameShape = perspectiveShape;
      return perspectiveShape;
    } catch (_err) {
      return shape;
    }
  });

  wrapPrototypeMethod(proto, "_refreshNameplate", function(original, args) {
    clearInfoBase(this.nameplate);
    const result = original.apply(this, args);
    positionTokenPerspectiveFrameInfo(this);
    return result;
  });

  wrapPrototypeMethod(proto, "drawBars", function(original, args) {
    for (const bar of this?.bars?.children ?? []) resetBarForFoundryDraw(bar);
    const result = original.apply(this, args);
    positionTokenPerspectiveFrameInfo(this);
    return result;
  });

  wrapPrototypeMethod(proto, "_drawBar", function(original, args) {
    const bar = getDrawnBar(args);
    resetBarForFoundryDraw(bar);
    const result = original.apply(this, args);
    positionTokenPerspectiveFrameInfo(this);
    return result;
  });

  console.log(`${MODULE_ID} | Token perspective shape patch installed`);
  return true;
}
