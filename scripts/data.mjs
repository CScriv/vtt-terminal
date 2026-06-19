/* =============================================================
   TERMINAL — data layer
   -------------------------------------------------------------
   Screens are journals flagged as terminal data:

     flags.terminal.enabled : boolean  — is this screen LIVE?
     flags.terminal.id      : string   — the screen's address/name
                                          (navigation targets resolve
                                           against this)

   The JSON payload (page body code block, or flags.terminal.json)
   carries the content AND a "render" field naming its layout. The
   render type is read only AFTER the correct journal is loaded, so
   it never costs a full-journal scan — id lookups stay cheap.
   ============================================================= */

const MODULE_ID = "terminal";

/* All journals that are terminal screens. By default only ENABLED
   ones (the live terminal); pass includeDisabled for GM tooling. */
export function findScreens({ includeDisabled = false } = {}) {
  return game.journal.filter(j => {
    const id = j.getFlag(MODULE_ID, "id");
    if (!id) return false;
    if (!includeDisabled && j.getFlag(MODULE_ID, "enabled") !== true) return false;
    return true;
  });
}

/* Resolve a screen journal by its id flag. Honors the enabled check
   unless includeDisabled is set. */
export function findScreenJournal(id, { includeDisabled = false } = {}) {
  return game.journal.find(j => {
    if (j.getFlag(MODULE_ID, "id") !== id) return false;
    if (!includeDisabled && j.getFlag(MODULE_ID, "enabled") !== true) return false;
    return true;
  });
}

/* Extract raw JSON text from a journal.
   Preference order:
     1. flags.terminal.json  — structured flag storage (most robust)
     2. first page body — JSON authored inside a code block */
export function getPayloadText(journal) {
  const flagJson = journal.getFlag(MODULE_ID, "json");
  if (flagJson) {
    return typeof flagJson === "string" ? flagJson : JSON.stringify(flagJson);
  }
  const page = journal.pages?.contents?.[0];
  if (!page) return null;
  const html = page.text?.content ?? "";
  return stripToJson(html);
}

function stripToJson(html) {
  if (!html) return null;
  const codeMatch = html.match(/<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/i);
  let text = codeMatch ? codeMatch[1] : html;
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return text.trim();
}

/* Parse a journal's payload. Returns { ok, data, error }. */
export function getPayload(journal) {
  const raw = getPayloadText(journal);
  if (!raw) return { ok: false, data: null, error: "No payload found." };
  try {
    return { ok: true, data: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, data: null, error: `JSON parse error: ${err.message}` };
  }
}

/* Load a screen by id: resolve the journal, parse its payload.
   Returns { ok, data, error }. data includes whatever the author put
   in the JSON, including the "render" field. */
export function loadScreen(id, opts = {}) {
  const journal = findScreenJournal(id, opts);
  if (!journal) {
    return { ok: false, data: null, error: `Screen "${id}" not found or disabled.` };
  }
  return getPayload(journal);
}

/* =============================================================
   COLLECTIONS (Stage 4)
   -------------------------------------------------------------
   Some journals belong to a SET rather than being standalone
   screens. They carry an extra flag:

     flags.terminal.collection : string  (e.g. "crew")

   plus the usual flags.terminal.id (their member id within the set,
   e.g. "matthews") and flags.terminal.enabled.

   The roster/board screens DISCOVER their members by collection and
   generate themselves; individual member screens (dossiers) are
   rendered by resolving collection + member id.
   ============================================================= */

/* All enabled journals belonging to a collection. */
export function findCollectionMembers(collection, { includeDisabled = false } = {}) {
  return game.journal.filter(j => {
    if (j.getFlag(MODULE_ID, "collection") !== collection) return false;
    if (!j.getFlag(MODULE_ID, "id")) return false;
    if (!includeDisabled && j.getFlag(MODULE_ID, "enabled") !== true) return false;
    return true;
  });
}

/* Resolve a single collection member journal by collection + member id. */
export function findCollectionMember(collection, memberId, { includeDisabled = false } = {}) {
  return game.journal.find(j => {
    if (j.getFlag(MODULE_ID, "collection") !== collection) return false;
    if (j.getFlag(MODULE_ID, "id") !== memberId) return false;
    if (!includeDisabled && j.getFlag(MODULE_ID, "enabled") !== true) return false;
    return true;
  });
}

/* Load + parse every member of a collection. Returns an array of
   { id, data } for members that parsed OK (bad ones are skipped but
   logged), so a single broken member can't break the whole roster. */
export function loadCollection(collection, opts = {}) {
  const members = findCollectionMembers(collection, opts);
  const out = [];
  for (const j of members) {
    const id = j.getFlag(MODULE_ID, "id");
    const parsed = getPayload(j);
    if (parsed.ok) {
      out.push({ id, data: parsed.data });
    } else {
      console.warn(`terminal | collection "${collection}" member "${id}" failed to parse: ${parsed.error}`);
    }
  }
  return out;
}

/* Load a single collection member's full payload by collection + id. */
export function loadMember(collection, memberId, opts = {}) {
  const journal = findCollectionMember(collection, memberId, opts);
  if (!journal) {
    return { ok: false, data: null, error: `${collection} member "${memberId}" not found or disabled.` };
  }
  return getPayload(journal);
}
