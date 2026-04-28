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
  const candidates = [
    canvasRef?.scene?.grid?.distance,
    canvasRef?.dimensions?.distance,
    canvasRef?.grid?.distance,
    canvasRef?.scene?.gridDistance
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 1;
}
