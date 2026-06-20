/* =============================================================
   TERMINAL — journal config UI
   -------------------------------------------------------------
   "Terminal Data" button on each Journal sheet header opens a form to set:
     flags.terminal.enabled    : boolean
     flags.terminal.id         : string
     flags.terminal.collection : string (optional)
     flags.terminal.json       : object (optional, flag-stored payload)

   FLAG-STORED JSON (for interactive screens that get written to):
   A JSON editor (textarea) lets you edit flag-stored payloads in-app,
   no console. When "Use flag storage" is on, the app reads the JSON
   from flags.terminal.json (the data layer already prefers it over the
   page body). Editing happens here; player/GM writes (status changes,
   likes) also target this flag, so writes are a clean setFlag.

   ⚠ VERSION-SENSITIVE: header-controls hook for journal sheets
   (getHeaderControlsJournalEntrySheet on 13.351).
   ============================================================= */

const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* Pull a best-effort JSON string from the first page body (so "Load
   from body" can migrate body-authored JSON into the flag editor). */
function bodyJsonString(journal) {
  const page = journal.pages?.contents?.[0];
  const html = page?.text?.content ?? "";
  if (!html) return "";
  const codeMatch = html.match(/<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/i);
  let text = codeMatch ? codeMatch[1] : html;
  text = text.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  return text.trim();
}

class TerminalConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(journal, options = {}) {
    super(options);
    this.journal = journal;
  }

  static DEFAULT_OPTIONS = {
    id: "terminal-config",
    tag: "form",
    classes: ["terminal-config"],
    window: { title: "Terminal Data", contentClasses: ["standard-form"] },
    position: { width: 560 },
    form: {
      handler: TerminalConfig.#onSubmit,
      closeOnSubmit: true
    },
    actions: {
      loadFromBody: TerminalConfig.#onLoadFromBody,
      formatJson: TerminalConfig.#onFormatJson
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/config.hbs` }
  };

  async _prepareContext() {
    const flagJson = this.journal.getFlag(MODULE_ID, "json");
    const useFlag = flagJson !== undefined && flagJson !== null;
    let jsonText = "";
    if (useFlag) {
      jsonText = typeof flagJson === "string"
        ? flagJson
        : JSON.stringify(flagJson, null, 2);
    }
    return {
      enabled: this.journal.getFlag(MODULE_ID, "enabled") === true,
      id: this.journal.getFlag(MODULE_ID, "id") ?? "",
      collection: this.journal.getFlag(MODULE_ID, "collection") ?? "",
      useFlag,
      jsonText,
      journalName: this.journal.name
    };
  }

  /* Load button: pull body JSON into the textarea (does not save). */
  static #onLoadFromBody(_event, _target) {
    const ta = this.element.querySelector("textarea[name='jsonText']");
    if (ta) ta.value = bodyJsonString(this.journal);
    // also tick the flag-storage box, since loading implies intent to use it
    const cb = this.element.querySelector("input[name='useFlag']");
    if (cb) cb.checked = true;
  }

  /* Format button: pretty-print the textarea JSON (and validate). */
  static #onFormatJson(_event, _target) {
    const ta = this.element.querySelector("textarea[name='jsonText']");
    if (!ta) return;
    try {
      const obj = JSON.parse(ta.value);
      ta.value = JSON.stringify(obj, null, 2);
      ui.notifications.info("Terminal: JSON is valid.");
    } catch (err) {
      ui.notifications.error(`Terminal: invalid JSON — ${err.message}`);
    }
  }

  static async #onSubmit(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const id = (data.id ?? "").trim();
    const collection = (data.collection ?? "").trim();
    const enabled = data.enabled === true;
    const useFlag = data.useFlag === true;
    const jsonText = (data.jsonText ?? "").trim();

    if (enabled && !id) {
      ui.notifications.warn("Terminal: a screen/member id is required to enable this journal.");
      return;
    }

    // Validate + write flag JSON if flag storage is on.
    if (useFlag) {
      if (!jsonText) {
        ui.notifications.warn("Terminal: flag storage is on but the JSON is empty.");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        ui.notifications.error(`Terminal: JSON not saved — ${err.message}`);
        return; // abort the whole save so nothing partial is written
      }
      await this.journal.setFlag(MODULE_ID, "json", parsed);
    } else {
      // flag storage off: clear any stored flag JSON so the app falls
      // back to the page body.
      if (this.journal.getFlag(MODULE_ID, "json") !== undefined) {
        await this.journal.unsetFlag(MODULE_ID, "json");
      }
    }

    await this.journal.setFlag(MODULE_ID, "enabled", enabled);
    if (id) await this.journal.setFlag(MODULE_ID, "id", id);
    else await this.journal.unsetFlag(MODULE_ID, "id");
    if (collection) await this.journal.setFlag(MODULE_ID, "collection", collection);
    else await this.journal.unsetFlag(MODULE_ID, "collection");

    ui.notifications.info(
      enabled
        ? `Terminal: "${this.journal.name}" live${collection ? ` in "${collection}"` : ""} as "${id}"${useFlag ? " (flag-stored)" : ""}.`
        : `Terminal: "${this.journal.name}" set inactive.`
    );
  }
}

/* ---- Inject the header-controls button on journal sheets ---- */
const HOOK_NAME = "getHeaderControlsJournalEntrySheet";

Hooks.on(HOOK_NAME, (sheet, controls) => {
  controls.push({
    icon: "fa-solid fa-terminal",
    label: "Terminal Data",
    action: "terminalConfig",
    onClick: () => new TerminalConfig(sheet.document).render(true)
  });
});

export { TerminalConfig };
