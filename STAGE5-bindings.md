# Terminal — player -> dossier bindings

Maps each player (Foundry user) to the crew member they play, so their feed
comments and likes are authored as that character WITH a dossier link (authorId).
Also the foundation for routing inbox messages to a player's character.

## Storage
A world setting terminal.bindings: { "<userId>": "<crewMemberId>" }. Keyed by
stable Foundry user id (survives renames). Not shown in the settings panel; the
binding UI manages it.

## Binding UI (GM only)
Game Settings -> Configure Settings -> Module Settings -> Terminal ->
"Configure Player Bindings". One row per non-GM user with a crew-member dropdown
(populated from the crew collection). Pick who each player plays, Save.

## Effect
- Player comments/likes now resolve via resolveSelfAuthor():
  - Bound -> authored as the crew member's name + authorId (links to dossier).
  - Unbound -> falls back to character/user name, no link (as before).
- GM NPC attributions (crew picker) unchanged — already link-correct.

## Notes
- GMs don't need a binding (they author as NPCs via the crew picker).
- Keyed by user id, so renaming a user or their character doesn't break the
  binding. The UI shows current user names so you never handle ids directly.
- Trust model: the player client asserts its own author identity in the write
  request. Fine for this open-interaction feature.

## Inbox foreshadowing
Routing a message TO a player's character = reverse lookup in the same bindings
map (find the userId bound to a member id). The map serves both directions.

## Files
- scripts/bindings.mjs: setting + binding UI + resolveSelfAuthor()/boundMemberId().
- templates/bindings.hbs: the per-user dropdown table.
