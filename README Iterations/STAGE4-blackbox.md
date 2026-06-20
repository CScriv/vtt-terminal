# Terminal — Stage 4 (black box): flight recorder

A standalone screen (no collection). One render type: "blackbox". A green
current-location callout above the full movement log; the current row is
highlighted. Current = last log entry (or one flagged "current": true).

## Schema
{
  "render": "blackbox",
  "title": "...", "tag": "SASO", "prompt": "DECRYPTING MOVEMENT LOG",
  "columns": ["Arrival Date", "Region", "Sector", "System", "Celestial Body"],
  "log": [
    { "Arrival Date": "01 October 2186", "Region": "EAS", "Sector": "Local Cluster", "System": "Sol", "Celestial Body": "Earth" },
    ...
    { "Arrival Date": "28 October 2186", "Region": "TS", "Sector": "Omega Nebula", "System": "Kairavamori", "Celestial Body": "Research Station" }
  ]
}

- columns: ordered headers. The callout shows ALL columns as labeled fields.
  If omitted, columns are derived from the union of keys in the log.
- log: chronological entries. The LAST entry is "current" -> it populates the
  callout and gets the highlighted row. To override, add "current": true to a
  specific entry.
- Add a movement = append one entry. Callout + highlight update automatically
  (derived, not hand-maintained).

## Setup / test
1. Journal with screen-blackbox.json in a code block. Terminal Data ->
   Collection BLANK, id "blackbox", Live. (Main hub links BLACK BOX -> "blackbox".)
2. Open terminal -> BLACK BOX. Green CURRENT LOCATION callout shows the last
   entry (Kairavamori Research Station) as labeled fields; the movement table
   lists all entries with that row highlighted.

All CSS (current-loc / current-loc-fields / row-current) already in theme.
