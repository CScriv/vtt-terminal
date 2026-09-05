/* =============================================================
   TERMINAL — Datapad authoring (ApplicationV2)
   -------------------------------------------------------------
   Three small windows, so no single form has to express everything:

     DatapadCreateApp — makes a NEW datapad journal (the only place in
                        the module that CREATES a document rather than
                        mutating one). GM-only.
     DatapadMetaApp   — title / source / date / tag / prompt of an
                        existing datapad.
     BlockEditorApp   — one block, with a field set chosen by block
                        type. Add and edit are the same window.

   Block content editing lives on the datapad screen itself, next to
   the reveal toggle that's already there, rather than in a separate
   manager. Everything writes through requestWrite() so the existing
   update hook re-renders open terminals.

   2D BLOCK DATA (keyvalue rows, table headers/rows) is edited as
   pipe-delimited text, one row per line. A real cell grid would be
   several times the code for a window this size; the pipe format is
   the deliberate trade. See docs/STAGE6-datapad-editor.md.

   Window mechanics follow the compose.mjs pattern: div root, theme
   class on an INNER wrapper in the template (never the root — that
   breaks window positioning), save via a data-action rather than a
   form submit. See docs/TROUBLESHOOTING-applicationv2-windows.md.

   ⚠ VERSION-SENSITIVE: foundry.applications.api, ApplicationV2
   actions, HandlebarsApplicationMixin, JournalEntry.create. v13.351.
   ============================================================= */

import { loadMember } from "./data.mjs";
import { requestWrite } from "./sockets.mjs";

const MODULE_ID = "vtt-terminal";
const COLLECTION = "datapads";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* ============================================================
   Text <-> structure helpers for the pipe-delimited fields.
   Round-tripping is lossless for anything that doesn't contain a
   literal "|", which the editor warns about rather than escaping.
   ============================================================ */

/* "a | b | c" -> ["a","b","c"] */
export function splitCells(line) {
  return String(line ?? "").split("|").map(s => s.trim());
}

/* One item per line -> array of strings (blank lines dropped). */
export function linesToItems(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}
export function itemsToLines(items) {
  return (Array.isArray(items) ? items : []).join("\n");
}

/* "Key | Value" per line -> [["Key","Value"], ...]. A line with no
   pipe becomes [line, ""] so a half-typed row isn't silently lost. */
export function linesToPairs(text) {
  return linesToItems(text).map(line => {
    const cells = splitCells(line);
    return [cells[0] ?? "", cells.slice(1).join(" | ")];
  });
}
export function pairsToLines(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => Array.isArray(r) ? `${r[0] ?? ""} | ${r[1] ?? ""}` : String(r ?? ""))
    .join("\n");
}

/* Pipe-delimited grid: one row per line, cells split on "|". */
export function linesToRows(text) {
  return linesToItems(text).map(splitCells);
}
export function rowsToLines(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => Array.isArray(r) ? r.join(" | ") : String(r ?? ""))
    .join("\n");
}

/* Slugify a title into a collection member id. */
export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}


/* ============================================================
   Create a new datapad
   ============================================================ */
export class DatapadCreateApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "terminal-datapad-create",
    tag: "div",
    classes: ["terminal-app", "terminal-compose"],
    window: { title: "New Datapad", frame: true, positioned: true, resizable: true },
    position: { width: 520, height: 520, left: 260, top: 140 },
    actions: { save: DatapadCreateApp.#onSave }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/datapad-create.hbs` }
  };

  async _prepareContext(_options) {
    return { themeClass: game.settings.get(MODULE_ID, "themeClass") };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    /* Auto-derive the id from the title until the GM edits the id
       field by hand, then leave it alone. */
    const title = this.element.querySelector('[name="title"]');
    const id = this.element.querySelector('[name="id"]');
    if (title && id) {
      id.addEventListener("input", () => { id.dataset.touched = "1"; });
      title.addEventListener("input", () => {
        if (id.dataset.touched) return;
        id.value = slugify(title.value);
      });
    }

    const form = this.element.querySelector("form.compose-form");
    if (form) form.addEventListener("submit", (ev) => ev.preventDefault());
  }

  static async #onSave(event, _target) {
    event?.preventDefault?.();
    if (!game.user.isGM) return;
    const form = this.element.querySelector("form.compose-form");
    if (!form) return;

    const title = form.elements.title?.value?.trim() ?? "";
    if (!title) {
      ui.notifications?.warn("Terminal: the datapad needs a title.");
      return;
    }
    const id = (form.elements.id?.value?.trim() || slugify(title));
    if (!id) {
      ui.notifications?.warn("Terminal: couldn't derive an id from that title — type one.");
      return;
    }

    await requestWrite({
      action: "createDatapad",
      id,
      title,
      source: form.elements.source?.value?.trim() || null,
      date: form.elements.date?.value?.trim() || null,
      tag: form.elements.tag?.value?.trim() || null,
      prompt: form.elements.prompt?.value?.trim() || null
    });

    this.close();
  }
}


/* ============================================================
   Edit an existing datapad's header fields
   ============================================================ */
export class DatapadMetaApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    tag: "div",
    classes: ["terminal-app", "terminal-compose"],
    window: { title: "Datapad Info", frame: true, positioned: true, resizable: true },
    position: { width: 520, height: 480, left: 260, top: 140 },
    actions: { save: DatapadMetaApp.#onSave }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/datapad-meta.hbs` }
  };

  constructor({ memberId, ...rest } = {}) {
    super({ ...rest, id: `terminal-datapad-meta-${memberId}` });
    this.memberId = memberId;
  }

  async _prepareContext(_options) {
    const res = loadMember(COLLECTION, this.memberId, { includeDisabled: true });
    const d = res.ok ? res.data : {};
    return {
      themeClass: game.settings.get(MODULE_ID, "themeClass"),
      memberId: this.memberId,
      title: d.title ?? "",
      source: d.source ?? "",
      date: d.date ?? "",
      tag: d.tag ?? "",
      prompt: d.prompt ?? ""
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element.querySelector("form.compose-form");
    if (form) form.addEventListener("submit", (ev) => ev.preventDefault());
  }

  static async #onSave(event, _target) {
    event?.preventDefault?.();
    if (!game.user.isGM) return;
    const form = this.element.querySelector("form.compose-form");
    if (!form) return;

    const title = form.elements.title?.value?.trim() ?? "";
    if (!title) {
      ui.notifications?.warn("Terminal: the datapad needs a title.");
      return;
    }

    await requestWrite({
      action: "setDatapadMeta",
      memberId: this.memberId,
      title,
      source: form.elements.source?.value?.trim() || null,
      date: form.elements.date?.value?.trim() || null,
      tag: form.elements.tag?.value?.trim() || null,
      prompt: form.elements.prompt?.value?.trim() || null
    });

    this.close();
  }
}


/* ============================================================
   Edit / add one block
   ============================================================ */
export class BlockEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    tag: "div",
    classes: ["terminal-app", "terminal-compose", "terminal-block-editor"],
    window: { title: "Datapad Block", frame: true, positioned: true, resizable: true },
    position: { width: 560, height: 600, left: 280, top: 120 },
    actions: { save: BlockEditorApp.#onSave }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/datapad-block.hbs` }
  };

  /* opts: { memberId, blockId? }. blockId absent -> add mode. */
  constructor({ memberId, blockId = null, ...rest } = {}) {
    super({
      ...rest,
      id: `terminal-datapad-block-${memberId}-${blockId ?? "new"}`,
      window: { ...(rest.window ?? {}), title: blockId ? "Edit Block" : "Add Block" }
    });
    this.memberId = memberId;
    this.blockId = blockId;
  }

  get isEdit() { return !!this.blockId; }

  async _prepareContext(_options) {
    const res = loadMember(COLLECTION, this.memberId, { includeDisabled: true });
    const data = res.ok ? res.data : {};
    const blocks = Array.isArray(data.blocks) ? data.blocks : [];

    /* Match on the same id the renderer uses, including the b<index>
       fallback, so blocks authored before ids existed are editable. */
    const block = this.isEdit
      ? blocks.find((b, i) => (b.id ?? `b${i}`) === this.blockId) ?? {}
      : {};

    const type = block.type ?? "text";

    return {
      themeClass: game.settings.get(MODULE_ID, "themeClass"),
      isEdit: this.isEdit,
      memberId: this.memberId,
      blockId: this.blockId,
      submitLabel: this.isEdit ? "Save block" : "Add block",
      types: ["heading", "text", "keyvalue", "table", "message"]
        .map(t => ({ value: t, selected: t === type })),
      type,
      /* Every field for every type is prepared; the template shows the
         set matching the current type and JS swaps on change. */
      text: block.text ?? "",
      label: block.label ?? "",
      body: block.body ?? "",
      items: itemsToLines(block.items),
      pairs: pairsToLines(block.rows),
      headers: Array.isArray(block.headers) ? block.headers.join(" | ") : "",
      rows: rowsToLines(block.rows),
      subject: block.subject ?? "",
      from: block.from ?? "",
      to: block.to ?? "",
      date: block.date ?? "",
      secret: block.secret === true,
      lockLabel: block.lockLabel ?? ""
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    /* Show only the field set for the selected type. */
    const sel = this.element.querySelector('[name="type"]');
    const sync = () => {
      const t = sel?.value ?? "text";
      this.element.querySelectorAll("[data-type-fields]").forEach(el => {
        el.style.display = (el.dataset.typeFields === t) ? "" : "none";
      });
    };
    if (sel) sel.addEventListener("change", sync);
    sync();

    const form = this.element.querySelector("form.compose-form");
    if (form) form.addEventListener("submit", (ev) => ev.preventDefault());
  }

  static async #onSave(event, _target) {
    event?.preventDefault?.();
    if (!game.user.isGM) return;
    const form = this.element.querySelector("form.compose-form");
    if (!form) return;

    const type = form.elements.type?.value ?? "text";

    /* Read a single named control.
       Every type's field set is in the DOM (inactive ones are only
       hidden), so a name shared between two field sets would come back
       as a RadioNodeList whose .value is "" — the field would silently
       save as empty and then get pruned out of the block entirely.
       Field names are therefore prefixed by type in the template; this
       guard catches it loudly if one ever slips through. */
    const el = (name) => {
      const found = form.elements[name];
      if (found instanceof RadioNodeList) {
        console.error(`${MODULE_ID} | block editor: duplicate field name "${name}" — values will not save.`);
        return found[0] ?? null;
      }
      return found ?? null;
    };
    const val = (name) => el(name)?.value?.trim() ?? "";

    /* Build only the fields that belong to this type, so switching a
       block's type doesn't leave the old type's keys behind. */
    const block = { type };
    if (type === "heading") {
      block.text = val("heading-text");
      if (!block.text) {
        ui.notifications?.warn("Terminal: a heading needs text.");
        return;
      }
    } else if (type === "text") {
      block.label = val("text-label") || null;
      block.body = val("text-body") || null;
      const items = linesToItems(el("text-items")?.value);
      block.items = items.length ? items : null;
    } else if (type === "keyvalue") {
      block.label = val("kv-label") || null;
      block.rows = linesToPairs(el("kv-pairs")?.value);
    } else if (type === "table") {
      block.label = val("table-label") || null;
      const headers = splitCells(val("table-headers")).filter(Boolean);
      block.headers = headers.length ? headers : null;
      block.rows = linesToRows(el("table-rows")?.value);
    } else if (type === "message") {
      block.subject = val("msg-subject") || null;
      block.from = val("msg-from") || null;
      block.to = val("msg-to") || null;
      block.date = val("msg-date") || null;
      block.body = val("msg-body") || null;
    }

    block.secret = !!form.elements.secret?.checked;
    block.lockLabel = block.secret ? (val("lockLabel") || null) : null;

    await requestWrite({
      action: "upsertBlock",
      memberId: this.memberId,
      blockId: this.blockId,   // null -> append
      block
    });

    this.close();
  }
}
