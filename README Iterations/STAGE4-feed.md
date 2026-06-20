# Terminal — Stage 4 (intranet): crew feed

Standalone screen, render "feed". One journal holds the whole posts array (posts
are lightweight, numerous, never individually navigated — so NOT a collection).

## Schema
{
  "render": "feed",
  "title": "...", "tag": "SASO", "prompt": "...",
  "posts": [
    {
      "id": "post-003",                 // stable id (for the future write layer)
      "author": "Johanna Byas",
      "authorId": "byas",                // optional -> name links to crew/byas
      "role": "Ship Yeoman",
      "time": "28 Oct — 0830",
      "official": true,                  // optional -> blue notice styling
      "body": "...",
      "likes": ["Voss", "Markov", "..."],// array of liker names
      "replies": [
        { "author": "...", "authorId": "...", "time": "...", "body": "..." }
      ]
    }
  ]
}

## Likes
- Single source of truth: the `likes` array. Count = likes.length (no separate
  count field). NPC likes are seeded here at authoring time.
- Display: first N names (N = LIKE_NAMES_SHOWN, default 3), then "and X other(s)"
  when likes.length > N. Examples:
    [Voss, Markov]                       -> "Voss and Markov"
    [Voss, Markov, Matthews]             -> "Voss, Markov and Matthews"
    [Voss, Markov, Matthews, Sorka, ...] -> "Voss, Markov, Matthews and 2 others"
- Like indicator uses the up-arrow (▲) + count, matching the terminal aesthetic.
- Replies have no likes (intentionally simple).

## Future write layer (not built yet)
Each post's stable `id` + the likes array are the hook: a player liking a post
unshifts their character name onto that post's `likes` array (array doubles as
the reactor-identity record, so un-liking / de-dup come free). Nothing else
changes. Building those fields in now means the interaction layer attaches
without reshaping data.

## Setup / test
1. Journal with screen-feed.json in a code block. Terminal Data -> Collection
   BLANK, id "feed", Live. (Your Intranet hub should link to screen "feed".)
2. Open -> navigate to the feed. Byas's post shows the blue Notice styling, a
   reply, and "Voss, Markov, Matthews and 2 others". Author names link to
   dossiers. Ennidos's post shows ▲ 0 and no like-line.
