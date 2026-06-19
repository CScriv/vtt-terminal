# Terminal — in-game timestamps (Seasons & Stars)

Comments (and later inbox messages) are stamped with the IN-GAME date/time from
the Seasons & Stars calendar module, not real-world time. Falls back to
real-world time if S&S is absent, so nothing breaks without it.

## Files
- scripts/gametime.mjs: terminalTimestamp() returns an in-game time string via
  game.seasonsStars.api.getCurrentDate(), with a wall-clock fallback.
- manifest: S&S added as a "recommended" relationship (optional, not required).

## IMPORTANT: verify the format against your calendar
The exact shape of getCurrentDate()'s return wasn't certain at build time, so
gametime.mjs probes several likely shapes (a .format()/.toFormat() method, a
pre-formatted display field, or component fields it assembles). It will likely
produce a sensible string, but CONFIRM and adjust to taste:

  In the console with S&S active:
    game.modules.get("terminal").api.debugTime()

  This logs the raw S&S date object and what we'd format it to. If the format
  isn't what you want (or it fell through to wall clock), share the logged raw
  object and the formatSSDate() function in gametime.mjs can be tuned to it
  exactly — it's the single place that shapes the string.

## Notes
- Only NEW comments get in-game stamps (existing seeded post/reply times in your
  JSON are unchanged — those are authored strings).
- advanceDays / the seasons-stars:dateChanged hook aren't needed here; we only
  read the current time at write moment.
