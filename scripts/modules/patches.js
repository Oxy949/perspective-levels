import { installPerspectiveMeasurementPatch } from "./measurement-patches.js";
import { installPerspectiveTokenLayerMovementPatch } from "./keyboard-movement.js";
import { installTokenPerspectiveLifecyclePatches } from "./token-lifecycle-patches.js";
import { installTokenPixelPerfectShapePatch } from "./token-hit-testing.js";

export { collectTokenAndDragPreviews } from "./token-update-queue.js";

export function installRuntimePatches() {
  installTokenPerspectiveLifecyclePatches();
  installTokenPixelPerfectShapePatch();
  installPerspectiveTokenLayerMovementPatch();
  installPerspectiveMeasurementPatch();
}
