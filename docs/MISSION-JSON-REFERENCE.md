# Mission JSON — authoring reference

How to build a mission record for the terminal. Each mission is one journal in
the **`missions`** collection: set its Terminal Data → Collection `missions`,
id = a slug (e.g. `dark-horizon`), enabled. The JSON below goes in the body (or
the flag, but missions don't need to be flag-stored — they aren't written to).

The Mission Log board (`mission-board`) self-generates from these members; each
mission's detail screen renders from its own JSON.

---

## Minimal mission

Only a handful of fields are required. Everything else is optional and simply
doesn't render if absent.

```json
{
  "render": "mission",
  "name": "HIGHWAY ROBBERY",
  "status": "complete",
  "issueDate": "07 October 2186",
  "date": "2186-10-07",
  "issuedBy": "James Markov",
  "reward": "Ship Upgrades",
  "briefing": [
    "James Markov tells you he recently worked on an Eclipse ship and planted a tracking beacon."
  ]
}
```

---

## Full field reference

### Core (recommended on every mission)

| Field | Type | Notes |
|---|---|---|
| `render` | string | Always `"mission"`. Required. |
| `name` | string | Mission title (shown on board + detail header). Required. |
| `status` | string | One of: `active`, `ongoing`, `complete`, `failed`, `abandoned`. Drives which board section it lands in. Required. |
| `issueDate` | string | Human display date, e.g. `"18 October 2186"`. Shown on detail + board. |
| `date` | string | ISO date `YYYY-MM-DD`. Used to **sort** the board (newest first). If omitted, falls back to `issueDate`. Best to always include for correct ordering. |
| `issuedBy` | string | Who issued it, e.g. `"Special Operations Commander — Lidia Juniper"`. |
| `reward` | string | Free text. Use the `₡` glyph for credits, e.g. `"₡75,000"`. |

### Location

```json
"location": { "sector": "Attican Traverse", "cluster": "Shadow Sea", "system": "Iera", "planet": "Horizon" },
"locationLinks": { "sector": "attican-traverse", "cluster": "shadow-sea", "system": "iera", "planet": "horizon" },
"locationLabel": "Horizon — Iera"
```

| Field | Type | Notes |
|---|---|---|
| `location` | object | Structured fields: `sector`, `cluster`, `system`, `planet`. Any may be omitted, `"None"`, or `"ANY"`. Shown as a labelled list on the detail screen. |
| `locationLinks` | object | OPTIONAL. Same keys as `location`; values are **location member ids**. A field becomes a clickable link to that location screen. Only add keys for locations you've actually built (others stay plain text). |
| `locationLabel` | string | Short label shown in the board's Location column, e.g. `"Horizon — Iera"`. If omitted, the board derives `"<planet> — <system>"` from `location`. |

### Briefing

```json
"briefing": [
  "First paragraph of the briefing.",
  "Second paragraph.",
  "Each array entry is its own paragraph."
]
```

| Field | Type | Notes |
|---|---|---|
| `briefing` | array of strings | The main mission text. Each string renders as a paragraph. |

### Notes (the boxed "▶ ADDITIONAL NOTES" callouts)

```json
"notes": [
  { "label": "ADDITIONAL NOTES", "body": "Use discretion.", "sig": "June" }
]
```

| Field | Type | Notes |
|---|---|---|
| `notes` | array of objects | Each is a highlighted note box. |
| `notes[].label` | string | Heading of the note box (rendered with a ▶). |
| `notes[].body` | string | The note text. |
| `notes[].sig` | string | OPTIONAL signature line, e.g. `"June"` → renders as `— June`. |

### After-Action Report (for completed missions)

```json
"aar": {
  "body": [
    "What happened, paragraph one.",
    "Paragraph two."
  ],
  "acquisitions": [
    { "name": "Dr. Lisa Voss", "tag": "Medical Officer" },
    { "name": "Crash Couches", "tag": "Ship Upgrade" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `aar` | object | The green AFTER-ACTION REPORT block. Include when a mission is resolved. |
| `aar.body` | array of strings | Outcome paragraphs. |
| `aar.acquisitions` | array of objects | OPTIONAL loot/recruits list. Each `{ name, tag }` — `tag` is the small label after the item (e.g. `"Ship Upgrade"`). Use `[]` or omit if none. |

### Tally (for ongoing count-based missions, e.g. bounties)

```json
"tally": {
  "stats": [
    { "num": "1", "label": "Ships Destroyed" },
    { "num": "₡40,000", "label": "Credits Earned" }
  ],
  "entries": [
    { "date": "10 Oct 2186", "location": "Dholen — Far Rim", "notes": "Engaged on arrival.", "bounty": "₡40,000" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `tally` | object | A running scoreboard + log table (for bounties / recurring objectives). |
| `tally.stats` | array of objects | Big-number summary cells. Each `{ num, label }`. |
| `tally.entries` | array of objects | Log rows. Each `{ date, location, notes, bounty }`. |

### Parent / children (mission hierarchy)

```json
"parent": "amber-shadow"
```

| Field | Type | Notes |
|---|---|---|
| `parent` | string | OPTIONAL. The id of a parent mission. Declaring this makes THIS mission a child of that one. |

**Children are derived, never hand-listed.** A parent mission (e.g. Operation
Amber Shadow) automatically shows a LINKED OPERATIONS table of every mission
that declares `"parent": "<this mission's id>"`. To add/remove a child, just
set or clear its `parent` — never edit a list on the parent. The parent also
needs no special field to "be" a parent; it simply gets a derived table when
children point at it. Children show a `PART OF` link back up to the parent.

---

## Status → board section

The board (`mission-board`) groups by the `sections` defined on the board
screen. The default config:

```json
"sections": [
  { "name": "ACTIVE OPERATIONS", "statuses": ["active", "ongoing"] },
  { "name": "MISSION ARCHIVE", "statuses": ["complete", "failed", "abandoned"], "archive": true }
]
```

So `active`/`ongoing` → ACTIVE OPERATIONS (open, top), and
`complete`/`failed`/`abandoned` → MISSION ARCHIVE (collapsible, dimmed). The
`active` vs `ongoing` split is flavor only unless you change the section config —
both land in the same section by default. Within a section, missions sort by
`date` descending (newest first).

---

## Field order (cosmetic)

Order doesn't affect function, but for consistency the existing files use:
`render, name, status, issueDate, date, issuedBy, parent, location,
locationLinks, locationLabel, reward, briefing, notes, tally, aar`.

---

## Quick checklist for a new mission

1. `render: "mission"`, a `name`, a `status`.
2. `issueDate` (display) + `date` (ISO, for sorting).
3. `issuedBy`, `reward` (with `₡` for credits).
4. `location` block; add `locationLinks` only for built location screens; set a
   `locationLabel` for the board.
5. `briefing` paragraphs.
6. `notes` for any in-character callouts.
7. If resolved: `aar` with `body` (+ `acquisitions`).
8. If a bounty/recurring: `tally`.
9. If part of a larger op: `parent` (and nothing else — the parent derives it).
10. Import: journal → Collection `missions`, id = slug, enabled.
