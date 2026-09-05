/* =============================================================
   TERMINAL — request composer (requisitions + crew requests)
   -------------------------------------------------------------
   A standalone window for CREATING and EDITING entries on any
   "request-board" screen, so boards can be authored from inside
   the terminal instead of by hand-editing the journal JSON.

   One app serves both modes and both boards:
     - mode "create": blank form, appends a new request.
     - mode "edit":   pre-filled from the existing request, patches
                      it in place.
   The board is read for its own `sections` to populate the status
   dropdown, exactly as the status popup does, so a board's valid
   statuses stay declared in one place (its JSON).

   GM-ONLY. Authoring requests is a GM action: the open/edit
   controls only render for the GM, this app re-checks on open, and
   the upsertRequest write handler re-checks GM-side. Players keep
   their existing ability to change a request's status.

   Requester attribution mirrors the status popup: a crew dropdown
   (which sets `fromId`, so the name links to the dossier) plus a
   custom-name override for requesters who aren't crew.

   ⚠ VERSION-SENSITIVE: ApplicationV2 form handler signature and
   the `form` options block. Targets 13.351.
   ============================================================= */

import { loadScreen, loadCollection } from "./data.mjs";
import { requestWrite } from "./sockets.mjs";
import { terminalWorldTime } from "./gametime.mjs";

const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ComposeRequestApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    tag: "div",
    classes: ["terminal-app", "terminal-compose", "terminal-compose-request"],
    window: { title: "New Request", frame: true, positioned: true, resizable: true },
    position: { width: 560, height: 620, left: 260, top: 140 },
    actions: { save: ComposeRequestApp.#onSave }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/compose-request.hbs` }
  };

  /* opts: { screenId, requestId? }
     requestId present -> edit mode. The instance id is derived so a
     create window and an edit window can be open at once without
     colliding in the application registry. */
  constructor(opts = {}) {
    const requestId = opts.requestId ?? null;
    super({
      ...opts,
      id: `terminal-compose-request-${requestId ?? "new"}`,
      window: {
        ...(opts.window ?? {}),
        title: requestId ? "Edit Request" : "New Request"
      }
    });
    this.screenId = opts.screenId;
    this.requestId = requestId;
  }

  get isEdit() { return !!this.requestId; }

  async _prepareContext(options) {
    const ctx = await super._prepareContext?.(options) ?? {};

    const res = loadScreen(this.screenId);
    const data = res.ok ? res.data : {};
    const sections = Array.isArray(data.sections) ? data.sections : [];
    const requests = Array.isArray(data.requests) ? data.requests : [];

    /* Existing request (edit mode). Missing -> the form opens blank
       rather than erroring; the write would fail the id lookup anyway
       and report it there. */
    const req = this.isEdit ? requests.find(r => r.id === this.requestId) : null;

    /* Valid statuses come from the board's own sections, in declared
       order, de-duplicated. Same source the status popup reads. */
    const statuses = [...new Set(sections.flatMap(s => s.statuses ?? []))];
    const currentStatus = req?.status ?? statuses[0] ?? "open";

    /* Crew, for the requester dropdown. Full names (records, not feed),
       per the nickname rule. */
    const crew = loadCollection("crew")
      .map(m => ({ id: m.id, name: m.data?.name ?? m.id, role: m.data?.role ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));

    /* A requester who isn't in the crew collection was authored as a
       plain `from` string with no fromId — surface it in the custom
       field so editing doesn't silently drop it. */
    const fromIsCrew = !!req?.fromId && crew.some(c => c.id === req.fromId);
    const customFrom = (req && !fromIsCrew) ? (req.from ?? "") : "";

    /* Missions, for the optional promote link. Values are ready-made
       navigation targets so the template stays declarative. */
    const missions = loadCollection("missions")
      .map(m => ({
        target: `missions/${m.id}`,
        name: m.data?.name ?? m.data?.title ?? m.id
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...ctx,
      themeClass: game.settings.get(MODULE_ID, "themeClass"),
      isEdit: this.isEdit,
      screenId: this.screenId,
      requestId: this.requestId,
      submitLabel: this.isEdit ? "Save changes" : "Post request",
      title: req?.title ?? "",
      body: req?.body ?? "",
      role: req?.role ?? "",
      customFrom,
      crew: crew.map(c => ({ ...c, selected: fromIsCrew && c.id === req.fromId })),
      statuses: statuses.map(s => ({ value: s, selected: s === currentStatus })),
      missions: missions.map(m => ({ ...m, selected: m.target === req?.promote?.target })),
      promoteLabel: req?.promote?.label ?? "",
      hasPromote: !!req?.promote,
      /* Date: only offered as an override. New requests are stamped with
         the current in-world time; an existing hand-authored `date`
         string is shown so it can be corrected without being clobbered. */
      date: req?.date ?? "",
      /* A request created in-app carries `wt`; its date cell is derived
         from that, so the manual field is disabled to avoid two competing
         sources. Clearing wt is the escape hatch (see the doc). */
      dateLocked: Number.isFinite(req?.wt)
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    /* Picking a crew member fills the role field from their dossier,
       unless the GM has already typed something there. Convenience
       only — role stays freely editable. */
    const memberSel = this.element?.querySelector?.('[name="member"]');
    const roleInput = this.element?.querySelector?.('[name="role"]');
    if (memberSel && roleInput) {
      memberSel.addEventListener("change", () => {
        const opt = memberSel.selectedOptions?.[0];
        const role = opt?.dataset?.role ?? "";
        if (role && !roleInput.value.trim()) roleInput.value = role;
      });
    }

    /* Picking a mission fills the promote label with the mission name,
       same "don't overwrite typed text" rule. */
    const promoteSel = this.element?.querySelector?.('[name="promoteTarget"]');
    const promoteLabel = this.element?.querySelector?.('[name="promoteLabel"]');
    if (promoteSel && promoteLabel) {
      promoteSel.addEventListener("change", () => {
        const opt = promoteSel.selectedOptions?.[0];
        const name = opt?.dataset?.name ?? "";
        if (!promoteSel.value) { promoteLabel.value = ""; return; }
        if (name && !promoteLabel.value.trim()) promoteLabel.value = name;
      });
    }

    const form = this.element?.querySelector?.("form.compose-form");
    if (form) form.addEventListener("submit", (ev) => ev.preventDefault());
  }

  /* Collect the form and hand it to the write layer. Validation that
     matters (GM check, board exists, status is valid for this board) is
     re-done GM-side in upsertRequest; this only catches the empty-form
     case so the window can stay open and say why. */
  static async #onSave(event, _target) {
    event?.preventDefault?.();
    if (!game.user.isGM) return;
    const form = this.element?.querySelector?.("form.compose-form");
    if (!form) return;

    const v = (name) => form.elements[name]?.value?.trim() ?? "";

    const title = v("title");
    if (!title) {
      ui.notifications?.warn("Terminal: a request needs a title.");
      return;
    }

    const custom = v("custom");
    const memberId = form.elements.member?.value ?? "";
    const member = memberId ? loadCollection("crew").find(c => c.id === memberId) : null;

    /* Custom name wins (non-crew requester, no dossier link); else the
       selected crew member's FULL name + id; else no requester. */
    let from = null;
    let fromId = null;
    if (custom) {
      from = custom;
    } else if (member) {
      from = member.data?.name ?? memberId;
      fromId = memberId;
    }

    const promoteTarget = v("promoteTarget");
    const promote = promoteTarget
      ? { target: promoteTarget, label: v("promoteLabel") || "see Mission Log" }
      : null;

    await requestWrite({
      action: "upsertRequest",
      screenId: this.screenId,
      requestId: this.requestId,        // null -> create
      title,
      from,
      fromId,
      role: v("role") || null,
      status: form.elements.status?.value ?? "",
      body: v("body") || null,
      date: v("date") || null,
      promote,
      /* New requests are stamped with the current in-world time so the
         board can sort them reliably; see the wt/date note in the doc. */
      wt: this.isEdit ? undefined : terminalWorldTime()
    });

    this.close();
  }
}
