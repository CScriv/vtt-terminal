# Terminal — Stage 4 (intranet): requisitions + crew requests

ONE render type — "request-board" — serves both boards. Each board is a single
standalone screen holding a `requests` array, grouped by status into declared
sections, date descending. They differ only in JSON (statuses, sections,
optional accent + promote link).

## Schema
{
  "render": "request-board",
  "title": "...", "tag": "SASO", "prompt": "...",
  "cardClass": "req-mission",          // optional accent; crew requests use blue
  "sections": [
    { "name": "OPEN REQUESTS", "statuses": ["open"] },
    { "name": "FULFILLED", "statuses": ["fulfilled"], "dim": true },
    { "name": "DENIED", "statuses": ["denied"], "dim": true }
  ],
  "requests": [
    {
      "id": "rq-001", "title": "...",
      "from": "Lisa Voss", "fromId": "voss",   // fromId -> links to crew/voss
      "role": "Doctor",
      "status": "open", "date": "28 Oct",
      "body": "...",
      "promote": { "target": "missions/kairavamori", "label": "see Mission Log" } // optional
    }
  ]
}

- Sections render in order; "dim": true defaults the section CLOSED and dims its
  cards (resolved states). A request whose status matches no section -> "OTHER".
- Date descending within each section (handles "28 Oct" and ISO).
- "cardClass" applies a board-wide card accent. Requisitions: omit (amber
  default). Crew Requests: "req-mission" (blue).
- "promote" (crew requests, accepted): links the card to a Mission Log entry.

## Status flags
open (amber) / fulfilled (grey) / denied (dark red) for requisitions;
open / accepted (blue) / complete (grey) / declined (dark red) for crew requests.
All flag colors are in the theme.

## Setup / test
1. Requisitions: journal w/ screen-requisitions.json, id "requisitions", Live.
2. Crew Requests: journal w/ screen-requests.json, id "requests", Live.
   (Link both from your Intranet hub.)
3. Open each: collapsible status sections, OPEN default-open, resolved sections
   (FULFILLED/DENIED/CLOSED) default-closed + dimmed. Requester names link to
   dossiers. On Crew Requests, the accepted Markov beacon card shows PROMOTED TO
   OPERATION -> jumps to the Kairavamori mission. Crew Request cards carry the
   blue accent; Requisitions cards the amber.
