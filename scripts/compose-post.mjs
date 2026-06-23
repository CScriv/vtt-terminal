/* =============================================================
   TERMINAL — Compose Post (ApplicationV2)
   -------------------------------------------------------------
   Standalone "new post" window for the crew feed, mirroring the inbox's
   ComposeMessageApp. On Post it calls
     requestWrite({ action: "addPost", screenId, author, authorId, role,
                    official, body })
   The addPost handler in sockets.mjs appends the post (with timestamp,
   stable id, empty likes/replies) and re-renders open terminals.

   AUTHOR rules (same model as mail compose):
     - GM: may post AS any crew member (dropdown). Selecting a member fills
       author/authorId/role from that member. GM may also leave it on the
       "— custom —" option and type a free author name (no dossier link,
       e.g. an official ship-wide system notice).
     - Player: locked to their bound crew member; author/authorId/role come
       from that member. If unbound, the window won't open (caller guards,
       and #onPost re-guards).

   NOTICE flag: a checkbox sets `official: true`, which drives the feed's
   blue "Notice" styling. Players may flag their own posts as notices too;
   if you want to restrict that to GMs, gate it in #onPost.

   Window mechanics follow the hard-won compose.mjs pattern: div root
   (floats as a popout), theme class on an INNER wrapper in the template
   (never the root — that would break window positioning), send via a
   data-action (not a form submit). See
   docs/TROUBLESHOOTING-applicationv2-windows.md.

   ⚠ VERSION-SENSITIVE: foundry.applications.api, ApplicationV2 actions,
   HandlebarsApplicationMixin. Foundry v13.351.
   ============================================================= */

import { loadCollection } from "./data.mjs";
import { requestWrite } from "./sockets.mjs";
import { boundMemberId, canPinOrNotice } from "./bindings.mjs";

const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ComposePostApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "terminal-compose-post",
    tag: "div",
    classes: ["terminal-app", "terminal-compose"],
    window: { title: "New Post", frame: true, positioned: true, resizable: true },
    position: { width: 520, height: 480, left: 260, top: 140 },
    actions: {
      post: ComposePostApp.#onPost
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/compose-post.hbs` }
  };

  /* opts:
       screenId    (required) feed screen to post into
       mode        "create" (default) or "edit"
       editPostId  (edit) id of the post being edited
       initialBody (edit) body to pre-fill
       onPosted    optional callback fired after a successful post/edit */
  constructor({ screenId, mode = "create", editPostId = null, initialBody = "", onPosted = null, ...rest } = {}) {
    super(rest);
    this.screenId = screenId;
    this.mode = mode;
    this.editPostId = editPostId;
    this.initialBody = initialBody;
    this.onPosted = onPosted;
  }

  get isEdit() { return this.mode === "edit"; }

  /* Edit mode changes the window title. */
  get title() {
    return this.isEdit ? "Edit Post" : (this.options.window?.title ?? "New Post");
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // When the GM picks a crew member from the author dropdown, surface
    // their role next to it; "— custom —" reveals the free author input.
    const select = this.element.querySelector(".post-author-select");
    const customWrap = this.element.querySelector(".post-author-custom");
    if (select && customWrap) {
      const sync = () => {
        customWrap.style.display = (select.value === "__custom__") ? "" : "none";
      };
      select.addEventListener("change", sync);
      sync();
    }

    // Prevent native submit; add Ctrl/Cmd+Enter to post.
    const form = this.element.querySelector("form.compose-form");
    if (form) {
      form.addEventListener("submit", (ev) => ev.preventDefault());
      form.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          ComposePostApp.#onPost.call(this, ev, ev.target);
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

    const self = selfId ? crew.find(c => c.id === selfId) : null;

    return {
      themeClass: game.settings.get(MODULE_ID, "themeClass"),
      isGM,
      isEdit: this.isEdit,
      initialBody: this.initialBody ?? "",
      // Notice is gated by feedPinAuthority (GM-only by default). In edit
      // mode we hide author + notice controls entirely (body-only edit).
      canNotice: canPinOrNotice(game.user),
      // player identity (fixed author)
      selfId,
      selfName: self?.name ?? selfId,
      selfRole: self?.role ?? "",
      // GM author dropdown
      crew
    };
  }

  /* Resolve the author triple {author, authorId, role} from the form,
     honoring GM dropdown / custom vs player-fixed. */
  #resolveAuthor(form) {
    const isGM = game.user.isGM;

    if (!isGM) {
      const selfId = boundMemberId();
      if (!selfId) return null;
      const member = loadCollection("crew").find(m => m.id === selfId);
      return {
        author: member?.data?.name ?? selfId,
        authorId: selfId,
        role: member?.data?.role ?? ""
      };
    }

    // GM path
    const sel = form.elements.authorMember?.value ?? "__custom__";
    if (sel === "__custom__") {
      const typed = form.elements.authorCustom?.value?.trim() ?? "";
      if (!typed) return null;
      return { author: typed, authorId: null, role: "" }; // free author, no dossier link
    }
    const member = loadCollection("crew").find(m => m.id === sel);
    return {
      author: member?.data?.name ?? sel,
      authorId: sel,
      role: member?.data?.role ?? ""
    };
  }

  static async #onPost(event, _target) {
    event?.preventDefault?.();
    const form = this.element.querySelector("form.compose-form");
    if (!form) return;

    const body = form.elements.body?.value?.trim() ?? "";
    if (!body) {
      ui.notifications?.warn("Terminal: write something to post.");
      return;
    }

    // EDIT MODE: body-only update, author/notice unchanged.
    if (this.isEdit) {
      await requestWrite({
        action: "editPost",
        screenId: this.screenId,
        postId: this.editPostId,
        body
      });
      this.onPosted?.();
      this.close();
      return;
    }

    // CREATE MODE
    const isGM = game.user.isGM;
    if (!isGM && !boundMemberId()) {
      ui.notifications?.warn("Terminal: you have no crew identity to post as.");
      return;
    }

    const who = this.#resolveAuthor(form);
    if (!who) {
      ui.notifications?.warn("Terminal: choose or name an author to post as.");
      return;
    }

    // Notice only honored when the user is permitted to flag notices.
    const official = canPinOrNotice(game.user) && !!form.elements.official?.checked;

    await requestWrite({
      action: "addPost",
      screenId: this.screenId,
      author: who.author,
      authorId: who.authorId,
      role: who.role,
      official,
      body
    });

    this.onPosted?.();
    this.close();
  }
}
