# Terminal — Stage 2 (revised): data-driven screens + config UI

Screens are journals flagged as terminal data. You set those flags from a
"Terminal Data" button added to each journal sheet's header menu — no console.

## Flag model
- flags.terminal.enabled (boolean) — is this screen LIVE? Turn off to shelve a
  half-built screen without deleting it; it keeps id + content but won't render
  or resolve as a navigation target.
- flags.terminal.id (string) — the screen's address. Links target this id; the
  engine resolves a link by finding the enabled journal whose id matches. Kept
  as a flag so resolution is a cheap flag lookup, not a scan of every payload.

The JSON payload carries content plus a "render" field naming its layout.
"render" is read only after the journal is loaded, so it costs nothing and keeps
"what kind of screen" with the content author.

## Setup a screen (no console)
1. Create a Journal Entry, add a text page, insert a CODE BLOCK, paste your
   screen JSON (see sample-data/screen-main.json). Save.
2. Open the journal sheet, click the three-dots controls menu in its header,
   click "Terminal Data".
3. Tick "Live on terminal", set Screen ID to "main", Save.

## Test
  game.modules.get("terminal").api.open();
Renders main from journal JSON. Edit JSON, re-open -> change appears. Break JSON
-> DATA ERROR state. Toggle off "Live on terminal" -> screen no longer resolves.

## Version-sensitive spots
- getHeaderControlsJournalEntrySheet: the hook adding the header button. If the
  button doesn't appear, verify this hook name for 13.351 (scripts/config.mjs,
  const HOOK_NAME). Find the real name by checking which getHeaderControls* hook
  fires when a journal sheet opens.
- page.text?.content: path to a text page's HTML for body-stored JSON. If body
  JSON won't parse, use flag storage (flags.terminal.json), checked first.

## Next
Stage 3: click a hub link -> resolve target id -> load + render that screen in
the same window. The "render" field selects the template.
