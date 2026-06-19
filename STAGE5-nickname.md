# Terminal — dossier nickname field

Optional "nickname" on a crew dossier, used for COMPACT FEED references (likes +
comments) where a full name is too long or wrong (e.g. Krogan clan-first names).
Not displayed anywhere formal.

## Schema
Add to any crew member's JSON:
  "nickname": "Wrex"
Optional. If absent, the full "name" is used everywhere (purely additive).

## Where it applies
- Feed LIKES: the liker's nickname is stored/shown (e.g. "Wrex, Garrus and 3
  others") instead of the full name.
- Feed COMMENTS: the comment author line shows the nickname.
- Everywhere else (dossier header, roster, mission attributions, the GM crew
  PICKER) keeps the FULL name.

Rule of thumb: feed = nickname, records = full name.

## Behavior notes
- GM crew picker shows FULL names (findability); the resulting like/comment
  displays the NICKNAME.
- Player likes/comments use their bound member's nickname (via resolveSelfAuthor).
- authorId is unchanged — the comment author still LINKS to the dossier; only the
  displayed text becomes the nickname.
- Like/comment display strings are stored at write time, so changing a nickname
  later doesn't rewrite past feed entries (fine — they're social ephemera).

## Sample
sample-data/crew-domitus.json now has "nickname": "Domitus".
