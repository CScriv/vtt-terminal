# Terminal — Stage 5 (part 1): flag storage + in-app JSON editor

Prerequisite for player interaction. Interactive screens (boards that get
written to) store their JSON in flags.terminal.json instead of the page body,
so writes are a clean setFlag (no HTML parsing). This adds an in-app editor so
flag-stored JSON needs no console.

## Terminal Data form — new fields
- "Use flag storage": when ON, the app reads this screen's JSON from
  flags.terminal.json (the data layer already prefers the flag over the body).
- JSON editor (textarea): edit the flag-stored payload here.
  - "Load from body": pulls the page-body code-block JSON into the editor (and
    ticks flag storage). Use to migrate an existing body-authored screen to flag
    storage: open Terminal Data -> Load from body -> Save.
  - "Format / Validate": pretty-prints and validates the JSON.
- Invalid JSON aborts the save (nothing partial written) and reports the error.

## Migrating a board to flag storage (no console)
1. Open the board journal -> Terminal Data.
2. Click "Load from body" (fills the editor from your existing body JSON, ticks
   flag storage).
3. Save. The app now reads from the flag. You can optionally clear the body.
4. Future edits: Terminal Data -> edit JSON -> Save.

## Notes
- Turning flag storage OFF clears flags.terminal.json so the app falls back to
  the page body again.
- Non-interactive screens can stay body-stored; only boards that receive writes
  (requisitions, crew requests, later the feed) need flag storage.

## Next (part 2)
Status-change interaction: click a status -> popup of that board's valid
statuses (read from its sections) -> socket to GM -> GM writes the flag ->
update hook re-renders. Plus updatedBy bookkeeping.
