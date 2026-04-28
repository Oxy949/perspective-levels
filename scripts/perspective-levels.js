/*
 * Perspective Levels for Foundry VTT v14
 *
 * Entry point only. Runtime integration lives in scripts/modules so the
 * geometry, token scaling, rendering, and Foundry patches can evolve
 * independently.
 */

import { getPublicApi, registerHooks } from "./modules/runtime.js";

registerHooks();

globalThis.PerspectiveLevels = getPublicApi();
