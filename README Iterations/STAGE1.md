# Terminal (engine) — Stage 1 (clean baseline)

A generic, theme-able in-world computer/terminal UI for Foundry VTT v13.
Engine, theme, and content are kept separate:
- **Engine** = this module's `scripts/` + structural templates (game-agnostic).
- **Theme** = a CSS class (default `me-terminal`), set via the `themeClass` setting.
- **Content** = JSON on flagged journals (wired in stage 2).

## What stage 1 does
Registers the module, exposes an API, and opens a **free-floating** ApplicationV2
window rendering a placeholder hub in your theme. No data or navigation yet.

## Install (local dev)
1. Drop this `terminal` folder into your LOCAL Foundry `Data/modules/`
   (folder name must equal the manifest id: `terminal`).
2. Open `styles/terminal.css` and paste your current Custom CSS where marked,
   following the two notes there (omit the journal-chrome rules; keep the base
   `.me-terminal` rule with its position/overflow intact).
3. Launch world → enable **Terminal** → reload.

## Test
Console (F12):
```js
game.modules.get("terminal").api.open();
```
Expect a draggable window, floating freely (it can overlap the sidebar and does
not push the canvas), showing the red header, SASO tag, and green prompt.

Hotbar macro (type: Script):
```js
game.modules.get("terminal").api.toggle();
```

## Architecture notes (why it's built this way)
- **Theme class on the inner wrapper, not the app root.** The app root carries
  only `terminal-app`. The theme class is applied to the inner `.terminal-screen`
  via `{{themeClass}}`. This keeps theme CSS (notably `position: relative` and
  `overflow: hidden`) off the floating window frame — putting them on the frame
  was what trapped the window against the sidebar. Fixed.
- **Theme referenced by configuration, never hardcoded.** `scripts/` and the
  structural template never name "me-terminal" — they read the `themeClass`
  setting. Swap games by changing one setting + supplying a new theme CSS.
- **Namespace `terminal`** for all flags/settings/classes.

## ⚠ Version sensitivity
The `foundry.applications.api` destructure and the `window` option names
(`frame`, `positioned`) are the spots most likely to differ across v13 builds.
Verified shape targets 13.351. If the window misbehaves, check those first.

## Roadmap
- **Stage 1 (this):** module skeleton + free-floating window. ✔
- **Stage 2:** flag-discovery → read JSON from a flagged journal → render one
  data-driven screen.
- **Stage 3:** in-window navigation (buttons swap screens, window persists).
- **Stage 4:** JSON schema for crew / missions / feed / requisitions / requests.
- **Stage 5:** interaction layer — player writes (likes, comments, approvals)
  via sockets with the GM client as write authority; live re-render on update.
