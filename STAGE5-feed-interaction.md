# Terminal — Stage 5 (part 3): feed likes + comments

Players (and the GM as any NPC) can like and comment on feed posts. Built on the
same socket relay as status changes — two new performWrite cases: toggleLike,
addComment.

## Likes
- Click the ▲ count on a post.
- Player: toggles THEIR character name in the post's likes array.
- GM: opens a crew picker (populated from the crew collection) -> toggles the
  chosen NPC's name. Pick the same member again to un-like (toggle off).
- The likes array is the single source of truth; de-dup + un-like are inherent.
- Display unchanged: first N names + "and X others".

## Comments
- Click "↩ Reply" on a post.
- Player: a comment box; authored as their character name (NO authorId link yet
  — see binding note below).
- GM: crew-member dropdown + comment box; authored as the chosen NPC with a
  correct authorId, so the comment's author name links to that dossier.
- Comments are permanent (append-only) for now.
- Author name + id are resolved at write time from the crew collection (GM
  path), so NPC comment links are always correct.

## Known gap: player -> dossier binding
There is currently NO binding between a Foundry user and a crew dossier, so a
player's comment/like uses their character name as plain text (no dossier link).
NPC (GM) attributions ARE link-correct. When user->dossier binding is added
later, players' authorId flows in and their names become links too — no change
to the comment/like data shape (authorId is already optional). This binding is
also what the planned inbox needs to route messages to a player's character.

## Schema (already present from the read-only feed)
post.likes: ["Name", ...]                       // toggled by likes
post.replies: [ { author, authorId?, time, body } ]  // appended by comments

## Inbox foreshadowing
The crew-backed author picker and the addComment write shape are deliberately
inbox-ready: NPC senders pick from the same crew list, and a message is the same
{author, authorId, time, body} shape as a comment.

## Requirements (same as status changes)
- Feed must be FLAG-STORED (writes go to flags.terminal.json).
- A GM must be connected for player likes/comments (GM client performs writes).
- Manifest has "socket": true (already set); world restart needed only when first
  adding that flag.

## Test
1. Feed flag-stored + live.
2. Player: ▲ a post -> their name appears in likers, count increments; ▲ again
   -> removed. Reply -> comment appears under the post as their character name.
3. GM: ▲ -> crew picker -> pick Voss -> she's added (pick again -> removed).
   Reply -> pick a crew member + write -> comment appears, author name links to
   that dossier.
