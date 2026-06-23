# Crew Feed (`render: "feed"`)

A social-media-style feed of posts from crew (NPCs and players). One journal
holds the entire feed. Posts are lightweight and numerous and are never
individually navigated, so they live in a single `posts` array on the screen —
**not** a collection. Players and the GM can post, like, and reply; all three
are live, GM-authorized writes that re-render every open terminal.

> Supersedes the old `STAGE4-feed.md`. Going forward, screens are documented
> one file per screen (this file), not by stage.

---

## Schema

The feed screen's journal payload (`flags.vtt-terminal.json`):

```json
{
  "render": "feed",
  "title": "...",
  "tag": "SASO",
  "prompt": "...",
  "posts": [
    {
      "id": "post-003",
      "author": "Johanna Byas",
      "authorId": "byas",
      "role": "Ship Yeoman",
      "wt": 5184000,
      "pinned": true,
      "official": true,
      "edited": false,
      "body": "...",
      "reactions": { "byas": "up", "markov": "up", "ennidos-j": "down" },
      "replies": [
        { "id": "reply-...", "author": "...", "authorId": "...", "wt": 5185500, "body": "..." }
      ]
    }
  ]
}
```

### Post fields

| Field      | Required | Meaning |
|------------|----------|---------|
| `id`       | yes      | Stable id. Seeded posts use `post-001` etc.; written posts use `post-<8 hex>`. Keys all interaction writes. |
| `author`   | yes      | Display name shown in the post header. |
| `authorId` | no       | Crew member id. When present, the author name links to `crew/<authorId>`. Omit for a free/system author (no link). |
| `role`     | no       | Shown next to the author (e.g. "Ship Yeoman"). |
| `wt`       | yes\*    | **Sortable in-world timestamp** = Foundry `game.time.worldTime` (seconds) at post time. The source of truth for sorting and archiving. The display string is formatted from this at render time, never stored. (\*Required on written posts; a post without `wt` sorts oldest and never archives.) |
| `pinned`   | no       | `true` → floats to the top and is exempt from archiving. |
| `official` | no       | `true` → blue "Notice" styling. Gated by `feedPinAuthority`. |
| `edited`   | no       | `true` → quiet "(edited)" marker. Set automatically by an edit write. |
| `body`     | yes      | Post text. |
| `reactions`| no       | Map keyed by reactor **crew member id** → `"up"` (like) or `"down"` (dislike). One entry per member = like XOR dislike (see Reactions). Keys must be real crew ids; the tooltip resolves id → display name at render. |
| `replies`  | no       | Array of reply objects: `{ id, author, authorId?, wt, edited?, body }`. Written replies carry a stable `id` (edit/delete target) and a `wt`. |

> **No legacy `time` field on new data.** Earlier builds stored a pre-formatted
> `time` string; the feed now stores numeric `wt` and formats on render. `#prepFeed`
> still falls back to a `time` string if a post somehow lacks `wt`, but fresh
> sample/live data should use `wt`.

Order: posts are sorted at render (pinned first, then newest-first by `wt`) —
you don't need to seed them in display order, though doing so does no harm.

---

## Reactions (like / dislike)

- **Single source of truth:** the `reactions` map, keyed by reactor **crew
  member id** with value `"up"` (like) or `"down"` (dislike). One entry per
  member, so a member can like *or* dislike but never both — the mutual
  exclusion is structural. NPC reactions are seeded here at authoring time.
- **Why id-keyed:** ids are stable across nickname/name changes. A name-keyed
  map would orphan reactions when a crew member is renamed (and could collide if
  two members shared a display name). The display name is resolved from the id
  at render, so renaming a crew member updates their reaction tooltip everywhere
  with no data migration.
- **Why a map, not two arrays:** with `{ id: "up"|"down" }`, up/down counts are
  filters of the map, toggling is a single key write, and a desync (someone in
  both lists) is impossible.
- **Display:** two footer counters — `▲ <up>` and `▼ <down>` — no inline name
  line. The reactor names live in a **hover tooltip** on each counter;
  `#reactionData` resolves each id → **nickname, else full name, else the raw
  id** (a fallback that only shows if an id has no matching crew member), then
  joins them, truncated to `REACTION_NAMES_SHOWN` = 12 with "+ N more". The
  viewer's own active reaction is highlighted (`react-mine`). Two short counters
  regardless of reactor count is what makes dislikes viable without clutter.
- **Identity:** player reacts as their `boundMemberId()`; the GM is prompted to
  pick which crew member is reacting (the picker already returns the member id).
  Every reaction therefore has a real crew id — the reaction picker is crew-only
  (no custom/free author), so there's no id-less reaction to handle.
- **Legacy:** a post still carrying an old `likes` name-array is read as
  all-"up", and the first `react` write migrates it into a `reactions` map. Any
  pre-id name-keyed entries (from an interim build) are preserved and render via
  the id→name resolver's fallthrough; they convert to id-keyed naturally as
  members re-react.

---

## Interaction (write layer)

All writes go through `requestWrite(...)` in `sockets.mjs`, which routes to the
GM client to perform the actual journal update (players can't write directly).
Each write sets `flags.vtt-terminal.json`, and the `updateJournalEntry` hook
re-renders open terminals, so a player's action appears on everyone's feed
without a manual refresh.

Eight actions are wired. The destructive/owner ones (Edit / Pin / Delete) live
in a **"···" owner menu** in each post/reply header rather than as separate
footer buttons (keeps the footer clean and scales to future actions). React and
Reply remain direct footer controls.

### `react` — like / dislike a post
- Trigger: the `▲` / `▼` counters in the footer (`data-action="react"`,
  `data-dir="up"|"down"`).
- Player reacts as their bound member id; GM is prompted to pick which crew
  member is reacting (NPC reactions supported, both directions). The write keys
  the reaction by member id.
- **Toggle semantics:** clicking the direction you already hold clears your
  reaction; clicking the opposite flips it; first click sets it. Implemented as
  a single key write on `post.reactions`.
- Dislikes are allowed everywhere (including NPC announcements) — a deliberate
  tone choice; gate in the handler if that ever needs to change.

### `addComment` — reply to a post
- Trigger: the "↩ Reply" control (`data-action="addComment"`). Opens the
  **Compose Reply** window (`ComposeReplyApp`).
- Author mechanics match posts: player replies as their bound crew member
  (nickname-aware display + `authorId` link); GM picks from a crew dropdown or
  types a "— custom —" author (no link).
- Handler appends `{ id, author, authorId?, wt, body }` to `post.replies`.
- Anti-spoof: a non-GM may only reply as their bound member (re-checked GM-side).

### `addPost` — new post
- Trigger: the **`[ POST TO FEED ]`** link at the top of the feed
  (`data-action="composePost"`). Opens the **Compose Post** window.
- Handler prepends a new post with a stable id, `wt`, and empty
  `likes`/`replies`. `official` (Notice) is honored only if the author passes
  `feedPinAuthority`.

### `editPost` / `editComment` — edit body (owner menu)
- Trigger: **Edit** in the "···" menu (`data-action="editPost"` /
  `"editComment"`). Opens the Compose Post / Reply window in **edit mode**:
  author controls hidden, body pre-filled.
- **Body only.** The write changes `body` and sets `edited: true`; `author`,
  `authorId`, `wt`, `official`, `pinned` are never touched. The "(edited)"
  marker is what keeps post-hoc edits honest on a shared feed.
- **Visibility:** GM on everything; player on their own items (`canEdit`).
- Reply edit targets by stable `id`, index fallback (same as delete).

### `togglePin` — pin / unpin a post (owner menu)
- Trigger: **Pin** / **Unpin** in the "···" menu (`data-action="togglePin"`).
- Sets/clears `post.pinned`. Pinned posts float to the top and never archive.
- **Visibility & permission:** governed by the `feedPinAuthority` setting
  (default GM-only), via the `canPin` flag and a GM-side re-check.

### `deletePost` / `deleteComment` — remove (owner menu)
- Trigger: **Delete** in the "···" menu (`data-action="deletePost"` /
  `"deleteComment"`).
- **Visibility:** GM on everything; player on their own items.
- `deletePost` filters the post from `data.posts` by `id`; `deleteComment`
  splices the reply (by `id`, index fallback). Both re-check ownership GM-side.

> **Trust model:** the `canEdit` / `canDelete` / `canPin` flags in `#prepFeed`
> decide whether a control *renders*; every socket handler independently
> re-verifies permission/ownership before mutating. The client gate is
> convenience only — a crafted socket message is rejected GM-side.

---

## Timestamps, sorting & archive

The feed stores a **sortable in-world timestamp** and formats it for display at
render time — the change that makes sorting and "last N days" possible.

- **Stored value:** `wt` = Foundry's native `game.time.worldTime` (seconds),
  captured at write time via `terminalWorldTime()`. This is purely in-world
  (advanced only by the GM through Seasons & Stars) — **never** wall-clock.
- **Display:** `#prepFeed` formats each `wt` via
  `game.seasonsStars.api.worldTimeToDate(wt)` → the "DD MMM: HHMM" string. If
  S&S is unavailable the string is empty rather than wrong.
- **Sort:** pinned posts first, then newest-first by `wt`.
- **Archive:** posts older than `feedArchiveDays` in-world days move into a
  collapsible **Archive** `<details>` below the recent list. Pinned posts are
  never archived. Per-day length comes from the active calendar via
  `secondsPerDay()` (handles non-24h calendars).
- **Fail-safe:** if the world clock reads 0 (calendar not initialized) or sits
  before the newest post, archiving is skipped entirely so nothing is hidden by
  a misconfigured clock. Archiving engages once the clock is sane and ahead of
  the content.

### Settings (Foundry → Configure Settings → Module Settings)

| Setting | Default | Effect |
|---------|---------|--------|
| `feedArchiveDays` | `7` | Posts older than this many in-world days are archived. `0` disables archiving (all posts shown). |
| `feedPinAuthority` | `gm` | Who may pin posts / flag Notices: `gm` (GM only), `authored` (GM + a player on their own posts), `all` (GM + all players). |

> A future in-terminal configuration *screen* may surface these; for now they
> live in Foundry's standard module settings.

---

## Compose Post / Reply windows

`scripts/compose-post.mjs` + `templates/compose-post.hbs` (new post) and
`scripts/compose-reply.mjs` + `templates/compose-reply.hbs` (reply) are
standalone ApplicationV2 windows, both modeled on the inbox's Compose Message
(`ComposeMessageApp`) and sharing the same conventions (see
`docs/TROUBLESHOOTING-applicationv2-windows.md`):

- `tag: "div"` root so the window floats as a popout.
- Theme class on the **inner** `.compose-form` wrapper, never the app root
  (root theming breaks window positioning).
- Posts via a `data-action="post"` button (not native form submit); Ctrl/Cmd+
  Enter also posts.
- Reuses the `.terminal-compose` layout classes from `compose.css` (window
  layout, control widths, send button), plus a few post-specific rules.

The **reply** window (`ComposeReplyApp`) is the post window minus the Notice
checkbox, scoped to a single post (`postId`). Same author mechanics below.

### Author mechanics (same model as mail compose)

- **Player:** locked to their bound crew member. `author` / `authorId` / `role`
  are taken from that member, so the post links to their dossier. A player with
  no binding can't open the window (guarded in `#onComposePost` and re-guarded
  in `#onPost`).
- **GM:** a dropdown of all crew (each shown as "Name — Role"). Selecting a
  member fills `author` / `authorId` / `role` from them. A trailing
  **"— custom —"** option reveals a free-text field for a system/announcement
  author (e.g. `SHIP SYSTEM`); custom authors get **no** `authorId`, so the name
  doesn't link to a dossier.

### Notice flag

A checkbox in the compose window sets `official: true` on the post, driving the
feed's blue "Notice" styling. Players may flag their own posts as notices. To
restrict notices to GMs, gate it in `ComposePostApp.#onPost` (drop `official`
when `!game.user.isGM`) — there's a comment marking the spot.

### Anti-spoof

`addPost` enforces the same protection as `sendMessage`: a non-GM may only post
when the post's `authorId` matches their bound member id. A crafted socket
message claiming someone else's identity is rejected GM-side, so players can't
post as another character.

---

## Files

| File | Role |
|------|------|
| `templates/render/feed.hbs` | Feed render: `[ POST TO FEED ]` trigger, recent list, Archive `<details>`. Each post via the `terminalFeedPost` partial. |
| `templates/partials/feed-post.hbs` | One post block (header + owner "···" menu, body, footer, replies). Reused for recent + archive. |
| `scripts/compose-post.mjs` | `ComposePostApp` — new post **and edit mode** (body-only). |
| `templates/compose-post.hbs` | Compose Post window (author/notice hidden in edit mode). |
| `scripts/compose-reply.mjs` | `ComposeReplyApp` — reply **and edit mode**. |
| `templates/compose-reply.hbs` | Compose Reply window. |
| `scripts/gametime.mjs` | `terminalWorldTime()` (sortable `wt`), `formatWorldTime()` (render-time display), `secondsPerDay()` (calendar-aware archive math). |
| `scripts/bindings.mjs` | `canPinOrNotice()` permission helper (reads `feedPinAuthority`). |
| `scripts/terminal.mjs` | `#prepFeed` (format/sort/archive + `canEdit`/`canDelete`/`canPin`/`hasMenu`); handlers `#onComposePost`, `#onAddComment`, `#onReact`, `#onEditPost`, `#onEditComment`, `#onTogglePin`, `#onDeletePost`, `#onDeleteComment`, `#onTogglePostMenu`, `#onToggleReplyMenu`; `_onRender`/`_onClose` for outside-click menu dismissal; `feedArchiveDays` + `feedPinAuthority` settings; `terminalFeedPost` partial registration. |
| `scripts/sockets.mjs` | Write handlers `addPost`, `addComment`, `react`, `editPost`, `editComment`, `togglePin`, `deletePost`, `deleteComment` + dispatch. |
| `styles/compose.css` | Compose window styling (shared `.terminal-compose`). |
| `styles/terminal.css` | Feed styling + reaction counters/tooltip (`.react`, `.react-tip`, `.react-mine`), owner menu (`.post-menu`/`.reply-menu`), `.post-pinned`/`.post-pin-tag`, `.post-edited`, `.feed-archive`. |

---

## Setup / test

1. A journal with the feed JSON in a code block. Terminal Data → Collection
   **BLANK**, id `feed`, **Live**. Your Intranet hub should link to screen
   `feed`. The sample `screen-feed.json` includes a pinned post, a Notice, and
   an intentionally-old post to exercise the Archive.
2. **Calendar:** make sure Seasons & Stars is active and the world clock is set
   to at/after the newest post (the sample's `_note` explains the `wt` values).
   Without a sane clock ahead of the content, archiving is skipped (fail-safe).
3. Open the feed. Verify: the pinned post sits on top with its accent + tag;
   the Notice post shows blue styling; each post shows `▲`/`▾` counters and
   hovering a counter reveals the reactor names in a terminal-styled tooltip;
   author names link to dossiers; the old post appears under **Archive (n)**.
4. **Post as a player:** bind a user to a crew member, `[ POST TO FEED ]` →
   write → confirm it appears at the top, links to their dossier, shows on the
   GM's feed too.
5. **Post as GM:** try a crew-member author and a "— custom —" author; flag one
   as a Notice (GM passes `feedPinAuthority`).
6. **Owner menu:** confirm the "···" appears only where the viewer has rights.
   As GM it's on everything; as a player only on their own posts/replies (plus
   Pin if `feedPinAuthority` permits).
7. **Edit:** Edit a post and a reply; confirm only the body changes and an
   "(edited)" marker appears. Confirm author/time/pin/notice are untouched.
8. **Pin:** pin a post, confirm it floats to top and is exempt from archive;
   unpin and confirm it returns to date order. Test the `feedPinAuthority`
   setting's three modes.
9. **Delete:** delete a post and a reply; confirm they vanish for all viewers.
10. **React:** as a player, click `▲` then `▲` again (set, then clear); click
    `▲` then `▾` (flip — confirm the up count drops and down rises, never both).
    Confirm your active reaction is highlighted and the counts update for all
    viewers. As GM, react via the crew picker and confirm an NPC dislike lands.
10. **Archive:** set `feedArchiveDays` low (e.g. 1) and advance the in-world
    clock; confirm older posts move into Archive and pinned posts never do.
11. **Anti-spoof / trust:** confirm a player can only post/reply/edit/delete as
    their own character; the GM-side handlers reject mismatches.

> After changing CSS, do a hard reload (dev tools → Empty Cache and Hard Reload,
> or Ctrl/Cmd+Shift+R) — Foundry caches module stylesheets. See
> `docs/TROUBLESHOOTING-applicationv2-windows.md`, Problem 3.
