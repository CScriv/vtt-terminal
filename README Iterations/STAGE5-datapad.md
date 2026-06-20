# Terminal — Datapads (block list + GM reveal)

Datapads are a COLLECTION (each its own journal, like crew/missions). A directory
screen self-generates the list; each datapad's detail renders from a generic
BLOCK LIST. Secret blocks are GM-revealable, persisted, players only see revealed.

## Two render types
- "datapad-directory": standalone screen, collection "datapads". Lists datapads.
- "datapad": each datapad journal (collection "datapads"). Renders blocks.

## Block types (datapad.blocks[])
- heading:  { "type":"heading", "text":"..." }
- text:     { "type":"text", "label?":"...", "body?":"...", "items?":[...] }
- keyvalue: { "type":"keyvalue", "label?":"...", "rows":[["Key","Val"],...] }
- table:    { "type":"table", "label?":"...", "headers?":[...], "rows":[[...],...] }
- message:  { "type":"message", "subject?","from?","to?","date?","body?" }

Any block may carry "secret": true and should have a stable "id" (used as the
reveal target; falls back to b<index> if omitted, but ids are safer).

## Reveal mechanic (GM)
- A datapad's "revealed": [] array holds the ids of revealed secret blocks.
- Players: secret blocks NOT in revealed[] are hidden entirely.
- GM: sees all blocks; secret ones show ENCRYPTED/DECRYPTED + a [reveal]/[re-lock]
  toggle. Toggling writes the block id in/out of revealed[] (via the relay) and
  live-updates for everyone.
- Datapad journals must be FLAG-STORED (the reveal writes to the flag).

## Setup / test
1. Directory: journal w/ screen-datapads.json, Collection BLANK, id "datapads".
   Add a main-hub link to screen "datapads".
2. Datapad: journal w/ datapad-cerberus-ops.json, Collection "datapads",
   id "cerberus-ops", FLAG-STORED, live.
3. As GM: open the datapad. Secret blocks show ENCRYPTED + [reveal], content
   dimmed. Click [reveal] -> block turns DECRYPTED (green), [re-lock] available.
4. As a player: only revealed blocks appear; locked ones are absent. Reveal one
   as GM -> it appears live on the player's screen.

## Notes
- Whole-block secrecy (not per-cell), matching where your journal datapads
  landed. A sensitive table/message = mark the whole block secret.
- New block types later = add a branch in datapad.hbs + (if needed) prep. Purely
  additive.
