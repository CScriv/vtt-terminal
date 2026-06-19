# Terminal — Stage 4 (missions): board + detail (core)

Missions are a collection, exactly like crew. Each mission is its own flagged
journal (Collection "missions", id e.g. "dark-horizon"). The dispatch board
discovers them and generates itself, grouped by status into sections, date
descending within each.

## Render types
- "mission-board": standalone screen (Collection blank, id "missions"). Declares
  its collection + the status sections. Generates the board.
- "mission": each mission journal. Renders the detail. Parent/child links are
  derived: a child declares "parent": "<id>"; a parent's children are found by
  filtering the collection (one in-memory pass over the already-loaded set).

## Board screen JSON
{
  "render": "mission-board",
  "title": "...", "tag": "SASO", "prompt": "OPERATIONS DISPATCH BOARD",
  "collection": "missions",
  "sections": [
    { "name": "ACTIVE OPERATIONS", "statuses": ["active","ongoing"] },
    { "name": "MISSION ARCHIVE", "statuses": ["complete","failed","abandoned"], "archive": true }
  ]
}
Sections render in order; "archive": true dims the table. A mission whose status
matches no section is appended in an "OTHER" section (nothing vanishes).

## Mission JSON (core)
{
  "render": "mission",
  "name": "DARK HORIZON",
  "status": "complete",                 // drives board section + flag
  "issueDate": "18 October 2186",        // shown on detail
  "date": "2186-10-18",                  // ISO; used for board sort (desc)
  "issuedBy": "...",
  "location": "Horizon — Iera",          // board column + detail meta
  "reward": "₡75,000",
  "parent": "amber-shadow",              // optional: this mission's umbrella
  "briefing": [ "para 1", "para 2" ]     // optional prose
}
- "date" (ISO) is for reliable sorting; "issueDate" is the human label shown.
  If you only provide issueDate, sorting falls back to parsing it (works for
  "18 October 2186"); providing ISO "date" is just more robust.
- Parent operations need no child list — children are derived from who claims
  them via "parent".

## Test
1. Board: journal with screen-missions.json, Collection blank, id "missions".
   (Main hub already links MISSION LOG -> "missions".)
2. Missions: one journal each for the 5 samples, Collection "missions", ids:
   amber-shadow, dark-horizon, kairavamori, recruitment. Live.
3. Open terminal -> MISSION LOG. Active section shows Kairavamori (28 Oct),
   Amber Shadow (15 Oct), Recruitment (06 Oct) date-desc; Archive shows Dark
   Horizon. Click Amber Shadow -> detail shows LINKED OPERATIONS (Kairavamori +
   Dark Horizon, derived). Click Dark Horizon -> shows PART OF: Amber Shadow.

## Deferred to a later pass (richer mission blocks)
amber in-character notes, after-action report + acquisitions, bounty tally.
Core board + detail + parent/child is what's here.

# --- Mission detail: full blocks ---

The mission detail now renders all block types (each optional, appears only when
present), in order: meta -> briefing -> notes -> AAR -> tally -> LINKED OPS -> PART OF.

## Structured location
"location": { "sector": "...", "cluster": "...", "system": "...", "planet": "..." }
shows as separate meta rows on the detail. The BOARD column uses a short label:
provide "locationLabel": "Horizon — Iera" for the board; if omitted, the board
derives "planet — system". Any location field can be omitted.

## In-character notes (amber)
"notes": [ { "label": "ADDITIONAL NOTES", "body": "...", "sig": "June" } ]
label + sig optional. Multiple notes allowed (array).

## After-action report (green) — completed missions
"aar": { "body": [ "para", ... ], "acquisitions": [ { "name": "X", "tag": "Y" } ] }
acquisitions optional/empty -> the ACQUISITIONS list is skipped.

## Bounty tally (steel-blue) — any mission
"tally": {
  "stats": [ { "num": "1", "label": "Ships Destroyed" }, { "num": "₡40,000", "label": "Credits Earned" } ],
  "entries": [ { "date": "...", "location": "...", "notes": "...", "bounty": "..." } ]
}

All blocks reuse existing theme CSS (mission-note / resolution / acq / tally) —
no new styling. Samples: dark-horizon (note + AAR), bounty-geth (tally).
