export function getSceneRect() {
  const canvasRef = globalThis.canvas;
  const dims = canvasRef?.dimensions ?? {};
  const scene = canvasRef?.scene ?? {};
  const gridSize = Number(dims.size ?? canvasRef?.grid?.size ?? scene.grid?.size ?? 100) || 100;
  const width = Number(dims.sceneWidth ?? dims.width ?? scene.width ?? canvasRef?.app?.renderer?.screen?.width ?? 4000) || 4000;
  const height = Number(dims.sceneHeight ?? dims.height ?? scene.height ?? canvasRef?.app?.renderer?.screen?.height ?? 3000) || 3000;
  const x = Number(dims.sceneX ?? dims.x ?? 0) || 0;
  const y = Number(dims.sceneY ?? dims.y ?? 0) || 0;
  return { x, y, width, height, gridSize };
}

export function getCanvasScale() {
  // Get the canvas zoom/scale level for coordinate transformation
  const canvasRef = globalThis.canvas;
  const scale = Number(canvasRef?.stage?.scale?.x ?? canvasRef?.stage?.scale ?? 1) || 1;
  return Math.abs(scale) > 0.0001 ? scale : 1;
}

export function getSceneGridDistance() {
  const canvasRef = globalThis.canvas;

  // Foundry VTT v14 prepares the active Scene grid as canvas.grid. Prefer the
  // runtime BaseGrid values so Configure Scene -> Grid -> Distance changes are
  // picked up after the canvas redraws. Scene/dimensions are kept as fallbacks
  // for early initialization and partial mocks.
  const candidates = [
    canvasRef?.grid?.distance,
    canvasRef?.dimensions?.distance,
    canvasRef?.scene?.grid?.distance,
    canvasRef?.scene?.gridDistance
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 1;
}

export function getSceneGridUnits() {
  const canvasRef = globalThis.canvas;
  const candidates = [
    canvasRef?.grid?.units,
    canvasRef?.scene?.grid?.units,
    canvasRef?.dimensions?.units,
    canvasRef?.scene?.gridUnits
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return "";
}

export function getSceneGridMetrics() {
  const rect = getSceneRect();
  const distance = getSceneGridDistance();
  return {
    size: rect.gridSize,
    distance,
    units: getSceneGridUnits(),
    pixelsPerDistanceUnit: rect.gridSize / distance,
    distanceUnitsPerPixel: distance / rect.gridSize
  };
}
