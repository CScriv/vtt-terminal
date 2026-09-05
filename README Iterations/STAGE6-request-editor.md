# Terminal — in-terminal request authoring (requisitions + crew requests)

Requisitions and Crew Requests can now be CREATED and EDITED from inside the
terminal. Both boards share the "request-board" render type, so one composer
window serves both. GM-only: players keep the status-change interaction they
already had, and gain nothing else.

## What's new

- `[ NEW REQUEST ]` above the board (GM only) -> opens a blank composer.
- `[ edit ]` on each card (GM only) -> opens the composer pre-filled.
- One write action, `upsertRequest`: a requestId that resolves patches in
  place, anything else appends. Create and edit are the same code path.
- Soft archive: a status, not a new mechanism (see below).

## Composer fields

| Field | Notes |
|---|---|
| Title | Required. |
| Requester (crew) | Dropdown from the crew collection. Sets `fromId`, so the card's requester name links to the dossier. Full names, per the records-vs-feed nickname rule. |
| …or custom name | For requesters who aren't crew. Overrides the dropdown, sets `from` with no `fromId` (no link). |
| Role | Auto-fills from the picked member's dossier if left blank; freely editable. |
| Status | Populated from the board's own `sections`, same source the status popup reads. |
| Body | The request text. |
| Link to an operation | Optional. Mission dropdown (from the missions collection) + link text, writing the existing `promote: { target, label }`. Link text defaults to the mission name. |
| Override the date | Optional. See dates, below. |

Cleared fields are DELETED from the JSON rather than written as empty strings,
so the card's optional blocks disappear instead of rendering blank.

## Soft archive

Archiving is a status plus a section flag, not a delete. Add to each board's
JSON `sections`:

```json
{ "name": "ARCHIVED", "statuses": ["archived"], "dim": true, "gmOnly": true }
```

- `gmOnly: true` — the section renders for the GM only, and `archived` is
  withheld from the player-facing status popup.
- Archived requests are matched for everyone before the GM filter is applied,
  so they count as claimed. Without that they'd fall through to the catch-all
  OTHER section and stay visible — the exact thing archiving is for.
- Un-archiving is just setting the status back. Nothing is ever destroyed.

## Dates: `wt` vs `date`

Requests composed in-app are stamped with `wt` (in-world time, via
`terminalWorldTime()`), the same sortable stamp the feed and inbox use. The
board prefers `wt` for both sorting and display, and falls back to parsing the
authored `date` string for hand-written entries. Existing boards need no
changes.

- New request: stamped automatically. The date override field is offered but
  usually left blank.
- Editing a `wt`-stamped request: the date field is disabled, because two
  competing date sources is how boards drift. To force a manual date, clear
  `wt` in the Terminal Data JSON editor.
- Editing does NOT restamp `wt`, so fixing a typo doesn't jump the card to the
  top of the board.

## Attribution stays where it was

The composer does not set `updatedBy`. That field means "who responded to this
request" and is owned by the status-click popup, which already has the crew
picker and custom-name override for it. The composer sets `createdAt` on new
requests and `editedAt` on edits (stored, not displayed).

## Permissions

GM-only at three layers: the controls only render when `canEdit`/`canCompose`
is true, `ComposeRequestApp` re-checks on open, and `upsertRequest` re-checks
GM-side before touching the journal. A crafted socket emit from a player client
is rejected at the last one. Status changes are untouched and still work for
players.

## Requirements

- The board MUST be flag-stored (Terminal Data -> Use flag storage). Writes go
  to `flags.terminal.json`. Body-stored boards can't receive them.
- Because the write is GM-only there's no "GM must be connected" case here —
  the GM is the one doing it.

## Files

- `scripts/compose-request.mjs` — NEW. `ComposeRequestApp` (create + edit).
- `templates/compose-request.hbs` — NEW. The composer form.
- `scripts/sockets.mjs` — `upsertRequest` case + handler, `nextRequestId`,
  `assignOrDelete`.
- `scripts/terminal.mjs` — import, `composeRequest`/`editRequest` actions and
  handlers, `gmOnly` filter in `#onSetStatus`, rewritten `#prepRequestBoard`.
- `templates/render/request-board.hbs` — compose bar + per-card edit control.
- `styles/terminal.css` — compose bar, edit control, composer window.

## ID scheme

New requests continue the hand-authored numbering: the handler scans for the
highest `rq-###` and increments, zero-padded to three digits. Only the GM
writes, so max+1 can't race. Ids are minted GM-side, never in the form.

## Version-sensitive

- `ApplicationV2` `form: { handler, closeOnSubmit }` and the
  `(event, form, formData)` handler signature. If submitting does nothing,
  check that shape first for your build.
- The composer throws on an empty title to keep the window open rather than
  closing and discarding the draft. If a future version stops honouring that,
  the symptom is a closed window on a validation failure.

## Test

1. Add the ARCHIVED section to both board JSONs. Confirm both boards are
   flag-stored.
2. As GM, open Requisitions -> `[ NEW REQUEST ]`. Pick a crew member; the role
   fills in. Post. The card appears at the top of OPEN, requester name links to
   the dossier.
3. `[ edit ]` that card, change the body, save. Card updates in place and does
   NOT move.
4. Set its status to `archived`. As GM it moves to ARCHIVED; as a player
   (second login) it disappears entirely — and does not reappear under OTHER.
5. As a player, click a status: `archived` is absent from the popup, and there
   is no compose bar or edit control anywhere.
6. On Crew Requests, create a request and link it to a mission. The card shows
   PROMOTED TO OPERATION and navigates correctly.
