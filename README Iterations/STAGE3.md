# Terminal — Stage 3: in-window navigation + template routing

The terminal now navigates between screens INSIDE the single window. Clicking a
hub card loads that screen and swaps the content — no new windows, nothing to
close. The screen JSON's "render" field selects the layout.

## What changed
- terminal.mjs: navigation state (current screen + history stack), action
  handlers (navigate / back / home), and a RENDER_TEMPLATES map routing each
  "render" type to a partial.
- templates/shell.hbs: now a frame + router. Renders the header, dispatches the
  body to the chosen render partial, and shows a nav bar (BACK / MAIN TERMINAL).
- templates/render/hub.hbs: the "hub" layout (navigable card grid). Cards carry
  data-action="navigate" data-screen="<id>".
- styles: nav cards get a pointer cursor + hover outline.

## Routing model
- Each screen's JSON has "render": "<type>".
- RENDER_TEMPLATES in terminal.mjs maps type -> partial path.
- Unknown types render a clean "UNKNOWN SCREEN TYPE" notice instead of breaking.
- Adding a new layout later = new partial file + one map entry. (Stage 4.)

## Navigation
- Click a card -> goTo(targetId): pushes current onto history, loads target.
- BACK -> pops history. MAIN TERMINAL -> clears history, returns home.
- The home screen hides the nav bar (nothing to go back to / already home).

## Test
1. Make sure your "main" screen journal's JSON has "render": "hub" (the stage-2
   sample already does).
2. Create a second screen to navigate to: a journal with JSON from
   sample-data/screen-crew.json, flagged via Terminal Data with id "crew",
   enabled.
3. Open the terminal. Click the CREW ROSTER card -> it loads the crew screen in
   the same window. Use BACK / MAIN TERMINAL to return.
4. Click a card whose target screen doesn't exist yet (e.g. MISSION LOG) -> you
   get the clean "Screen not found or disabled" error state with nav links, not
   a crash.

## Version-sensitive spots
- ApplicationV2 `actions` map (navigate/back/home) — the data-action dispatch
  mechanism. If clicks don't fire, verify the actions wiring for 13.351.
- `foundry.applications.handlebars.loadTemplates` (in _preFirstRender) registers
  the partials. If partials don't resolve, confirm that path / method name.
- `{{> (lookup . "renderTemplate") }}` dynamic partial syntax — standard
  Handlebars, but confirm partials are loaded before first render.

## Next
Stage 4: real layouts (crew roster, missions, feed, requisitions, requests,
tables) — each a render type + partial, driven by the JSON schema.
