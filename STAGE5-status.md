# Terminal — Stage 5 (part 2): player status changes

Players can change a request's status. The reusable socket relay underneath is
the foundation likes/comments will reuse.

## How it works
1. Click a request's status flag -> popup lists that board's valid statuses
   (read from its sections). GMs also get an optional "Responder name" field
   (to attribute an NPC, e.g. denying the Cobra request).
2. Pick a status -> the app calls requestWrite():
   - GM: writes directly.
   - Player: emits over socket "module.terminal"; the GM's client receives it,
     validates, and writes. (Requires a GM logged in.)
3. The write updates the request's status + updatedBy (+ updatedAt) in the
   board's flag JSON.
4. updateJournalEntry hook fires -> open terminals re-render -> everyone sees
   the change live.

## Requirements
- The board MUST be flag-stored (Terminal Data -> Use flag storage). Writes go
  to flags.terminal.json. Body-stored boards can't be written to this way.
- A GM must be connected for player-initiated changes (the GM client performs
  the write). No GM online -> the player gets a notice and nothing changes.

## Bookkeeping
- updatedBy: player's character name (fallback user name), or the GM's typed
  responder name. Shown on the card ("Status set by ...").
- updatedAt: ISO timestamp (stored, not currently displayed).

## Files
- scripts/sockets.mjs: the relay. requestWrite() (any client) -> performWrite()
  (GM only) -> setRequestStatus(). Add future actions as new cases in
  performWrite(). Self-wires on ready (socket listener + re-render hook).
- terminal.mjs: #onSetStatus opens the DialogV2 popup and calls requestWrite.
- request-board.hbs: status wrapped in a .req-status-btn (data-action=setStatus,
  carries request id + screen id).

## Version-sensitive
- game.socket.emit / .on with channel "module.terminal" — standard, stable.
- DialogV2 (foundry.applications.api.DialogV2) for the popup. If the popup
  errors, verify DialogV2.prompt's shape for 13.351.
- updateJournalEntry hook + changes.flags.terminal detection for re-render.

## Test
1. Ensure a request board (e.g. requisitions) is flag-stored and live.
2. As GM: open terminal -> requisitions -> click a status -> pick a new one
   (optionally type a responder) -> card updates, "Status set by ..." appears.
3. As a player (second login / browser): click a status -> pick -> the GM
   client writes it -> both clients re-render with the new status.
4. With no GM connected, a player change -> notice, no write.

# --- RESOLVED: socket provisioning ---
The module manifest MUST include "socket": true, or Foundry never provisions the
module.terminal namespace and the GM never receives player emits (symptom: player
emits succeed client-side, GM console silent). After adding it, a full WORLD
RESTART is required (module disable/enable or browser reload is NOT enough — the
socket namespace is established at world launch).

On the live server this is automatic: the manifest ships with socket:true, so it
provisions on first launch with no special steps.

If sockets still fail to receive on some v13 build (core bug #13316), the proven
fallback is the socketlib module, which abstracts the GM-relay pattern.

updatedBy now: player -> character name; GM blank -> no name stored; GM typed ->
that name.
