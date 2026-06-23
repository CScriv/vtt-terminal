# Glyph & Symbol Conventions

A standing rule for all rendered output in the terminal (every `.hbs` template,
any string a script injects into the DOM, notification text).

## The rule: monochrome, not multicolor

The aesthetic is a system terminal on a military vessel. The line that matters
is **monochromatic vs. full-color**, not "emoji vs. not":

- **Allowed** — glyphs the font renders as flat, single-color text: arrows
  (`←↑→↓↩↪`), geometric shapes (`▲▾▸▿●○■□`), box-drawing (`─│┌┐└┘├┤`), and
  similar. These read as terminal UI. Use them within reason.
- **Not allowed** — glyphs the font renders as a little multicolor picture:
  pushpins, check marks, warning triangles in emoji presentation, flags, faces,
  objects. A full-color pictograph punches a hole straight through the terminal
  illusion. This is the hard line.

In-use examples that are fine: the `▲` like-triangle, the `▸`/`▾` archive
disclosure carets, the `▦`/`▾` datapad ENCRYPTED/DECRYPTED tags.

## The technical wrinkle: variation selectors

Some characters render **either** way depending on platform and an invisible
trailing codepoint:

- **U+FE0F** (VARIATION SELECTOR-16) forces the **emoji** (color) presentation.
- **U+FE0E** (VARIATION SELECTOR-15) forces the **text** (monochrome)
  presentation.

So a glyph that looks safe in your editor can render as color elsewhere if an
FE0F sneaks in (common when copy-pasting from the web or other apps). Rules:

1. Prefer characters whose **default** presentation is text/monochrome (the
   arrow, geometric, and box-drawing blocks almost all qualify).
2. **Never** append U+FE0F in rendered output.
3. If an ambiguous glyph (e.g. `⚠ ✂ ▶ ☀ ❤`) must be monochrome, append U+FE0E
   to pin it — but prefer a glyph that's monochrome by default instead.
4. Treat the full-color pictograph blocks as off-limits in rendered output:
   roughly **U+1F300–U+1FAFF**, plus the regional-indicator flag pairs
   (U+1F1E6–U+1F1FF).

## Code comments are exempt

Symbols inside `/* ... */` or `//` comments (e.g. the `⚠` version-sensitivity
markers in the script headers) are never rendered, so they don't affect the
aesthetic and don't need scrubbing. The rule is about **output**, not source.

## Prefer bracketed text labels for controls

Independent of the glyph question, terminal controls read best as bracketed
text matching the existing convention: `[ POST TO FEED ]`, `[ SEND ]`,
`[ PINNED ]`, `> REPLY`. Reach for these over a decorative symbol when labeling
an action; use glyphs for affordances where a symbol genuinely reads faster
(the `▲` like count, disclosure carets).

## Auditing

Don't blanket-grep for non-ASCII — that false-positives on every em-dash (`—`),
ellipsis (`…`), and arrow you legitimately use. Target the two things that
actually break the rule: the emoji variation selector, and the full-color
pictograph/flag blocks.

The variation selector is a 4-digit codepoint that greps cleanly:

```bash
# Emoji variation selector (forces color presentation) — expect ZERO hits.
grep -rnP '\x{FE0F}' templates/ scripts/
```

For the pictograph blocks, prefer a short Python scan — the 5-digit codepoints
(U+1F300+) trip up some PCRE-grep builds inside character classes. This also
reports the character name, so a hit is self-explanatory:

```bash
python3 - << 'PY'
import os, unicodedata
def bad(ch):
    o = ord(ch)
    return (0x1F300 <= o <= 0x1FAFF      # color pictographs
            or 0x1F1E6 <= o <= 0x1F1FF   # regional-indicator flags
            or o == 0xFE0F)              # emoji variation selector
for root,_,files in os.walk('.'):
    if '/.git' in root: continue
    for fn in files:
        if not fn.endswith(('.hbs','.mjs')): continue   # rendered output only
        p = os.path.join(root, fn)
        for i, line in enumerate(open(p, encoding='utf-8'), 1):
            hits = [c for c in line if bad(c)]
            if hits:
                names = ' '.join(f"{c!r}({unicodedata.name(c,'?')})" for c in dict.fromkeys(hits))
                print(f"{p}:{i}: {names}")
PY
```

Zero output = rendered output satisfies the rule. (Scans `.hbs` and `.mjs`,
since those are what reach the DOM. Comments in `.mjs` are exempt per above, so
a hit there is only a problem if it's in an output string, not a comment.)
