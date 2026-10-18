# Storage migration plan — journals → pages

Status: **proposed**, nothing built yet. Written against 0.4.1 + the write
fixes in `e9b74a7`.

## The problem

Every terminal record is its own JournalEntry: each crew dossier, mission,
location, datapad, plus every standalone screen (hub, boards, feed, inbox,
black box, directories). Today that's ~23 journals from the sample data
alone, and it grows by one for every NPC, mission and datapad you author.
They crowd the Journals tab even though nobody reads them there; the terminal
is the real UI.

Secondary costs of the same design:

- Every read scans `game.journal` (`findScreenJournal`, `findCollectionMembers`)
  and re-parses JSON. `loadCollection("crew")` alone is called from about a
  dozen places across `terminal.mjs`, the compose windows and `bindings.mjs`.
- The feed and inbox are single blobs. Every reaction, reply or read receipt
  rewrites every post or message ever made.
- The re-render hook only listens to `updateJournalEntry`, so creating or
  deleting a record (e.g. `createDatapad`) doesn't refresh open terminals.

## Target model

Records become **pages** inside a small, fixed set of container journals,
all in one sidebar folder.

```
📁 Terminal
   📖 Terminal · Screens     ← hub, boards, black box, directories, plus the
                                feed and inbox screen headers (title/tag/prompt)
   📖 Terminal · Crew        ← one page per dossier
   📖 Terminal · Missions    ← one page per mission
   📖 Terminal · Datapads    ← one page per datapad
   📖 Terminal · Locations   ← one page per location (all tiers)
   📖 Terminal · Feed        ← one page per post (replies + reactions inside it)
   📖 Terminal · Inbox       ← one page per thread (messages + read/deleted inside it)
```

That's seven journals in one collapsible folder, however much you author.
Opening one in the sidebar shows its records as a page list.

(Container layout: one journal per collection was chosen over a single journal;
see "Single journal vs. one per collection" below.)

### Page type

The module declares a custom page subtype in `module.json`:

```json
"documentTypes": {
  "JournalEntryPage": { "record": {} }
}
```

Foundry namespaces module subtypes, so pages are created as
`type: "vtt-terminal.record"`. A `TypeDataModel` registered at `init` in
`CONFIG.JournalEntryPage.dataModels["vtt-terminal.record"]` defines:

| field        | type        | replaces                               |
|--------------|-------------|----------------------------------------|
| `recordId`   | string      | `flags.vtt-terminal.id`                |
| `collection` | string/null | `flags.vtt-terminal.collection`        |
| `enabled`    | boolean     | `flags.vtt-terminal.enabled`           |
| `payload`    | object      | `flags.vtt-terminal.json` / body JSON  |

Feed posts and inbox threads use the same page type, with collection
`feed:<screenId>` / `inbox:<screenId>`, so a world can have more than one
feed or inbox.

The payload stays free-form JSON for now. Strict per-type schemas are a
separate, later job (see "Later").

Container journals are identified by a flag
(`flags.vtt-terminal.container = "crew"`), not by name, so renaming one in
the sidebar is harmless.

### Feed and inbox, split

**Feed.** The feed screen record keeps `render`, `title`, `tag` and `prompt`.
Each post becomes its own page holding the post exactly as it sits in today's
`posts[]` array, with its `replies` and `reactions` inside it. A reaction or
reply rewrites one post. The renderer rebuilds `posts[]` from the pages,
sorted by world time, so `#prepFeed`, archiving (`feedArchiveDays`) and
pinning don't change.

**Inbox.** Messages are grouped into threads already (`threadId`, with
per-thread `read` / `deleted` in `data.threads`). Each thread becomes one
page: `{ threadId, messages: [...], read: [...], deleted: [...] }`. Sending a
reply or marking a thread read rewrites that thread only. The renderer
rebuilds `messages[]` and `threads{}` from the pages.

The write functions in `sockets.mjs` change from "find the post in the feed
blob" to "load the post's page". Each one gets shorter, and the
`readThread` re-render suppression still works the same way.

## Why pages and not the alternatives

- **World settings**: invisible in the sidebar, but each setting is one blob
  rewritten in full on every change and broadcast to every client. Fine for
  player bindings, wrong for a feed.
- **Compendium pack**: also off the sidebar, but reads are async. Every
  `_prepareContext` would need an awaited, cached load, which touches nearly
  every render path in `terminal.mjs`.
- **Files in `Data/`**: no live sync, no permissions model, no undo.

Pages stay synchronous, live-syncing and permissioned. A write only rewrites
the one page that changed.

## Phases

Two worlds use this module, and both get migrated right away, so there's no
long dual-storage period. The old journal code exists only long enough to
migrate, then it goes.

### Phase 1 — storage layer (refactor, no behaviour change)

Put one seam between the module and Foundry documents.

- `data.mjs` gets a **record** abstraction: `{ doc, recordId, collection,
  enabled, payload }`. The existing `loadScreen` / `loadCollection` /
  `loadMember` / `find*` keep their signatures and return the same shapes,
  so `terminal.mjs`, the compose windows and `bindings.mjs` don't change.
- `savePayload(record, data)` writes through the record (forced replacement,
  as today).
- New `createRecord()`, `renameRecord()` and `deleteRecord()`. `createDatapad`,
  `setDatapadMeta` and the importer's `upsertRecord` use these instead of
  `JournalEntry.create` / `journal.update`.
- An in-memory **index**, `Map("collection/id" → record)`, built once and
  invalidated by document create/update/delete hooks. This replaces the
  per-call `game.journal` scans.
- The re-render hook covers create and delete, not just update.

Release + test: everything should behave exactly as in 0.4.x.

### Phase 2 — pages + migration

- Declare the `record` subtype and register its data model.
- Switch the record layer's backend to pages. New records (datapads,
  imports, posts, messages) are created as pages.
- Feed and inbox writes move to per-post / per-thread pages (as above).
- A GM-only **Migrate Terminal Storage** button (module settings) that, for
  each flagged journal:
  1. creates its container journal if missing, in a `Terminal` folder;
  2. creates a `vtt-terminal.record` page with the same id, collection,
     enabled flag and payload (body-authored JSON is parsed into an object);
     a feed or inbox gets split into its screen page plus one page per post
     or thread;
  3. moves the old journal into a `Terminal (legacy)` folder. **Nothing is
     deleted**.

  It reports created / skipped / failed counts. It's safe to run twice:
  records that already have a page are skipped.

- Until the migration has run, the terminal shows a GM-only banner saying
  "storage not migrated" instead of trying to read both formats.

Release + test on the dev world, then the game server. **Take a Foundry
world backup (Setup → Worlds → Backup) first.** If something goes wrong, the
untouched legacy journals plus the backup are the rollback.

### Phase 3 — remove the old code

As soon as both worlds are migrated and checked:

- delete the legacy journal reads in `data.mjs`, including the body-JSON
  `stripToJson` path;
- delete the migration button;
- retire `config.mjs` (the journal-header "Terminal Data" button) in favour of
  a page sheet for `vtt-terminal.record` (id / collection / enabled fields plus
  the existing JSON editor), so records open and edit straight from the
  sidebar;
- update `docs/` and the importer docs to describe pages.

Then you delete the `Terminal (legacy)` folder yourself once you're happy.

## What changes where

| file                     | phase | change                                         |
|--------------------------|-------|------------------------------------------------|
| `data.mjs`               | 1, 2, 3 | record layer, index, pages, legacy removal  |
| `sockets.mjs`            | 1, 2  | record helpers; per-post / per-thread writes   |
| `import.mjs`             | 1     | upsert through records                         |
| `terminal.mjs`           | 2     | feed/inbox assemble from pages; banner         |
| `module.json`            | 2     | `documentTypes`                                |
| `records.mjs` (new)      | 2     | `TypeDataModel` + registration                 |
| `migrate.mjs` (new)      | 2, 3  | migration (removed in phase 3)                 |
| `record-sheet.mjs` (new) | 3     | page sheet                                     |
| `config.mjs`             | 3     | removed                                        |
| compose windows, `bindings.mjs` | — | unchanged                               |

## Risks

- **Module disabled = pages invalid.** Pages of a module subtype fail
  validation while the module is off. Foundry keeps the data, but the pages show
  as invalid until the module is back. This is acceptable for a module the
  world is built around.
- **Subtype naming.** Verify the `vtt-terminal.record` namespacing on 13.x
  and 14.x at the start of phase 2, before anything is migrated.
- **Secrecy isn't a storage feature.** Hidden datapads and locked blocks are
  hidden by the UI, not by Foundry permissions, both today and after
  migration.

## Single journal vs. one per collection

A single `Terminal` journal would put just one entry in the sidebar, and
there'd be no container lookup at all. The costs:

- **The sheet becomes a junk drawer.** With the feed and inbox split out,
  most pages are posts and threads, which is hundreds over a campaign. Dossiers and
  missions would be buried among them in one page list.
- **One delete loses everything.** Deleting a journal deletes all its pages.
  With one container, a misclick on the wrong journal wipes the whole
  terminal. With separate containers, it wipes one collection.
- **Harder to move content.** A per-collection journal can be dragged into a
  compendium or another world as a unit ("our crew roster"). One mixed journal
  can't, without picking pages by hand.
- **Busier redraws.** An open journal sheet redraws its page list whenever
  any page changes. With everything in one journal, a GM who has it open
  sees it redraw on every player reaction.

The folder already gets you most of the tidiness: one collapsed `Terminal`
line in the sidebar either way. **Recommendation: one journal per collection.**

## Later (not in this plan)

- **Typed schemas per render type** (dossier, mission, datapad), giving
  validation, defaults, and real form fields instead of a JSON textarea.
- **Archiving** old posts or finished missions to a compendium.

## Decisions

- Feed and inbox split into per-post / per-thread pages: **yes** (in phase 2).
- Legacy journal code: **removed right after both worlds migrate** (phase 3),
  with no long dual-read period.
- Container layout: **one journal per collection** (above).
