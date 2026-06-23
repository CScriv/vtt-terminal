/* =============================================================
   TERMINAL — Compose Reply (ApplicationV2)
   -------------------------------------------------------------
   Standalone "reply" window for a crew-feed post, replacing the former
   DialogV2 comment flow. Mirrors ComposePostApp (author mechanics, window
   conventions) but is scoped to one post and has no Notice flag.

   On Post it calls
     requestWrite({ action: "addComment", screenId, postId,
                    author, authorId, body })
   The addComment handler in sockets.mjs appends the reply (with id +
   timestamp) and re-renders open terminals.

   AUTHOR rules (same as post / mail compose):
     - GM: dropdown of crew (+ "— custom —" free author, no dossier link).
     - Player: locked to bound crew member (name + authorId). Unbound
       players can't open the window (caller guards; #onReply re-guards).

   Window mechanics follow compose.mjs: div root (floats), theme class on
   an INNER wrapper, post via data-action. See
   docs/TROUBLESHOOTING-applicationv2-windows.md.

   ⚠ VERSION-SENSITIVE: foundry.applications.api, ApplicationV2 actions,
   HandlebarsApplicationMixin. Foundry v13.351.
   ============================================================= */

import { loadCollection } from "./data.mjs";
import { requestWrite } from "./sockets.mjs";
import { boundMemberId, resolveSelfAuthor } from "./bindings.mjs";

const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ComposeReplyApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "terminal-compose-reply",
    tag: "div",
    classes: ["terminal-app", "terminal-compose"],
    window: { title: "Reply", frame: true, positioned: true, resizable: true },
    position: { width: 500, height: 400, left: 280, top: 160 },
    actions: {
      post: ComposeReplyApp.#onReply
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/compose-reply.hbs` }
  };

  /* opts:
       screenId  (required) feed screen
       postId    (required) post being replied to
       mode/editReplyId/editReplyIndex/initialBody for edit mode
       onPosted  optional callback after a successful reply/edit */
  constructor({ screenId, postId, mode = "create", editReplyId = null, editReplyIndex = null, initialBody = "", onPosted = null, ...rest } = {}) {
    super(rest);
    this.screenId = screenId;
    this.postId = postId;
    this.mode = mode;
    this.editReplyId = editReplyId;
    this.editReplyIndex = editReplyIndex;
    this.initialBody = initialBody;
    this.onPosted = onPosted;
  }

  get isEdit() { return this.mode === "edit"; }
  get title() { return this.isEdit ? "Edit Reply" : (this.options.window?.title ?? "Reply"); }

  _onRender(context, options) {
    super._onRender?.(context, options);

    const select = this.element.querySelector(".post-author-select");
    const customWrap = this.element.querySelector(".post-author-custom");
    if (select && customWrap) {
      const sync = () => {
        customWrap.style.display = (select.value === "__custom__") ? "" : "none";
      };
      select.addEventListener("change", sync);
      sync();
    }

    const form = this.element.querySelector("form.compose-form");
    if (form) {
      form.addEventListener("submit", (ev) => ev.preventDefault());
      form.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          ComposeReplyApp.#onReply.call(this, ev, ev.target);
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
        role: m.data?.role ?? ""
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Player display uses the same nickname-aware resolution as the rest
    // of the feed (resolveSelfAuthor), so a reply matches their like/post
    // identity.
    const self = selfId ? resolveSelfAuthor() : null;

    return {
      themeClass: game.settings.get(MODULE_ID, "themeClass"),
      isGM,
      isEdit: this.isEdit,
      initialBody: this.initialBody ?? "",
      selfId,
      selfName: self?.author ?? selfId,
      crew
    };
  }

  /* Resolve {author, authorId} honoring GM dropdown/custom vs player. */
  #resolveAuthor(form) {
    const isGM = game.user.isGM;

    if (!isGM) {
      const selfId = boundMemberId();
      if (!selfId) return null;
      const self = resolveSelfAuthor();      // nickname-aware display + authorId
      return { author: self.author, authorId: self.authorId };
    }

    const sel = form.elements.authorMember?.value ?? "__custom__";
    if (sel === "__custom__") {
      const typed = form.elements.authorCustom?.value?.trim() ?? "";
      if (!typed) return null;
      return { author: typed, authorId: null };
    }
    const member = loadCollection("crew").find(m => m.id === sel);
    return { author: member?.data?.name ?? sel, authorId: sel };
  }

  static async #onReply(event, _target) {
    event?.preventDefault?.();
    const form = this.element.querySelector("form.compose-form");
    if (!form) return;

    const body = form.elements.body?.value?.trim() ?? "";
    if (!body) {
      ui.notifications?.warn("Terminal: write a reply.");
      return;
    }

    // EDIT MODE: body-only update.
    if (this.isEdit) {
      await requestWrite({
        action: "editComment",
        screenId: this.screenId,
        postId: this.postId,
        replyId: this.editReplyId,
        replyIndex: this.editReplyIndex,
        body
      });
      this.onPosted?.();
      this.close();
      return;
    }

    // CREATE MODE
    const isGM = game.user.isGM;
    if (!isGM && !boundMemberId()) {
      ui.notifications?.warn("Terminal: you have no crew identity to reply as.");
      return;
    }

    const who = this.#resolveAuthor(form);
    if (!who) {
      ui.notifications?.warn("Terminal: choose or name an author to reply as.");
      return;
    }

    await requestWrite({
      action: "addComment",
      screenId: this.screenId,
      postId: this.postId,
      author: who.author,
      authorId: who.authorId,
      body
    });

    this.onPosted?.();
    this.close();
  }
}
