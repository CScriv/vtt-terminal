/* =============================================================
   TERMINAL — Compose Message (ApplicationV2)
   -------------------------------------------------------------
   A standalone in-world "compose" window for the inbox. Replaces the
   former DialogV2.prompt flow with a full ApplicationV2 so the compose
   experience is themed, resizable, and extensible (attachments, drafts,
   richer recipient UI, etc.).

   Contract is unchanged: on Send it calls
     requestWrite({ action: "sendMessage", screenId, from, to, subject, body })
   so sockets.mjs needs no changes.

   FROM rules (unchanged from the old dialog):
     - GM: may send AS any crew member (dropdown).
     - Player: locked to their bound crew member id; if unbound, the
       compose window won't open (the caller guards this, and we re-guard).

   TO model (unchanged): a flat list of recipient tokens, each either a
   crew member id or a department name. Stored verbatim in `to: [...]`.

   ⚠ VERSION-SENSITIVE: foundry.applications.api access path, ApplicationV2
   actions, HandlebarsApplicationMixin. Root is a div (popout); the form
   lives in the template and sends via a data-action. Foundry v13.351.
   ============================================================= */

import { loadCollection } from "./data.mjs";
import { requestWrite } from "./sockets.mjs";
import { boundMemberId } from "./bindings.mjs";

const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ComposeMessageApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "terminal-compose",
    tag: "div",                        // div root: floats as a popout (matches TerminalApp). A <form> lives inside the template.
    classes: ["terminal-app", "terminal-compose"],
    window: { title: "Compose Message", frame: true, positioned: true, resizable: true },
    position: { width: 560, height: 620, left: 240, top: 120 },
    actions: {
      toggleAll: ComposeMessageApp.#onToggleAll,
      send: ComposeMessageApp.#onSend
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/compose.hbs` }
  };

  /* ---- construction ----
     opts:
       screenId      (required) inbox screen to send into
       prefillTo     optional member id to pre-check
       prefillSubject optional subject (already "Re: ...")
       onSent        optional callback fired after a successful send */
  constructor({ screenId, prefillTo = null, prefillSubject = "", onSent = null, ...rest } = {}) {
    super(rest);
    this.screenId = screenId;
    this.prefillTo = prefillTo;
    this.prefillSubject = prefillSubject;
    this.onSent = onSent;
  }

  /* Wire up listeners after render. The theme class is applied to an
     INNER wrapper in the template (not the app root): the theme rule sets
     position: relative / overflow: hidden, which on the floating window
     frame would override the window system's position: absolute and let
     the sidebar layout constrain the window. On the inner wrapper it
     anchors the scanline overlay where it belongs. */
  _onRender(context, options) {
    super._onRender?.(context, options);

    // Wire the recipient filter box (show/hide rows by substring).
    const filter = this.element.querySelector(".to-filter");
    const list = this.element.querySelector(".to-list");
    if (filter && list) {
      filter.addEventListener("input", () => {
        const q = filter.value.trim().toLowerCase();
        list.querySelectorAll(".to-check").forEach(lbl => {
          const txt = (lbl.dataset.search ?? lbl.textContent).toLowerCase();
          lbl.style.display = (!q || txt.includes(q)) ? "" : "none";
        });
      });
    }

    // The inner <form> shouldn't natively submit (no page reload / no
    // implicit submit on Enter in a text field). Route everything through
    // the send action instead, and add Ctrl/Cmd+Enter as a send shortcut.
    const form = this.element.querySelector("form.compose-form");
    if (form) {
      form.addEventListener("submit", (ev) => ev.preventDefault());
      form.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          ComposeMessageApp.#onSend.call(this, ev, ev.target);
        }
      });
    }
  }

  async _prepareContext(_options) {
    const isGM = game.user.isGM;
    const selfId = isGM ? null : boundMemberId();

    const crew = loadCollection("crew")
      .map(m => ({
        id: m.id,
        name: m.data?.name ?? m.id,
        department: m.data?.department ?? null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const departments = [...new Set(crew.map(c => c.department).filter(Boolean))].sort();

    const selfName = selfId
      ? (crew.find(c => c.id === selfId)?.name ?? selfId)
      : null;

    return {
      themeClass: game.settings.get(MODULE_ID, "themeClass"),
      isGM,
      selfId,
      selfName,
      crew: crew.map(c => ({ ...c, checked: c.id === this.prefillTo })),
      departments,
      prefillSubject: this.prefillSubject ?? ""
    };
  }

  /* Select / deselect every currently-visible recipient. Operating on
     visible rows only means it cooperates with the filter box. */
  static #onToggleAll(event, target) {
    event?.preventDefault?.();
    const list = this.element.querySelector(".to-list");
    if (!list) return;
    const visible = Array.from(list.querySelectorAll(".to-check"))
      .filter(lbl => lbl.style.display !== "none");
    const boxes = visible.map(lbl => lbl.querySelector('input[name="to"]')).filter(Boolean);
    const anyUnchecked = boxes.some(b => !b.checked);
    boxes.forEach(b => { b.checked = anyUnchecked; }); // all on if any were off, else all off
  }

  /* Send handler, fired by the [ SEND TRANSMISSION ] button
     (data-action="send"). We read values off the inner <form> element.
     Recipients are read live because checkbox groups don't round-trip
     cleanly through FormDataExtended expansion. */
  static async #onSend(event, target) {
    event?.preventDefault?.();
    const form = this.element.querySelector("form.compose-form");
    if (!form) return;

    const isGM = game.user.isGM;
    const selfId = isGM ? null : boundMemberId();

    // Re-guard: a player with no mailbox identity can't send.
    if (!isGM && !selfId) {
      ui.notifications?.warn("Terminal: you have no mailbox identity to send from.");
      return;
    }

    const from = isGM
      ? (form.elements.from?.value ?? "")
      : selfId;

    const to = Array.from(form.querySelectorAll('input[name="to"]:checked'))
      .map(c => c.value);
    const subject = form.elements.subject?.value?.trim() ?? "";
    const body = form.elements.body?.value?.trim() ?? "";

    // Validation failure: warn and keep the window open for correction.
    if (!from) {
      ui.notifications?.warn("Terminal: choose who the message is from.");
      return;
    }
    if (!to.length || !body) {
      ui.notifications?.warn("Terminal: a recipient and a message body are required.");
      return;
    }

    await requestWrite({
      action: "sendMessage",
      screenId: this.screenId,
      from,
      to,
      subject: subject || "(no subject)",
      body
    });

    this.onSent?.();
    this.close();
  }
}
