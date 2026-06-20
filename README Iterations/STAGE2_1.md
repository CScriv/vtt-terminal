# Terminal — Stage 2.1: top-level launch button

Adds a standalone Terminal button at the top level of the left-side scene
controls, so you can open the terminal without the console.

## How it's done (and why)
The v13 getSceneControlButtons DATA api is buggy for standalone top-level
buttons: a malformed control group crashes the canvas (_updateNotesIcon), and a
tool added to an existing group renders nested rather than top-level. So we use
the Levels module's proven approach instead: inject the button into the controls
DOM directly on the renderSceneControls hook (scripts/controls.mjs).

This yields a real top-level button, clicking it opens the terminal, no group /
second column, no crash.

## Fragility note
The injection depends on the #scene-controls-layers element id and native
control button classes — Foundry UI internals. A future Foundry version could
rename these (same risk Levels carries). If the button disappears after an
update, refresh the selector/markup in controls.mjs against the then-current
scene-controls DOM. Stable on 13.351.

## Player visibility
The button currently shows for everyone (players need to open the terminal). To
make it GM-only, add `if (!game.user.isGM) return;` at the top of the hook.

## Note on "render"
The screen JSON's "render" field is still inert — only one layout (the hub)
exists, so nothing routes on it yet. Template routing by render type is Stage 3.

## Next
Stage 3: clickable in-window navigation + template routing (render goes live).
