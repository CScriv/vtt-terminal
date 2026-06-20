/* =============================================================
   TERMINAL — in-game time
   -------------------------------------------------------------
   Returns an in-fiction timestamp string for stamping comments
   (and later, inbox messages). Uses the Seasons & Stars calendar
   module when present; falls back to real-world time otherwise so
   the feature never breaks if the module is missing/disabled.

   Seasons & Stars API:
     game.seasonsStars.api.getCurrentDate() -> a date object

   The exact return shape can vary by version, so we probe for the
   most likely forms in order:
     1. a .toFormat()/.format()/.toString() that yields a display string
     2. component fields (year/month/day/hour/minute) we assemble
   If none are usable, we fall back to a real-world short timestamp.
   ============================================================= */

const MODULE_ID = "vtt-terminal";

/* Real-world fallback: "Mar 3, 02:45" style. */
function wallClock() {
  return new Date().toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

/* Format a Seasons & Stars date object as "DD MMM — HHMM".
   Confirmed shape (S&S gregorian):
     { year, month (1-based), day,
       time: { hour, minute, second },
       calendar: { months: [ { name, abbreviation, ... } ] } }
   Month is 1-based; the abbreviation lives at calendar.months[month-1].
   We build the string from components directly (NOT the object's own
   .format(), which yields a verbose weekday-and-full-name string). */
function formatSSDate(date) {
  if (!date) return null;

  const day = date.day;
  const monthIdx = (date.month ?? 0) - 1; // 1-based -> 0-based
  const months = date.calendar?.months ?? [];
  const monthAbbr = months[monthIdx]?.abbreviation
    ?? months[monthIdx]?.name
    ?? (date.month != null ? String(date.month) : null);

  const hour = date.time?.hour;
  const minute = date.time?.minute;

  if (day == null || monthAbbr == null) return null;

  let s = `${day} ${monthAbbr}`;
  if (hour != null && minute != null) {
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    s += `: ${hh}${mm}`;
  }
  return s;
}

/* Public: get an in-game timestamp string, or wall-clock fallback. */
export function terminalTimestamp() {
  try {
    const ss = game.seasonsStars?.api;
    if (ss?.getCurrentDate) {
      const date = ss.getCurrentDate();
      const formatted = formatSSDate(date);
      if (formatted) return formatted;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Seasons & Stars time unavailable, using wall clock:`, err);
  }
  return wallClock();
}

/* Whether the in-game calendar is available (for diagnostics/UI). */
export function hasInGameCalendar() {
  return !!game.seasonsStars?.api?.getCurrentDate;
}

/* Diagnostic: log the raw Seasons & Stars date object + what we'd
   format it to. Call from console:
     game.modules.get("vtt-terminal").api.debugTime?.()
   Use this to confirm/adjust the format to your calendar's shape. */
export function debugTime() {
  const ss = game.seasonsStars?.api;
  if (!ss?.getCurrentDate) {
    console.log("terminal | Seasons & Stars not available; would use:", wallClock());
    return;
  }
  const raw = ss.getCurrentDate();
  console.log("terminal | S&S getCurrentDate() raw object:", raw);
  console.log("terminal | formatted as:", formatSSDate(raw) ?? `(no match -> wall clock: ${wallClock()})`);
  return raw;
}
