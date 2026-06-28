/* =============================================================
   TERMINAL — bulk importer (GM authoring tool)
   -------------------------------------------------------------
   A collection member (crew dossier, mission, location, datapad) is
   just a JournalEntry carrying:

     flags.vtt-terminal.enabled    : boolean
     flags.vtt-terminal.id         : string   (member id within the set)
     flags.vtt-terminal.collection : string   (e.g. "crew")
     flags.vtt-terminal.json       : object   (the payload)

   Authoring these one at a time (create journal -> Terminal Data ->
   paste JSON -> set collection/id/enabled -> save) doesn't scale when
   you have a roster of crew to load. This tool turns ONE action into
   MANY journals:

     1. Paste a batch payload (array or {id: data} map) + a collection,
        OR
     2. Drag-and-drop one or more .json files onto the window.

   Each entry is UPSERTED by (collection + id): re-importing an id that
   already exists updates that journal instead of creating a duplicate.

   This is a GM tool — the GM owns the journals, so writes happen
   directly (no socket relay needed). Launched from the Journal
   directory footer and from a header control on collection screens.
   ============================================================= */

import { getPayload } from "./data.mjs";

const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/* -------------------------------------------------------------
   Parsing: turn a raw payload + a default collection into a flat
   list of { id, collection, data, enabled } import records.

   Accepted batch shapes (a single paste / a single file):

   A) ARRAY of members, each carrying its own id at top level:
        [
          { "id": "matthews", "render": "dossier", "name": "...", ... },
          { "id": "markov",   "render": "dossier", "name": "...", ... }
        ]
      The id can live at top level OR under a "_terminal" envelope. A
      per-entry collection or enabled flag goes in "_terminal" (never as a
      body field — a body-level "collection" is CONTENT, e.g. a screen
      naming the set it lists):
        { "_terminal": { "id": "matthews", "collection": "crew",
          "enabled": true }, "render": "dossier", ... }
      Without a per-entry collection, the form field / envelope default
      applies to the whole batch.

   B) MAP of id -> member data:
        {
          "matthews": { "render": "dossier", "name": "...", ... },
          "markov":   { "render": "dossier", "name": "...", ... }
        }

   C) ENVELOPE wrapping either of the above, so a file can name its own
      collection without a form field:
        { "collection": "crew", "members": [ ... | { ... } ] }

   D) A SINGLE member object (no id map, has a "render" field): treated
      as a one-item array; needs an id from "_terminal".id or the form.

   `parseBatch` is intentionally permissive so hand-authored exports,
   tool exports, and the module's own re-exports all round-trip.

   `opts.fallbackId` supplies an id for a SINGLE payload that carries none
   (used by file-drop to derive the id from the filename, so an untouched
   screen file like screen-inbox.json needs no edits to import).
   ------------------------------------------------------------- */
function parseBatch(raw, defaultCollection, { fallbackId = "", fallbackCollection = "", forceNoCollection = false } = {}) {
  const out = [];
  const errors = [];

  // Pull id/collection/enabled overrides off a member, supporting both a
  // top-level form and a "_terminal" envelope. Returns the cleaned data
  // (envelope + control keys stripped) plus the resolved controls.
  const splitControls = (member, fbId = fallbackId, fbCollection = fallbackCollection, force = forceNoCollection) => {
    const env = (member && typeof member._terminal === "object") ? member._terminal : {};
    const id = String(env.id ?? member.id ?? fbId ?? "").trim();

    // COLLECTION (the flag) precedence, highest to lowest:
    //   1. _terminal.collection  — explicit per-entry override (always wins)
    //   2. forceNoCollection     — the "screen-" filename sentinel: assert
    //                              "this is NOT a member", overriding the
    //                              form default below
    //   3. fbCollection          — filename prefix (per-file, e.g. "crew-")
    //   4. defaultCollection     — the form field / envelope default
    // The filename beats the form field because a single drop can mix
    // files from different collections; the form value is the catch-all
    // for files whose name doesn't encode one. Body-level "collection" is
    // NEVER read here — it's content (a screen naming the set it lists),
    // not a control, and is left untouched in the payload.
    const envCollection = String(env.collection ?? "").trim();
    let collection;
    if (envCollection) collection = envCollection;          // 1: explicit wins
    else if (force) collection = "";                        // 2: screen sentinel
    else collection = String(fbCollection ?? "").trim()     // 3: filename prefix
      || defaultCollection;                                 // 4: form default

    // enabled: explicit wins; default ON for an import (you're loading
    // content to use). Authors can ship "enabled": false to stage drafts.
    // Read only from the envelope so a body-level "enabled" (unlikely, but
    // possible as content) isn't hijacked as a control.
    const enabledRaw = env.enabled;
    const enabled = enabledRaw === undefined ? true : enabledRaw === true;

    // Strip control keys so they don't pollute the stored payload. Only
    // the _terminal envelope and a top-level "id" are controls; "id" is
    // stripped because the flag carries it and it isn't a render field.
    // "collection" and "enabled" at body level are CONTENT (or absent) and
    // are deliberately LEFT IN PLACE.
    const data = foundry.utils.deepClone(member);
    delete data._terminal;
    delete data.id;

    return { id, collection, enabled, data };
  };

  // Unwrap an envelope: { collection, members } -> set default + inner.
  let body = raw;
  if (raw && !Array.isArray(raw) && typeof raw === "object" && raw.members !== undefined) {
    if (typeof raw.collection === "string" && raw.collection.trim()) {
      defaultCollection = raw.collection.trim();
    }
    body = raw.members;
  }

  if (Array.isArray(body)) {
    // Shape A: array of members/screens, each carrying its own id.
    body.forEach((member, i) => {
      if (!member || typeof member !== "object") {
        errors.push(`Entry ${i + 1}: not an object.`);
        return;
      }
      // Array entries each carry their own id; the filename (a single
      // string) can't supply ids for many entries, so suppress both
      // filename fallbacks here. Per-entry collection comes from
      // _terminal.collection or the form/envelope default.
      const rec = splitControls(member, "", "", false);
      if (!rec.id) { errors.push(`Entry ${i + 1}: no id (set "id" or "_terminal".id).`); return; }
      // collection is OPTIONAL: blank = a standalone screen (e.g. inbox).
      out.push(rec);
    });
  } else if (body && typeof body === "object") {
    // Two single-object shapes share this branch:
    //   D) A lone SCREEN/MEMBER payload — it has a top-level "render"
    //      field (and/or a "_terminal" envelope). Import it as ONE entry.
    //   B) A MAP of id -> data — NO top-level "render"; every value is
    //      itself an object. Import each pair as an entry, the key as id.
    // The discriminator is the top-level "render" field: a real payload
    // always names its layout there; a map never does (render lives one
    // level down inside each member). This keeps a single screen whose
    // payload happens to contain nested objects (inbox: messages/threads)
    // from being mistaken for a member map.
    const isSinglePayload =
      typeof body.render === "string" ||
      (body._terminal && typeof body._terminal === "object");

    if (isSinglePayload) {
      // The one shape where the filename applies: a lone bare file like
      // crew-byas.json. Prefix -> collection, remainder -> id (both as
      // fallbacks; _terminal / form still override).
      const rec = splitControls(body, fallbackId, fallbackCollection);
      if (!rec.id) {
        errors.push(`Single entry has no id. Add "_terminal": { "id": "..." }, set an id, name the file (drop), or import as a map/array.`);
      } else {
        out.push(rec);   // collection optional (standalone screen if blank)
      }
    } else {
      // Map of id -> data.
      const entries = Object.entries(body);
      if (!entries.length) {
        errors.push("Empty object: nothing to import.");
      }
      for (const [key, member] of entries) {
        if (!member || typeof member !== "object") {
          errors.push(`"${key}": value is not an object (expected member data).`);
          continue;
        }
        // Map key is the id; suppress the filename collection fallback —
        // a file containing a MAP defines its own entries, so the prefix
        // of the containing filename shouldn't be forced onto them.
        const rec = splitControls(member, key, "", false);
        if (!rec.id) { errors.push(`"${key}": no id.`); continue; }
        out.push(rec);   // collection optional
      }
    }
  } else {
    errors.push("Payload is neither an array nor an object.");
  }

  return { records: out, errors };
}

/* -------------------------------------------------------------
   Upsert one record into a JournalEntry. Existing member (matched by
   collection + id) is updated in place; otherwise a new journal is
   created. Returns { action: "created"|"updated", name }.
   ------------------------------------------------------------- */
async function upsertRecord(rec, { folderId = null } = {}) {
  // A standalone screen has no collection. config.mjs stores that by
  // UNSETTING the flag (so getFlag returns undefined), not as "". Match
  // and write the same way: treat undefined/"" as the same "no collection".
  const recColl = rec.collection || null;   // "" -> null
  const sameColl = (j) => (j.getFlag(MODULE_ID, "collection") || null) === recColl;

  const existing = game.journal.find(j =>
    sameColl(j) && j.getFlag(MODULE_ID, "id") === rec.id
  );

  // A friendly journal name: the payload's name/title, else the id.
  const displayName = rec.data?.name ?? rec.data?.title ?? rec.id;

  // Build the flag object. Omit collection entirely when blank so the
  // stored shape matches a screen configured by hand via Terminal Data.
  const flagData = {
    enabled: rec.enabled,
    id: rec.id,
    json: rec.data
  };
  if (recColl) flagData.collection = recColl;

  if (existing) {
    const update = { [`flags.${MODULE_ID}`]: flagData };
    // If the existing journal HAD a collection and the new import drops
    // it, explicitly clear the stale flag (object-merge won't remove it).
    if (!recColl && existing.getFlag(MODULE_ID, "collection") != null) {
      update[`flags.${MODULE_ID}.-=collection`] = null;
    }
    await existing.update(update);
    return { action: "updated", name: existing.name };
  }

  await JournalEntry.create({
    name: displayName,
    ...(folderId ? { folder: folderId } : {}),
    flags: { [MODULE_ID]: flagData }
  });
  return { action: "created", name: displayName };
}

/* Run a whole batch of records, collecting a per-record result log.
   Sequential (not Promise.all) so the notification counts are accurate
   and a mid-batch failure doesn't leave the rest in an unknown state. */
async function runImport(records, opts = {}) {
  const results = { created: 0, updated: 0, failed: 0, log: [] };
  for (const rec of records) {
    try {
      const r = await upsertRecord(rec, opts);
      results[r.action] += 1;
      const tag = rec.collection ? `${rec.collection}/${rec.id}` : `${rec.id} (screen)`;
      results.log.push(`${r.action === "created" ? "+" : "~"} ${tag} (${r.name})`);
    } catch (err) {
      results.failed += 1;
      const tag = rec.collection ? `${rec.collection}/${rec.id}` : `${rec.id} (screen)`;
      results.log.push(`! ${tag} — ${err.message}`);
      console.error(`${MODULE_ID} | import failed for ${rec.collection}/${rec.id}`, err);
    }
  }
  return results;
}

/* =============================================================
   The importer Application
   ============================================================= */
class TerminalImport extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(options = {}) {
    super(options);
    // Optional: pre-fill the collection (e.g. launched from a crew roster).
    this.presetCollection = options.presetCollection ?? "";
  }

  static DEFAULT_OPTIONS = {
    id: "terminal-import",
    tag: "form",
    classes: ["terminal-import"],
    window: { title: "Terminal: Bulk Import", contentClasses: ["standard-form"] },
    position: { width: 620, height: "auto" },
    form: {
      handler: TerminalImport.#onSubmit,
      closeOnSubmit: false           // keep open so you can import several batches
    },
    actions: {
      formatJson: TerminalImport.#onFormatJson,
      clearJson: TerminalImport.#onClearJson
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/import.hbs` }
  };

  async _prepareContext() {
    // Offer existing collections as datalist hints so ids land in the
    // right set without guesswork.
    const collections = [...new Set(
      game.journal
        .map(j => j.getFlag(MODULE_ID, "collection"))
        .filter(c => typeof c === "string" && c)
    )].sort();
    return {
      presetCollection: this.presetCollection,
      collections
    };
  }

  /* Format / validate the textarea JSON. */
  static #onFormatJson() {
    const ta = this.element.querySelector("textarea[name='payload']");
    if (!ta) return;
    try {
      const obj = JSON.parse(ta.value);
      ta.value = JSON.stringify(obj, null, 2);
      ui.notifications.info("Terminal: JSON is valid.");
    } catch (err) {
      ui.notifications.error(`Terminal: invalid JSON — ${err.message}`);
    }
  }

  static #onClearJson() {
    const ta = this.element.querySelector("textarea[name='payload']");
    if (ta) ta.value = "";
    const list = this.element.querySelector(".terminal-import-results");
    if (list) list.innerHTML = "";
  }

  /* Wire drag-and-drop of .json files onto the drop zone. Multiple files
     are concatenated as separate batches (each parsed independently),
     so you can drop a whole folder of per-member exports at once. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const zone = this.element.querySelector(".terminal-dropzone");
    if (!zone) return;

    const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    ["dragenter", "dragover"].forEach(t =>
      zone.addEventListener(t, (ev) => { stop(ev); zone.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach(t =>
      zone.addEventListener(t, (ev) => { stop(ev); zone.classList.remove("dragover"); })
    );

    zone.addEventListener("drop", async (ev) => {
      const files = [...(ev.dataTransfer?.files ?? [])]
        .filter(f => f.name.toLowerCase().endsWith(".json") || f.type === "application/json");
      if (!files.length) {
        ui.notifications.warn("Terminal: drop one or more .json files.");
        return;
      }
      const collection = this.element.querySelector("input[name='collection']")?.value?.trim() ?? "";
      await this.#importFiles(files, collection);
    });
  }

  /* Read each dropped file, parse it as its own batch, run them all,
     then report the combined tally. The filename encodes routing for a
     lone bare file: "<prefix>-<id>.json" where the prefix is the
     collection, or "screen-<id>.json" for a standalone screen (no
     collection). So crew-byas.json -> {collection:"crew", id:"byas"} and
     screen-inbox.json -> {collection:"", id:"inbox"}. These are fallbacks:
     a _terminal envelope or the form field still overrides. Files that
     contain a map/array/envelope ignore the filename (those define their
     own entries). */
  async #importFiles(files, defaultCollection) {
    const allRecords = [];
    const allErrors = [];
    for (const file of files) {
      let text;
      try { text = await file.text(); }
      catch (err) { allErrors.push(`${file.name}: could not read — ${err.message}`); continue; }

      let raw;
      try { raw = JSON.parse(text); }
      catch (err) { allErrors.push(`${file.name}: invalid JSON — ${err.message}`); continue; }

      const { id: fallbackId, collection: fallbackCollection, forceNoCollection } =
        TerminalImport.#routeFromFilename(file.name);
      const { records, errors } = parseBatch(
        raw, defaultCollection, { fallbackId, fallbackCollection, forceNoCollection }
      );
      records.forEach(r => allRecords.push(r));
      errors.forEach(e => allErrors.push(`${file.name}: ${e}`));
    }
    await this.#finish(allRecords, allErrors);
  }

  /* Split a filename into { collection, id } on the FIRST hyphen:
       "crew-byas.json"          -> { collection: "crew",     id: "byas" }
       "missions-dark-horizon..." -> { collection: "missions", id: "dark-horizon" }
       "screen-inbox.json"       -> { collection: "",         id: "inbox" }   (sentinel)
       "inbox.json"              -> { collection: "",         id: "inbox" }   (no prefix)
     The id keeps any remaining hyphens. "screen" is reserved: it ASSERTS
     a standalone screen (forceNoCollection), so even a value typed in the
     form won't attach a collection. A name with no hyphen has no prefix,
     so the whole basename is the id and the collection defers to the form
     field (forceNoCollection stays false). */
  static #routeFromFilename(name) {
    const base = String(name ?? "").replace(/\.json$/i, "").trim();
    const dash = base.indexOf("-");
    if (dash < 1) {
      // No prefix (no hyphen, or leading hyphen): whole thing is the id,
      // collection deferred to the form field.
      return { collection: "", id: base.replace(/^-+/, ""), forceNoCollection: false };
    }
    const prefix = base.slice(0, dash);
    const rest = base.slice(dash + 1);
    const isScreen = prefix.toLowerCase() === "screen";
    return {
      collection: isScreen ? "" : prefix,
      id: rest,
      forceNoCollection: isScreen      // "screen-" means: never a member
    };
  }

  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const collection = (data.collection ?? "").trim();
    const text = (data.payload ?? "").trim();
    if (!text) {
      ui.notifications.warn("Terminal: paste a payload or drop a file.");
      return;
    }
    let raw;
    try { raw = JSON.parse(text); }
    catch (err) { ui.notifications.error(`Terminal: invalid JSON — ${err.message}`); return; }

    const { records, errors } = parseBatch(raw, collection);
    await this.#finish.call(this, records, errors);
  }

  /* Shared finish path for both paste and drop: confirm, run, report. */
  async #finish(records, errors) {
    if (!records.length) {
      const msg = errors.length ? errors.join("\n") : "Nothing to import.";
      ui.notifications.error("Terminal: import aborted.");
      this.#renderResults([], errors);
      console.warn(`${MODULE_ID} | import produced no records:\n${msg}`);
      return;
    }

    // Pre-flight: how many are new vs. overwrites? Warn before clobbering.
    // Match collection the same normalized way as upsert (blank == none).
    const label = (r) => r.collection ? `${r.collection}/${r.id}` : `${r.id} (screen)`;
    const overwrites = records.filter(r => {
      const rc = r.collection || null;
      return game.journal.some(j =>
        (j.getFlag(MODULE_ID, "collection") || null) === rc &&
        j.getFlag(MODULE_ID, "id") === r.id
      );
    });

    let proceed = true;
    if (overwrites.length) {
      proceed = await DialogV2.confirm({
        window: { title: "Confirm Import" },
        content: `<p>Importing <strong>${records.length}</strong> entr${records.length === 1 ? "y" : "ies"}.</p>
          <p><strong>${overwrites.length}</strong> already exist and will be <strong>overwritten</strong>:</p>
          <p class="notes">${overwrites.map(label).join(", ")}</p>
          <p>Continue?</p>`,
        rejectClose: false,
        modal: true
      }).catch(() => false);
    }
    if (!proceed) return;

    const results = await runImport(records);
    this.#renderResults(results.log, errors, results);

    const parts = [];
    if (results.created) parts.push(`${results.created} created`);
    if (results.updated) parts.push(`${results.updated} updated`);
    if (results.failed) parts.push(`${results.failed} failed`);
    if (errors.length) parts.push(`${errors.length} skipped`);
    ui.notifications.info(`Terminal import: ${parts.join(", ") || "nothing to do"}.`);
  }

  /* Paint the per-entry log into the results panel (kept visible so you
     can review what landed before importing the next batch). */
  #renderResults(log, errors, results = null) {
    const panel = this.element.querySelector(".terminal-import-results");
    if (!panel) return;
    const lines = [];
    if (results) {
      lines.push(`<div class="result-summary">${results.created} created · ${results.updated} updated · ${results.failed} failed</div>`);
    }
    for (const l of log) {
      const cls = l.startsWith("+") ? "ok-new" : l.startsWith("~") ? "ok-upd" : "err";
      lines.push(`<div class="result-line ${cls}">${foundry.utils.escapeHTML?.(l) ?? l}</div>`);
    }
    for (const e of errors) {
      lines.push(`<div class="result-line err">skip: ${foundry.utils.escapeHTML?.(e) ?? e}</div>`);
    }
    panel.innerHTML = lines.join("") || `<div class="result-line">No results.</div>`;
  }
}

/* ---- Launch points ---------------------------------------------------
   1. Journal directory footer button (GM only): always available.
   2. Header control on a collection SCREEN's journal sheet (crew roster,
      mission board, etc.): pre-fills that screen's collection so members
      land in the right set. */

/* Journal directory footer button. */
Hooks.on("renderJournalDirectory", (app, html) => {
  if (!game.user?.isGM) return;
  // html may be a jQuery object (v12 style) or HTMLElement (v13).
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  if (root.querySelector(".terminal-bulk-import")) return;

  const footer = root.querySelector(".directory-footer") ?? root;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "terminal-bulk-import";
  btn.innerHTML = `<i class="fa-solid fa-file-import"></i> Terminal: Bulk Import`;
  btn.addEventListener("click", () => new TerminalImport().render(true));
  footer.appendChild(btn);
});

/* Header control on collection screens: read the screen's declared
   collection (its payload's "collection" field) and pre-fill it.
   The payload may be flag-stored OR body-stored (most screens are
   body-stored — only interactive boards force flag storage), so we read
   it the same way the data layer does, via getPayload(). */
Hooks.on("getHeaderControlsJournalEntrySheet", (sheet, controls) => {
  if (!game.user?.isGM) return;
  const journal = sheet.document;
  // Only show on screens that LIST a collection (rosters/boards/directories).
  const parsed = getPayload(journal);
  const listed = (parsed.ok && parsed.data && typeof parsed.data === "object")
    ? (parsed.data.collection ?? null)
    : null;
  if (!listed) return;

  controls.push({
    icon: "fa-solid fa-file-import",
    label: `Import ${listed}…`,
    action: "terminalBulkImport",
    onClick: () => new TerminalImport({ presetCollection: listed }).render(true)
  });
});

export { TerminalImport, parseBatch, runImport };
