/* =============================================================
   TERMINAL — data layer
   -------------------------------------------------------------
   Everything the terminal shows is a RECORD:

     { doc, recordId, collection, enabled, name }

   `doc` is the Foundry document that backs it. Today that's a
   JournalEntry carrying:

     flags.vtt-terminal.enabled    : boolean — is this record LIVE?
     flags.vtt-terminal.id         : string  — its address (screen id,
                                               or member id in a set)
     flags.vtt-terminal.collection : string  — optional set name

   and a JSON payload (flags.vtt-terminal.json, or a code block in the
   first page body) carrying the content plus a "render" field naming
   its layout.

   The rest of the module only talks to records through this file, so
   the backing document can change (journals -> pages, see
   docs/STORAGE-MIGRATION-PLAN.md) without touching the renderers.

   INDEX: records are found through an in-memory index built on first
   use and thrown away whenever a journal or page is created, updated
   or deleted. That replaces scanning game.journal on every lookup.
   Parsed payloads are cached per record the same way; callers get a
   deep clone, so mutating a payload before writing it back can't
   corrupt the cache.
   ============================================================= */

const MODULE_ID = "vtt-terminal";

/* ---- Index ---- */

let index = null;

function invalidateIndex() { index = null; }

for (const hook of [
  "createJournalEntry", "updateJournalEntry", "deleteJournalEntry",
  "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"
]) Hooks.on(hook, invalidateIndex);
Hooks.once("ready", invalidateIndex);

function makeRecord(doc) {
  return {
    doc,
    recordId: doc.getFlag(MODULE_ID, "id"),
    collection: doc.getFlag(MODULE_ID, "collection") || null,
    enabled: doc.getFlag(MODULE_ID, "enabled") === true,
    name: doc.name,
    _parsed: undefined
  };
}

/* Lists keep game.journal order, so "first match wins" lookups resolve
   exactly as the old game.journal.find() scans did. */
function getIndex() {
  if (index) return index;
  const built = { all: [], byId: new Map(), byCollection: new Map() };
  for (const doc of game.journal ?? []) {
    if (!doc.getFlag(MODULE_ID, "id")) continue;
    const r = makeRecord(doc);
    built.all.push(r);
    push(built.byId, r.recordId, r);
    if (r.collection) push(built.byCollection, r.collection, r);
  }
  // Don't cache an index built before the world's journals exist.
  if (game.journal) index = built;
  return built;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const live = (includeDisabled) => (r) => includeDisabled || r.enabled;

/* ---- Lookups ---- */

/* All records that are addressable. By default only ENABLED ones (the
   live terminal); pass includeDisabled for GM tooling. */
export function findScreenRecords({ includeDisabled = false } = {}) {
  return getIndex().all.filter(live(includeDisabled));
}

/* Resolve a screen by id. Matches any record with that id, whatever
   its collection — some directory screens also carry a collection
   flag, and they must still resolve as screens. */
export function findScreenRecord(id, { includeDisabled = false } = {}) {
  return (getIndex().byId.get(id) ?? []).find(live(includeDisabled));
}

/* All records in a collection. */
export function findMemberRecords(collection, { includeDisabled = false } = {}) {
  return (getIndex().byCollection.get(collection) ?? []).filter(live(includeDisabled));
}

/* One record in a collection by member id. */
export function findMemberRecord(collection, memberId, { includeDisabled = false } = {}) {
  return (getIndex().byCollection.get(collection) ?? [])
    .find(r => r.recordId === memberId && live(includeDisabled)(r));
}

/* Exact (collection, id) match, enabled or not, with a blank collection
   meaning "standalone screen". The importer's upsert key. */
export function findRecordExact(collection, id) {
  const coll = collection || null;
  return getIndex().all.find(r => r.collection === coll && r.recordId === id);
}

/* Every collection name in use (importer datalist hints). */
export function listCollections() {
  return [...getIndex().byCollection.keys()].sort();
}

/* ---- Payloads ---- */

/* Extract raw JSON text from a document.
   Preference order:
     1. flags.vtt-terminal.json — structured flag storage
     2. first page body — JSON authored inside a code block */
function getPayloadText(doc) {
  const flagJson = doc.getFlag(MODULE_ID, "json");
  if (flagJson) {
    return typeof flagJson === "string" ? flagJson : JSON.stringify(flagJson);
  }
  const page = doc.pages?.contents?.[0];
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

function parseDoc(doc) {
  const raw = getPayloadText(doc);
  if (!raw) return { ok: false, data: null, error: "No payload found." };
  try {
    return { ok: true, data: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, data: null, error: `JSON parse error: ${err.message}` };
  }
}

/* Parse a record's (or a bare document's) payload.
   Returns { ok, data, error }; data is the caller's own copy. */
export function getPayload(target) {
  if (!target?.doc) return parseDoc(target);   // bare document (sheet hooks)
  if (target._parsed === undefined) target._parsed = parseDoc(target.doc);
  const p = target._parsed;
  return p.ok ? { ...p, data: foundry.utils.deepClone(p.data) } : p;
}

/* Update fragment that REPLACES flags.<module>.json wholesale.
   A plain setFlag / update MERGES objects, so a key deleted from the
   payload (a cleared datapad field, a field dropped from a re-import)
   would survive in the stored flag. Forced replacement writes exactly
   the object given.
     v14+: ForcedReplacement operator ("==" keys are deprecated there)
     v13 : the "==key" prefix */
export function payloadUpdate(data) {
  const Replace = foundry.data?.operators?.ForcedReplacement;
  return Replace
    ? { [`flags.${MODULE_ID}.json`]: Replace.create(data) }
    : { [`flags.${MODULE_ID}.==json`]: data };
}

/* Write a record's payload, replacing (not merging) it. Accepts a
   record or a bare document. */
export function savePayload(target, data) {
  return (target.doc ?? target).update(payloadUpdate(data));
}

/* ---- Creating / changing records ---- */

/* Create a record. folder: a Folder id, null for the sidebar root, or
   omitted to file it alongside existing records of the same collection.
   note: optional HTML for a short page explaining where the content
   lives, so opening the journal directly doesn't look empty.
   Returns the new record, or null if creation failed. */
export async function createRecord({ collection = null, id, enabled = true, name, payload, folder, note } = {}) {
  if (folder === undefined) {
    const sibling = collection
      ? findMemberRecords(collection, { includeDisabled: true }).find(r => r.doc.folder)
      : null;
    folder = sibling?.doc.folder?.id ?? null;
  }
  const flags = { enabled, id, json: payload };
  if (collection) flags.collection = collection;

  const doc = await JournalEntry.create({
    name: name || id,
    ...(folder ? { folder } : {}),
    ...(note ? { pages: [{ name: "About", type: "text", text: { content: note } }] } : {}),
    flags: { [MODULE_ID]: flags }
  });
  return doc ? makeRecord(doc) : null;
}

/* Overwrite a record's enabled flag, collection and payload in one
   update. A blank collection makes it a standalone screen. */
export function updateRecord(record, { enabled, collection = null, payload }) {
  const update = {
    [`flags.${MODULE_ID}.enabled`]: enabled,
    ...payloadUpdate(payload)
  };
  if (collection) update[`flags.${MODULE_ID}.collection`] = collection;
  else if (record.collection) update[`flags.${MODULE_ID}.-=collection`] = null;
  return record.doc.update(update);
}

/* Rename the record's backing document (keeps the sidebar in step with
   in-terminal titles). No-op if unchanged. */
export async function renameRecord(record, name) {
  if (name && record.doc.name !== name) await record.doc.update({ name });
}

/* ---- Loading ---- */

/* Load a screen by id. Returns { ok, data, error }. data includes
   whatever the author put in the JSON, including the "render" field. */
export function loadScreen(id, opts = {}) {
  const record = findScreenRecord(id, opts);
  if (!record) {
    return { ok: false, data: null, error: `Screen "${id}" not found or disabled.` };
  }
  return getPayload(record);
}

/* Load + parse every member of a collection. Returns an array of
   { id, data } for members that parsed OK (bad ones are skipped but
   logged), so a single broken member can't break the whole roster. */
export function loadCollection(collection, opts = {}) {
  const out = [];
  for (const r of findMemberRecords(collection, opts)) {
    const parsed = getPayload(r);
    if (parsed.ok) {
      out.push({ id: r.recordId, data: parsed.data });
    } else {
      console.warn(`terminal | collection "${collection}" member "${r.recordId}" failed to parse: ${parsed.error}`);
    }
  }
  return out;
}

/* Load a single collection member's full payload by collection + id. */
export function loadMember(collection, memberId, opts = {}) {
  const record = findMemberRecord(collection, memberId, opts);
  if (!record) {
    return { ok: false, data: null, error: `${collection} member "${memberId}" not found or disabled.` };
  }
  return getPayload(record);
}
