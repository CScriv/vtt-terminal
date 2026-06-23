# Inbox / Mail (`render: "inbox"`)

Per-viewer secure messaging. A single inbox journal holds every message;
each viewer sees only their own mail, grouped into **threads**. Clicking a
thread opens a dedicated thread screen (a derived view over the same
journal — there is no per-thread journal). The GM can view any crew
member's mailbox via a filter.

The inbox is one journal flagged `flags.vtt-terminal.*` with `render:
"inbox"`, discovered by the data layer like any other screen. Unlike the
collection-backed screens, all its content lives inline in the screen JSON
(`messages` + `threads`), not in member journals.

## Schema

```json
{
  "render": "inbox",
  "title": "...",
  "tag": "SASO",
  "prompt": "SECURE MESSAGING",
  "messages": [
    {
      "id": "msg-001",
      "threadId": "msg-001",
      "inReplyTo": null,
      "from": "byas",
      "to": ["matthews"],
      "subject": "Welcome aboard",
      "wt": 69009367920,
      "body": "..."
    },
    {
      "id": "msg-003",
      "threadId": "msg-001",
      "inReplyTo": "msg-001",
      "from": "matthews",
      "to": ["byas"],
      "wt": 69009369720,
      "body": "..."
    }
  ],
  "threads": {
    "msg-001": { "read": ["matthews"], "deleted": [] }
  }
}
```

### Message fields

| Field       | Required | Meaning |
|-------------|----------|---------|
| `id`        | yes      | Stable id. Written messages use `msg-<8 hex>`. |
| `threadId`  | yes      | The thread this message belongs to. A **root** message sets `threadId === its own id`; a **reply** inherits the parent's `threadId`. |
| `inReplyTo` | yes      | Parent message id, or `null` for a thread root. |
| `from`      | yes      | Sender **crew member id** (resolved to a name at render). |
| `to`        | yes      | Array of recipients, each a **crew member id** *or* a **department name** (e.g. `"Security"`). Department recipients deliver to every member of that department. |
| `subject`   | root only| The thread subject, carried on the **root message**. Replies omit it (the thread *is* the subject — no "Re:"). |
| `wt`        | yes      | Sortable in-world timestamp (`game.time.worldTime` seconds) at send. Threads sort by their newest message's `wt`; messages within a thread read oldest-first. Purely in-world, never wall-clock. |
| `body`      | yes      | Message text. |

> Note `read` does **not** live on messages. Read state is per-thread (see
> below), because the thread is the unit of the screen.

### Thread records (`threads` map)

`threads` is keyed by `threadId` and holds the per-thread, per-member state
that the message objects don't:

| Field     | Meaning |
|-----------|---------|
| `read`    | Array of **member ids** caught up on the thread. A member not listed sees the thread as unread. |
| `deleted` | Array of **member ids** who moved the thread to their Trash. Parallel to `read`. |

Both are arrays of member ids — the same per-person-state model as the feed
reactions, chosen so divergent recipients stay correct (two members on
different subsets of a thread can legitimately differ in read/deleted
state).

## Identity & visibility

All identity is **id-based**; names resolve from the crew collection at
render (nickname-aware where the member declares one). `#inboxContext`
centralizes this: it resolves the viewer's id, their department, and the
crew name lookup once.

A message is **visible** to a viewer if they are a direct recipient
(`to` contains their id), a department recipient (`to` contains their
department), or the sender (`from`). The GM (unfiltered) sees everything.

A **thread** is visible to a viewer if any of its messages are visible to
them. The inbox lists one row per visible thread; the thread screen shows
only the messages within it that the viewer can see.

## Threads, read state & resurfacing

The inbox is a **list of threads**, not messages. `#prepInbox` groups the
viewer's visible messages by `threadId` and builds one row each: subject
(from the root), participant names, message count, newest-message time, and
an unread dot when the viewer is not in `threads[id].read`. Rows sort
newest-active first and navigate to `inbox/thread/<threadId>`.

Read is **thread-level**:
- Opening a thread marks it read for the viewer (adds them to
  `threads[id].read`).
- A reply **clears read** for its recipients (removes their ids), so new
  mail directed at someone re-flags the thread unread for them — and only
  for them. The replier stays read.

This is why read survives divergent recipients: a reply that excludes a
participant never touches that participant's read state.

## Deleting threads (Trash)

Delete is **per-thread, per-user** — "hide this from my mailbox," not a
destructive delete. It mirrors `read`:

- **Delete** (the `✕` on an inbox row) adds the viewer to
  `threads[id].deleted`. The thread leaves their active inbox and collects
  in a default-closed **Trash** section at the bottom.
- **Restore** (the `↷` on a trashed row) removes them from `deleted`.
- **Resurfacing:** a reply removes its recipients from `deleted` (the same
  line that clears `read`), so a deleted thread automatically returns,
  unread, when someone replies to you. No timestamps, no "undelete"
  special-case — resurfacing is recipient-based, identical in spirit to how
  read works.

The GM view ignores `deleted` entirely (admin sees everything); the delete
and restore controls don't render for the GM.

## GM mailbox filter

The GM gets a **"VIEWING AS"** crew dropdown above the thread list. With
"— ALL MAILBOXES —" (default) the GM sees every thread (the admin
overview). Selecting a crew member renders the inbox **as that member**:
their visible threads, their read/unread, their Trash — a faithful
reproduction of what that player sees. Useful for auditing NPC mailboxes or
a fast-filling inbox.

It's a **viewing** tool: `isGM` stays true while filtering, so no write
controls (delete/restore) appear — the GM isn't acting *as* the player. The
filter is instance state that persists across inbox ↔ thread navigation
(drill into a thread as that member and back, still filtered) and clears
when leaving the inbox. While filtering, the thread header tags `AS
<member>`.

## Interaction (write layer)

All writes route through `requestWrite(...)` in `sockets.mjs` to the GM
client, which performs the journal update; the `updateJournalEntry` hook
re-renders open terminals so mail appears live.

### `sendMessage` — new message or reply
- New compose (`[ COMPOSE MESSAGE ]`) opens `ComposeMessageApp`. A new
  message roots its own thread (`threadId = its id`, `inReplyTo = null`) and
  carries the subject.
- Reply (`[ REPLY ]` on the thread screen) opens `ComposeMessageApp` in
  **reply mode**: recipients prefilled to the newest message's participants
  minus the viewer (editable), subject shown but **locked** to the thread
  subject. The send inherits `threadId` + `inReplyTo` so it nests; the
  reply omits a stored subject.
- On send, the thread record is ensured; the **sender** is marked read; a
  reply **clears read + deleted** for its recipients (resurface + unread).
- Anti-spoof: a non-GM may only send as their bound member (re-checked
  GM-side).

### `readThread` — mark a thread read
- Fired when the thread screen opens (`data-action="openThread"`). Adds the
  viewer's member id to `threads[id].read`. No-op if already read.

### `deleteThread` / `restoreThread` — Trash a thread / bring it back
- `deleteThread` (inbox-row `✕`) adds the viewer to `threads[id].deleted`.
- `restoreThread` (trashed-row `↷`) removes them.
- Both stop event propagation so the row's navigate doesn't also fire.
  Hidden for the GM.

## Navigation: the thread screen

A thread is **not** its own journal — it's a derived view. `parseTarget`
special-cases `inbox/thread/<threadId>` (before the generic `collection/id`
split) to `{ id: "inbox", view: "thread", threadId }`. `_prepareContext`
then loads the inbox journal, runs `#prepThread` (filter to the thread's
visible messages, oldest-first), and renders `templates/render/thread.hbs`
with a `THREAD › <subject>` header breadcrumb. Back returns to `inbox` via
the existing history stack.

## Files

| File | Role |
|------|------|
| `templates/render/inbox.hbs` | Inbox thread list + GM "VIEWING AS" filter + default-closed Trash section. |
| `templates/render/thread.hbs` | Thread detail: context bar, subject, messages oldest-first, reply control. |
| `scripts/compose.mjs` | `ComposeMessageApp` — new message **and reply mode** (locked subject, prefilled editable recipients, threadId/inReplyTo). |
| `templates/compose.hbs` | Compose window (subject read-only in reply mode). |
| `scripts/terminal.mjs` | `#inboxContext` (viewer identity + GM `asMemberId` override), `#prepInbox` (thread list, read/trash split, GM filter dropdown), `#prepThread`; handlers `#onOpenThread`, `#onReplyThread`, `#onDeleteThread`, `#onRestoreThread`, `#onFilterInbox`; `parseTarget` thread case; `thread` render template registration; `#inboxFilter` instance state. |
| `scripts/sockets.mjs` | Write handlers `sendMessage` (threaded), `readThread`, `deleteThread`, `restoreThread` + dispatch. |
| `styles/terminal.css` | Inbox/thread styling: `.thread-row`/`.thread-list`, `.thread-*` detail, `.inbox-filter`, `.thread-del`/`.thread-restore`, `.inbox-trash`. |

## Setup / test

1. A journal with the inbox JSON in a code block. Terminal Data → Collection
   **BLANK**, id `inbox`, **Live**. Your hub should link to screen `inbox`.
   Ensure Seasons & Stars is active so `wt` formats; the sample is anchored
   near reference `now = 69009558720`.
2. **Bind** a couple of users to crew members. Bind one to a member who's in
   a department that receives department mail (e.g. Security) to exercise
   department delivery.
3. **Thread list:** open the inbox. Confirm one row per thread, an unread
   dot where appropriate, participants/count/time, and that clicking a row
   opens the thread screen with the `THREAD › subject` header.
4. **Read:** open an unread thread; confirm the dot clears for that viewer
   and the thread shows read on their next inbox view (and stays unread for
   others).
5. **Reply:** from the thread screen, reply; confirm recipients prefill to
   the other participants (editable), the subject is shown but locked, the
   reply nests in the thread, and the thread goes unread for its recipients.
6. **Delete / Trash:** `✕` a thread; confirm it moves to the default-closed
   Trash section and leaves the active list. `↷` restore it. Then have
   someone reply to a deleted thread and confirm it **resurfaces** unread.
7. **GM filter:** as GM, use "VIEWING AS" to view a member's mailbox;
   confirm you see their threads, their unread count, and their Trash, with
   no delete/restore controls. Confirm a department member also sees
   department mail. Drill into a thread and back (filter persists); leave the
   inbox and return (filter resets to All).
8. **Anti-spoof:** confirm a player can only send as their own character.

> After CSS changes, hard reload (Empty Cache and Hard Reload, or
> Ctrl/Cmd+Shift+R) — Foundry caches module stylesheets. See
> `docs/TROUBLESHOOTING-applicationv2-windows.md`, Problem 3.
