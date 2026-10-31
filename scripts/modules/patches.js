import { installPerspectiveMeasurementPatch } from "./measurement-patches.js";
import { installPerspectiveTokenLayerMovementPatch } from "./keyboard-movement.js";
import { installTokenPerspectiveLifecyclePatches } from "./token-lifecycle-patches.js";
import { installTokenPerspectiveShapePatch } from "./token-hit-testing.js";
import { installTokenVisualPatches } from "./token-visuals.js";
import { installRegionPerspectivePatches } from "./region-perspective.js";

export { collectTokenAndDragPreviews } from "./token-update-queue.js";

export function installRuntimePatches() {
  installTokenPerspectiveLifecyclePatches();
  installTokenPerspectiveShapePatch();
  installTokenVisualPatches();
  installPerspectiveTokenLayerMovementPatch();
  installPerspectiveMeasurementPatch();
  installRegionPerspectivePatches();
}
