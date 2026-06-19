# Terminal — Inbox (receive + GM compose)

A per-viewer inbox. Filters by the viewer's BOUND crew member id (+ their
department). GM sees everything. Inbox/Sent split. Read/unread per viewer.
Player-to-player sending is a LATER pass; this is receive + GM compose.

## Storage
One inbox screen journal, FLAG-STORED, render "inbox", holding messages: [...].
Standalone screen (Collection blank, id e.g. "inbox"). Link from the main hub.

## Message schema
{
  "id": "msg-001",
  "from": "<crewMemberId>",
  "to": [ "<crewMemberId>" | "<DepartmentName>", ... ],   // ids AND/OR departments
  "subject": "...",
  "time": "26 Oct — 0900",       // GM-composed messages get an in-game stamp
  "body": "...",
  "read": [ "<crewMemberId>", ... ]
}

## Addressing: id OR department
- A recipient is either a crew member id (direct) or a Department name (group).
- Department recipients are resolved at RENDER against each dossier's
  "department" field — so "Security" reaches everyone currently in Security,
  including members added later (derive, don't snapshot).
- Store the id/department; the TO/FROM lines DISPLAY resolved names.

## Filtering (per viewer)
- GM: sees all messages in the Inbox section (no Sent box; uses Compose).
- Player: resolve their bound member id.
  - INBOX: messages where they're a direct recipient OR their department is
    addressed.
  - SENT: messages where they are the "from".
  - Unbound player: "no mailbox associated" notice.

## Read state
Opening a message (expanding it) appends the viewer's member id to read[].
Unread messages show a red dot + accent and count in the Inbox header.

## GM compose
Inbox screen (as GM) -> "[ COMPOSE MESSAGE ]" -> dialog:
  From (crew picker), To (multi-select: Departments + Crew, Ctrl/Cmd-click for
  several), Subject, Body. Sends via the relay; message gets an in-game
  timestamp and appends to the inbox.

## KNOWN BEHAVIOR TO VERIFY IN TESTING
Marking a message read writes to the journal, which triggers the live re-render
hook. We suppress the re-render on the WRITER's client so the just-opened
message stays expanded — but since a player's mark-read routes through the GM,
the cross-client case (player opens -> GM writes -> player re-renders) may still
collapse the opened <details> on the player's screen. TEST THIS: if a player's
message collapses right after opening, we'll make mark-read skip live re-render
entirely (read state would then update on the next natural render, which is
acceptable). Flagged honestly rather than assumed solved.

## Requirements
- Inbox FLAG-STORED (writes: read-state, sends).
- Players need a binding (Configure Player Bindings) to have a mailbox.
- GM connected for player read-writes (relay).

## Test
1. Inbox screen journal w/ screen-inbox.json, flag-stored, id "inbox", live.
   Link it from the main hub.
2. Bind a player to "matthews". As that player: INBOX shows "Welcome aboard"
   (direct). Open it -> marks read (dot clears).
3. Bind a player to a Security member (e.g. domitus). They see "Pre-mission
   medical check" (department-addressed).
4. As matthews, SENT shows "Re: Welcome aboard".
5. As GM: Compose -> from Voss, to [Security] + a crew member, subject/body ->
   Send. Recipients see it per their binding.
