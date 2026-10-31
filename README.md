# Perspective Levels

A Foundry VTT 14 module that adds visual perspective to individual Scene Levels (`Level`):

- settings are stored on each `Level` through flags;
- one level can keep the regular grid while another level uses a perspective grid;
- tokens are visually scaled by their Y position between two anchors;
- token draw order is recalculated by perspective depth from the token's bottom point;
- perspective grid cell size can be configured separately for each level;
- distances are measured by the cells of the rendered perspective grid, not by screen pixels;
- a calibrator with two line anchors is available on the canvas: move and rotate them to define the ground plane.


## Installation

1. Copy https://github.com/Oxy949/perspective-levels/releases/latest/download/module.json
2. Paste it into Foundry VTT's module installer and wait for the installation to finish.
3. Enable the module in your world.
4. Enjoy!


## Usage

1. Open a scene with Scene Levels.
2. Select the level you want to configure.
3. Open the level settings (`LevelConfig`).
4. In the **Level Perspective** section, enable **Use perspective on this level**.
5. Click **Open Anchor Calibration** or the icon button in the token tools.
6. Drag the far and near line anchors. Rotate a line with the mouse wheel while hovering over it; hold Shift while scrolling for fine adjustment. Their scale is controlled by the sliders.
7. Click **Save to Level**.

When **Ginzzzu's Portraits & NPC Dock** (`ginzzzu-portraits`) is active, each actor's **Portrait Height Multiplier**, multiplied by their active **Emotion Height Multiplier**, also scales their token art proportionally. Switching or clearing emotions updates the height of both the token and its drag preview, including when the portrait module synchronizes a new token image with a native fade. Texture dimensions are recalculated as the new art loads. The token's ground footprint and shadow keep their size; without the module or a configured multiplier, the multiplier is 1.

Selected or hovered tokens have a static art-contour outline in their disposition color. This per-level option is enabled by default and can be disabled in Level Perspective settings. Filters are created only for highlighted tokens and are removed on deselection, mesh replacement or canvas teardown.

Animation targeting uses the visible portrait center. The module adapts live Sequencer effect instances for AutoAnimations, including fixed-size melee effects, object-sized effects and stretched-effect thickness. Sizes follow the current perspective/emotion scale; object-sized effects are not multiplied twice. Screen-space effects retain their normal behavior. No files in AutoAnimations or Sequencer are modified.

Region circles, cones, rectangles, ellipses, rings and lines use the perspective plane for geometry, sizing, editing, handles and point sampling. Native polygon trees remain responsible for drawing, holes, hit tests and movement segmentation. Freehand polygons retain their drawn scene positions and use perspective snapping. Region coverage and legacy MeasuredTemplate highlights use projected cells. Flying-token region tests use the ground point under the token, while native region elevation and level rules remain in effect.

Altitude is applied as a reversible displacement in continuous perspective rows, including above the far boundary. Grid extensions retain the end line's width instead of inverting beyond a vanishing point. Shift flight preserves the ground row and token size. Resetting calibration preserves the current **Show perspective grid** setting.

## Development checks

Run `node --test "tests/*.test.mjs"` with Node.js 24 or newer. The tests cover configuration, projection, distances, keyboard and drag movement, calibration saves, overlays, token art, shadows, sorting, effects and scene cleanup using Foundry API doubles.

Large-scene checks also cover one display-container sort per batch, shadow reuse without scene-child scans or redundant redraws, and updating only the matching token family during group dragging.

Runtime settings and projection models are reused until their inputs change. Shared drag previews are indexed once per update/sort batch, and camera movement reuses the grid geometry. Effect retries are coalesced per token and async effect draws are serialized. Scene teardown invalidates pending effects, texture-size retries and sort writes; inactive scenes and levels do not trigger full visible-scene refreshes.

The regression suite includes a 120-token group drag (120 preview visits per update and per sort), repeated camera redraws without rebuilding grid lines, slow effects and scene changes during pending writes. These are deterministic workload checks using API doubles, not FPS measurements in a running Foundry world.

## Important Limitation

The module intercepts distance measurement through `BaseGrid#measurePath` and `Token#measureMovementPath` when **Measure distances on the perspective grid** is enabled on the current level. Measurement uses the cell coordinates of the rendered perspective grid: one perspective square equals Foundry's `scene.grid.distance`, for example 5 ft in a D&D scene. Horizontal and vertical screen steps do not have to be equal: each point is first converted into perspective-grid coordinates, then distance is measured in cells using the scene's diagonal rule (`grid.diagonals`).

Limitation: the module does not rewrite wall collisions or pathfinding. If Foundry or the game system returns an infinite movement cost because of an obstacle, the module preserves that block; if a terrain or movement multiplier is present, it tries to preserve the original cost/distance ratio.
