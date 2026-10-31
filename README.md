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

## Development checks

Run `node --test "tests/*.test.mjs"` with Node.js 24 or newer. The tests cover configuration, projection, distances, keyboard and drag movement, calibration saves, overlays, token art, shadows, sorting, effects and scene cleanup using Foundry API doubles.

Large-scene checks also cover one display-container sort per batch, shadow reuse without scene-child scans or redundant redraws, and updating only the matching token family during group dragging.

## Important Limitation

The module intercepts distance measurement through `BaseGrid#measurePath` and `Token#measureMovementPath` when **Measure distances on the perspective grid** is enabled on the current level. Measurement uses the cell coordinates of the rendered perspective grid: one perspective square equals Foundry's `scene.grid.distance`, for example 5 ft in a D&D scene. Horizontal and vertical screen steps do not have to be equal: each point is first converted into perspective-grid coordinates, then distance is measured in cells using the scene's diagonal rule (`grid.diagonals`).

Limitation: the module does not rewrite wall collisions, Regions, or pathfinding. If Foundry or the game system returns an infinite movement cost because of an obstacle, the module preserves that block; if a terrain or movement multiplier is present, it tries to preserve the original cost/distance ratio.
