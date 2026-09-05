# Terminal — datapad authoring + discovery

Datapads can now be created, written and released from inside the terminal.
GM-only throughout. Two separable things:

- **Authoring**: create a datapad, edit its header fields, add/edit/reorder/
  delete its blocks, mark blocks encrypted.
- **Discovery**: a datapad can exist without the crew knowing it exists, so you
  can build it in advance and release it when they find it.

## Discovery vs. block reveal — deliberately different

These look similar and behave oppositely, on purpose.

| | Locked BLOCK | Undiscovered DATAPAD |
|---|---|---|
| Player sees | An ENCRYPTED placeholder bar | Nothing at all |
| Message | "there's more here you don't have yet" | — |
| Directory | n/a | Row is absent |
| Direct link | n/a | Refused, same error as a nonexistent id |

Block placeholders invite poking. A datapad the crew hasn't recovered yet
must not advertise itself — seeing a locked row would tell the players there's
a datapad waiting on an upcoming mission, which they have no business knowing.

The refusal on direct navigation matters as much as the directory filter: a
link from a mission or another datapad would otherwise leak existence. The
error text is byte-identical to the one an absent member produces, so probing
`datapads/whatever` can't distinguish hidden from nonexistent.

## The `discovered` field

```json
{ "render": "datapad", "title": "...", "discovered": false, "blocks": [] }
```

Lives in the datapad's JSON payload, not in a Foundry flag. That's what lets it
write through the existing relay with no new plumbing — and it deliberately
does NOT reuse `flags.terminal.enabled`, which would also break GM access and
direct links.

**Absent means visible.** Every datapad you've already authored keeps working
untouched. Only datapads created through the new tool start hidden.

## Using it

**Directory (GM):** `[ + NEW DATAPAD ]` creates one. Hidden datapads show
dimmed with a HIDDEN tag and a `[ release ]` / `[ hide ]` toggle in a
GM-only "Crew access" column.

**Datapad screen (GM):** a control bar with `[ edit info ]`, `[ + add block ]`,
the current discovery state, and the same toggle. Each block gets
`[ edit ] [ ↑ ] [ ↓ ] [ × ]` in the bar that already held `[ reveal ]`.

A new datapad is created **hidden**, so a half-built one is never live.

## The block id problem (worth understanding)

The renderer falls back to `b<index>` for blocks with no `id`, and `revealed[]`
stores whatever id was showing when you revealed it. Reordering an id-less
block would therefore hand its reveal state to whichever block slid into that
position — a secret block silently becoming visible.

Every datapad write calls `normalizeBlockIds()` first, which backfills missing
ids with exactly that same `b<index>` value. Existing reveals keep matching,
and from that moment the id travels with the block instead of its position.
Blocks added afterwards get `blk-<random>`.

This runs on first write, so a datapad you've never edited in-app is unaffected
until you touch it — at which point it's fixed permanently.

## Grid data is pipe-delimited

`keyvalue` rows and `table` headers/rows are edited as text: one row per line,
cells separated by `|`.

```
Clearance | Black
Handler   | Unknown
```

A real cell grid — add column, add row, drag to reorder — would be several
times the code of everything else in the block editor combined. The pipe
format round-trips losslessly for any content that doesn't contain a literal
`|`. If that becomes a problem, the fix is an escape in `splitCells()`, not a
rewrite.

Short rows render short; cell counts don't have to match the headers.

## Form field names are prefixed by type

Every type's field set is rendered into the block editor and the inactive
ones are hidden with `display: none`, which leaves them all in
`form.elements`. Two controls sharing a name make `form.elements[name]` a
`RadioNodeList`, whose `.value` is `""` for anything that isn't a checked
radio — so the field reads as empty, gets `|| null`, and is pruned out of the
block entirely on save.

`body` (text + message) and `label` (text + keyvalue + table) collided this
way. Names are therefore `msg-body`, `text-body`, `kv-label` and so on, and
`#onSave` reads through an `el()` helper that logs an error if a name ever
resolves to a list again. Don't shorten them back.

## Block editing behaviour

- Changing a block's **type** rebuilds it from only that type's fields, so the
  old type's keys don't linger in the JSON.
- Un-ticking **encrypted** also removes the block from `revealed[]`, so
  re-encrypting it later starts locked rather than silently revealed.
- Deleting a block removes its `revealed[]` entry too, and is the only datapad
  action that asks for confirmation. Everything else is reversible.
- `lockLabel` is what players see beside ENCRYPTED. It's the hook that makes a
  locked block worth poking at, so it's worth filling in.

## Journal creation

`createDatapad` is the only write in the module that CREATES a document rather
than mutating one. It:

- files the new journal in the folder your existing datapads live in (falls
  back to the sidebar root if there are none yet);
- adds a short "About" page so opening the journal directly doesn't look empty
  and says where the content actually lives;
- sets `enabled`, `collection: "datapads"`, `id`, and the starter `json` flag
  in one create call;
- rejects a duplicate id rather than shadowing an existing datapad.

Editing the title also renames the journal, so the sidebar stays in step.

## Permissions

Every datapad write re-checks `requestingUser.isGM`. The controls only render
for the GM, but `performWrite` dispatches on whatever arrives over the socket,
so the guard has to live at the write — same model as `toggleReveal`.

## Correction to the request editor

The previous round's `compose-request.mjs` used `tag: "form"` with an
ApplicationV2 form handler. `compose-post.mjs` documents the opposite house
rule — `div` root, theme class on an inner wrapper, save via `data-action` —
pointing at `docs/TROUBLESHOOTING-applicationv2-windows.md`. The composer has
been rebuilt to match, and the window CSS is now shared across all four
authoring windows (`.terminal-compose .compose-wrap` / `.compose-form` /
`.compose-actions` / `.compose-hint`).

## Files

- `scripts/datapad-edit.mjs` — NEW. `DatapadCreateApp`, `DatapadMetaApp`,
  `BlockEditorApp`, plus the text↔structure helpers.
- `templates/datapad-create.hbs`, `datapad-meta.hbs`, `datapad-block.hbs` — NEW.
- `scripts/sockets.mjs` — `createDatapad`, `setDatapadMeta`, `setDiscovered`,
  `upsertBlock`, `moveBlock`, `deleteBlock`, `normalizeBlockIds`.
- `scripts/terminal.mjs` — actions + handlers, discovery gate on collection
  navigation, `#prepDatapadDirectory` filter, `#prepDatapad` GM metadata.
- `templates/render/datapad.hbs`, `datapad-directory.hbs` — GM controls.
- `scripts/compose-request.mjs`, `templates/compose-request.hbs` — window
  pattern correction.
- `styles/terminal.css` — shared authoring chrome + datapad controls.

## Version-sensitive

- `JournalEntry.create()` with inline `pages` and `flags` — the new API surface
  here. If creation fails, that call is the first place to look.
- `DialogV2.confirm` for the block-delete confirmation.
- Everything else reuses paths already proven in this module.

## Test

1. As GM, open the datapad directory. `[ + NEW DATAPAD ]`, title it — the id
   auto-slugs. Create.
2. It appears dimmed with HIDDEN. As a player (second login), the directory
   does not list it at all.
3. As that player, navigate directly to `datapads/<id>` (via a link or a hub
   card): you get the standard not-found state, not a locked datapad.
4. As GM, open it. `[ + add block ]` → heading. Add a `table` block with
   pipe-delimited rows. Add a `text` block, tick encrypted, give it a lock
   label.
5. Reorder with `[ ↑ ]` / `[ ↓ ]`. Reveal the secret block, then move it — it
   stays revealed (the id followed it).
6. `[ release ]`. The player now sees the datapad listed, sees the heading and
   table, and sees an ENCRYPTED bar with your lock label where the secret block
   is.
7. `[ reveal ]` that block as GM — it appears live on the player's screen.
8. `[ hide ]` the datapad again. It vanishes from the player's directory, and
   their open terminal falls back to the not-found state on re-render.
9. Open an existing hand-authored datapad (e.g. cerberus-ops) and edit one
   block. Confirm previously revealed blocks are still revealed — that's the
   id backfill working.
