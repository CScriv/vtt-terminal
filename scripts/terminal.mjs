/* =============================================================
   TERMINAL — generic in-world computer UI engine
   Stage 4 (crew): collections + parameterized navigation +
   crew-roster / dossier render types.

   Navigation targets come in two forms:
     "missions"        -> a standalone screen (journal with id)
     "crew/matthews"   -> a collection member (collection "crew",
                          member id "matthews") rendered as its
                          member render type (e.g. dossier)

   NAMESPACE: "terminal". Theme is a configurable class.

   ⚠ VERSION-SENSITIVE: foundry.applications.api access path, window
   options, ApplicationV2 actions, handlebars.loadTemplates. 13.351.
   ============================================================= */

import {
  loadScreen, loadCollection, loadMember
} from "./data.mjs";
import { requestWrite, suppressReadRender } from "./sockets.mjs";
import { debugTime, formatWorldTime, terminalWorldTime, secondsPerDay } from "./gametime.mjs";
import { resolveSelfAuthor, boundMemberId, canPinOrNotice } from "./bindings.mjs";
import "./config.mjs";
import "./controls.mjs";
import "./sockets.mjs";
import "./bindings.mjs";
import "./import.mjs";

import { ComposeMessageApp } from "./compose.mjs";
import { ComposePostApp } from "./compose-post.mjs";
import { ComposeReplyApp } from "./compose-reply.mjs";


const MODULE_ID = "vtt-terminal";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* render-type -> partial. Add a layout = add a partial + an entry. */
const RENDER_TEMPLATES = {
  hub:            `modules/${MODULE_ID}/templates/render/hub.hbs`,
  "crew-roster":  `modules/${MODULE_ID}/templates/render/crew-roster.hbs`,
  dossier:        `modules/${MODULE_ID}/templates/render/dossier.hbs`,
  "mission-board":`modules/${MODULE_ID}/templates/render/mission-board.hbs`,
  "mission":      `modules/${MODULE_ID}/templates/render/mission.hbs`,
  "blackbox":     `modules/${MODULE_ID}/templates/render/blackbox.hbs`,
  "feed":         `modules/${MODULE_ID}/templates/render/feed.hbs`,
  "request-board":`modules/${MODULE_ID}/templates/render/request-board.hbs`,
  "inbox":        `modules/${MODULE_ID}/templates/render/inbox.hbs`,
  "thread":       `modules/${MODULE_ID}/templates/render/thread.hbs`,
  "datapad-directory": `modules/${MODULE_ID}/templates/render/datapad-directory.hbs`,
  "datapad":      `modules/${MODULE_ID}/templates/render/datapad.hbs`,
  "location-directory": `modules/${MODULE_ID}/templates/render/location-directory.hbs`,
  "location":     `modules/${MODULE_ID}/templates/render/location.hbs`
};

class TerminalApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "terminal-app",
    tag: "div",
    classes: ["terminal-app"],
    window: { title: "TERMINAL", frame: true, positioned: true, resizable: true },
    position: { width: 720, height: 640, left: 200, top: 100 },
    actions: {
      navigate: TerminalApp.#onNavigate,
      back: TerminalApp.#onBack,
      home: TerminalApp.#onHome,
      setStatus: TerminalApp.#onSetStatus,
      react: TerminalApp.#onReact,
      addComment: TerminalApp.#onAddComment,
      openThread: TerminalApp.#onOpenThread,
      replyThread: TerminalApp.#onReplyThread,
      deleteThread: TerminalApp.#onDeleteThread,
      restoreThread: TerminalApp.#onRestoreThread,
      composeMessage: TerminalApp.#onComposeMessage,
      composePost: TerminalApp.#onComposePost,
      deletePost: TerminalApp.#onDeletePost,
      deleteComment: TerminalApp.#onDeleteComment,
      editPost: TerminalApp.#onEditPost,
      editComment: TerminalApp.#onEditComment,
      togglePin: TerminalApp.#onTogglePin,
      togglePostMenu: TerminalApp.#onTogglePostMenu,
      toggleReplyMenu: TerminalApp.#onToggleReplyMenu,
      toggleReveal: TerminalApp.#onToggleReveal
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/shell.hbs` }
  };

  /* Current target: a string like "main" or "crew/matthews". */
  target = null;
  #history = [];
  /* GM mailbox filter: crew member id to view the inbox AS, or null.
     Persists across inbox<->thread navigation; cleared on leaving inbox. */
  #inboxFilter = null;

  get currentTarget() {
    return this.target ?? game.settings.get(MODULE_ID, "homeScreenId");
  }

  /* Parse a target into { collection, id }.
     "crew/matthews" -> { collection: "crew", id: "matthews" }
     "missions"      -> { collection: null,  id: "missions"  } */
  static parseTarget(target) {
    // Thread view: "inbox/thread/<threadId>" -> a derived view over the
    // inbox journal (no separate journal). Special-cased before the generic
    // collection/id split, which assumes the middle segment is a collection.
    const threadMatch = /^([^/]+)\/thread\/(.+)$/.exec(target);
    if (threadMatch) {
      return { collection: null, id: threadMatch[1], view: "thread", threadId: threadMatch[2] };
    }
    if (target.includes("/")) {
      const [collection, id] = target.split("/");
      return { collection, id };
    }
    return { collection: null, id: target };
  }

  async goTo(target, { pushHistory = true } = {}) {
    if (pushHistory && this.currentTarget) this.#history.push(this.currentTarget);
    // Leaving the inbox/thread context clears the GM mailbox filter.
    if (!/^inbox(\/|$)/.test(target)) this.#inboxFilter = null;
    this.target = target;
    await this.render(false);
  }
  async goBack() {
    if (!this.#history.length) return;
    this.target = this.#history.pop();
    await this.render(false);
  }
  async goHome() {
    this.#history = [];
    this.target = null;
    await this.render(false);
  }

  clearHistory() { this.#history = []; }

  static #onNavigate(event, target) {
    const t = target?.dataset?.target;
    if (t) this.goTo(t);
  }
  static #onBack() { this.goBack(); }
  static #onHome() { this.goHome(); }

  /* Click a request's status -> popup of the board's valid statuses ->
     request the write (player: via GM socket; GM: directly). The board
     screen id and the request id ride on the clicked element. Valid
     statuses come from the current screen's sections (data-driven). */
  static async #onSetStatus(event, target) {
    event?.stopPropagation?.(); // don't trigger the row/card navigation
    const requestId = target?.dataset?.requestId;
    const screenId = target?.dataset?.screenId;
    if (!requestId || !screenId) {
      console.warn(`${MODULE_ID} | setStatus: missing requestId/screenId`, { requestId, screenId });
      return;
    }

    // Gather valid statuses from the current screen's sections.
    const res = loadScreen(screenId);
    const sections = res.ok ? (res.data.sections ?? []) : [];
    const statuses = [...new Set(sections.flatMap(s => s.statuses ?? []))];
    if (!statuses.length) {
      console.warn(`${MODULE_ID} | setStatus: no statuses resolved (screen "${screenId}")`);
      return;
    }

    const isGM = game.user.isGM;
    const { DialogV2 } = foundry.applications.api;

    const statusOptions = statuses
      .map(s => `<option value="${s}">${s}</option>`).join("");

    // GM attribution: a crew dropdown (full names) + a custom override
    // for non-crew responders. Custom text wins if filled; else the
    // selected crew member's nickname/name; else blank (no name).
    let crew = [];
    let gmFields = "";
    if (isGM) {
      crew = loadCollection("crew")
        .map(m => ({
          id: m.id,
          name: m.data?.name ?? m.id,
          display: m.data?.nickname ?? m.data?.name ?? m.id
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const crewOptions = `<option value="">— none —</option>` +
        crew.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
      gmFields = `
        <div class="form-group">
          <label>Responder (crew)</label>
          <select name="member">${crewOptions}</select>
        </div>
        <div class="form-group">
          <label>…or custom name</label>
          <input type="text" name="custom" placeholder="non-crew NPC; overrides the dropdown" />
        </div>`;
    }

    const content = `
      <div class="form-group">
        <label>New status</label>
        <select name="status">${statusOptions}</select>
      </div>
      ${gmFields}`;

    const result = await DialogV2.prompt({
      window: { title: "Update Status" },
      content,
      ok: {
        label: "Update",
        callback: (_ev, button) => {
          const form = button.form;
          return {
            status: form.elements.status.value,
            member: form.elements.member?.value || "",
            custom: form.elements.custom?.value?.trim() || ""
          };
        }
      }
    }).catch(() => null);

    if (!result) return;

    // Resolve attribution.
    let by;
    if (isGM) {
      if (result.custom) {
        by = result.custom;                         // custom override wins
      } else if (result.member) {
        const m = crew.find(x => x.id === result.member);
        by = m?.display ?? null;                     // crew member nickname/name
      } else {
        by = null;                                   // blank -> no name stored
      }
    } else {
      by = resolveSelfAuthor().author;               // player -> their bound name
    }

    await requestWrite({
      action: "setRequestStatus",
      screenId,
      requestId,
      status: result.status,
      by
    });
  }

  /* Crew picker for GM attribution. Returns { id, name } of the chosen
     crew member, or null if cancelled. Populated from the crew
     collection so NPC likes/comments stay link-correct. */
  static async #pickCrewMember(title, extraFieldHtml = "") {
    const members = loadCollection("crew")
      .map(m => ({
        id: m.id,
        name: m.data?.name ?? m.id,                          // full name: picker label
        display: m.data?.nickname ?? m.data?.name ?? m.id    // nickname: feed display
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!members.length) {
      ui.notifications?.warn("Terminal: no crew members found to attribute to.");
      return null;
    }
    const { DialogV2 } = foundry.applications.api;
    const options = members.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
    const content = `
      <div class="form-group">
        <label>As crew member</label>
        <select name="member">${options}</select>
      </div>
      ${extraFieldHtml}`;
    return DialogV2.prompt({
      window: { title },
      content,
      ok: {
        label: "Confirm",
        callback: (_ev, button) => {
          const form = button.form;
          const id = form.elements.member.value;
          const m = members.find(x => x.id === id);
          const body = form.elements.body?.value?.trim() ?? null;
          return { id, name: m?.display ?? id, body }; // name = nickname for display
        }
      }
    }).catch(() => null);
  }

  /* Like control. Player: toggles their character name. GM: crew
     picker -> toggles that NPC's name. */
  /* React to a post: up (like) or down (dislike). Direction comes from the
     clicked control's data-dir. Reactions are keyed by crew member ID
     (stable across nickname/name changes); the tooltip resolves id ->
     display name at render. Player reacts as their bound member; GM is
     prompted to pick which crew member is reacting. */
  static async #onReact(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    const dir = target?.dataset?.dir === "down" ? "down" : "up";
    if (!postId || !screenId) return;

    let memberId;
    if (game.user.isGM) {
      const picked = await TerminalApp.#pickCrewMember(dir === "down" ? "Dislike as…" : "Like as…");
      if (!picked) return;
      memberId = picked.id;
    } else {
      memberId = boundMemberId();
      if (!memberId) {
        ui.notifications?.warn("Terminal: you have no crew identity to react as.");
        return;
      }
    }

    await requestWrite({ action: "react", screenId, postId, memberId, dir });
  }

  /* Reply control: opens the standalone ComposeReplyApp for a post.
     Author mechanics (player-fixed vs GM dropdown/custom) and the
     addComment write all live in that app now. Player guard: a non-GM
     with no bound crew identity can't reply. */
  static #onAddComment(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;

    if (!game.user.isGM && !boundMemberId()) {
      ui.notifications?.warn("Terminal: you have no crew identity to reply as.");
      return;
    }

    new ComposeReplyApp({ screenId, postId }).render(true);
  }

  /* Delete a post. The button only renders when the viewer may delete it
     (GM, or the post's author); the write handler re-checks GM-side. */
  static #onDeletePost(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;
    requestWrite({ action: "deletePost", screenId, postId });
  }

  /* Delete a reply. Targets by stable replyId when present, else by index
     (legacy replies authored before ids). Handler re-checks ownership. */
  static #onDeleteComment(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;
    const replyId = target?.dataset?.replyId || null;
    const replyIndexRaw = target?.dataset?.replyIndex;
    const replyIndex = (replyIndexRaw === undefined || replyIndexRaw === "")
      ? null : Number(replyIndexRaw);
    requestWrite({ action: "deleteComment", screenId, postId, replyId, replyIndex });
  }

  /* Edit a post: open the compose window in edit mode, pre-filled with the
     current body. Author controls are hidden in edit mode; only the body
     is editable. The editPost write changes body only + sets edited:true. */
  static #onEditPost(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;

    const res = loadScreen(screenId);
    const posts = res.ok ? (res.data.posts ?? []) : [];
    const post = posts.find(p => p.id === postId);
    if (!post) { ui.notifications?.warn("Terminal: post not found."); return; }

    new ComposePostApp({
      screenId,
      mode: "edit",
      editPostId: postId,
      initialBody: post.body ?? ""
    }).render(true);
  }

  /* Edit a reply: open the reply window in edit mode, pre-filled. */
  static #onEditComment(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;
    const replyId = target?.dataset?.replyId || null;
    const replyIndexRaw = target?.dataset?.replyIndex;
    const replyIndex = (replyIndexRaw === undefined || replyIndexRaw === "")
      ? null : Number(replyIndexRaw);

    const res = loadScreen(screenId);
    const posts = res.ok ? (res.data.posts ?? []) : [];
    const post = posts.find(p => p.id === postId);
    const replies = post && Array.isArray(post.replies) ? post.replies : [];
    let reply = replyId ? replies.find(r => r.id === replyId) : null;
    if (!reply && replyIndex != null && replyIndex >= 0 && replyIndex < replies.length) {
      reply = replies[replyIndex];
    }
    if (!reply) { ui.notifications?.warn("Terminal: reply not found."); return; }

    new ComposeReplyApp({
      screenId,
      postId,
      mode: "edit",
      editReplyId: replyId,
      editReplyIndex: replyIndex,
      initialBody: reply.body ?? ""
    }).render(true);
  }

  /* Pin / unpin a post. Visibility gated by canPin (feedPinAuthority);
     the handler re-checks GM-side. */
  static #onTogglePin(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;
    requestWrite({ action: "togglePin", screenId, postId });
  }

  /* Owner-menu open/close (post). Pure UI: toggle an `open` class on the
     menu, closing any other open menus first. No write. */
  static #onTogglePostMenu(event, target) {
    event?.stopPropagation?.();
    TerminalApp.#toggleMenu(target, ".post-menu");
  }
  static #onToggleReplyMenu(event, target) {
    event?.stopPropagation?.();
    TerminalApp.#toggleMenu(target, ".reply-menu");
  }

  /* Shared menu toggle: close other open menus in this app, toggle this
     one. A document-level click (wired in _onRender) closes menus when
     clicking elsewhere. */
  static #toggleMenu(trigger, menuSelector) {
    const menu = trigger.closest(menuSelector);
    if (!menu) return;
    const root = menu.closest(".terminal-app") ?? document;
    const wasOpen = menu.classList.contains("open");
    root.querySelectorAll(`${menuSelector}.open`).forEach(m => m.classList.remove("open"));
    if (!wasOpen) menu.classList.add("open");
  }

  /* Open a thread -> mark the whole thread read for the viewer. Fired by
     the thread-head element on the thread detail screen. */
  static #onOpenThread(event, target) {
    const threadId = target?.dataset?.threadId;
    const screenId = target?.dataset?.screenId;
    if (!threadId || !screenId) return;
    const memberId = boundMemberId();
    if (!memberId) return; // GM or unbound: nothing to mark
    suppressReadRender();  // don't let this client re-render mid-read
    requestWrite({ action: "readThread", screenId, threadId, memberId });
  }

  /* Reply within a thread: open ComposeMessageApp in reply mode. Recipients
     default to the thread's newest-message participants minus the viewer
     (editable); subject is the thread subject, shown but locked; the send
     carries the thread's id + inReplyTo so it nests. */
  static #onReplyThread(event, target) {
    event?.stopPropagation?.();
    const screenId = target?.dataset?.screenId;
    const threadId = target?.dataset?.threadId;
    if (!screenId || !threadId) return;

    if (!game.user.isGM && !boundMemberId()) {
      ui.notifications?.warn("Terminal: you have no mailbox identity to reply from.");
      return;
    }

    const replyTo = (target?.dataset?.replyTo || "").split(",").filter(Boolean);
    new ComposeMessageApp({
      screenId,
      mode: "reply",
      threadId,
      inReplyTo: threadId,                 // reply attaches to the thread root id
      prefillToIds: replyTo,               // editable, prefilled recipients
      lockedSubject: target?.dataset?.subject || ""
    }).render(true);
  }

  /* GM mailbox filter: set which crew member's mailbox to view (or All).
     Fired by the inbox filter dropdown (change). Value "" clears the
     filter. Instance state, so it survives the re-render. */
  static #onFilterInbox(event, target) {
    if (!game.user.isGM) return;
    const memberId = target?.value || target?.dataset?.memberId || "";
    this.#inboxFilter = memberId || null;
    this.render(false);
  }

  /* Delete a thread from the viewer's mailbox (move to Trash). Inbox-row
     control; stops propagation so it doesn't navigate into the thread. */
  static #onDeleteThread(event, target) {
    event?.stopPropagation?.();
    const threadId = target?.dataset?.threadId;
    const screenId = target?.dataset?.screenId;
    if (!threadId || !screenId) return;
    const memberId = boundMemberId();
    if (!memberId) return; // GM/unbound: no personal mailbox to delete from
    requestWrite({ action: "deleteThread", screenId, threadId, memberId });
  }

  /* Restore a trashed thread back to the viewer's inbox. */
  static #onRestoreThread(event, target) {
    event?.stopPropagation?.();
    const threadId = target?.dataset?.threadId;
    const screenId = target?.dataset?.screenId;
    if (!threadId || !screenId) return;
    const memberId = boundMemberId();
    if (!memberId) return;
    requestWrite({ action: "restoreThread", screenId, threadId, memberId });
  }

  /* GM toggles a datapad block's revealed state. */
  static #onToggleReveal(event, target) {
    event?.stopPropagation?.();
    if (!game.user.isGM) return;
    const collection = target?.dataset?.collection;
    const memberId = target?.dataset?.memberId;
    const blockId = target?.dataset?.blockId;
    if (!collection || !memberId || !blockId) return;
    requestWrite({ action: "toggleReveal", collection, memberId, blockId });
  }

    /* Compose: opens the standalone ComposeMessageApp. FROM/TO/subject/
     body collection + the sendMessage write all live in that app now.
     A reply click carries prefill (member id + "Re: ..." subject) on
     the element; a fresh compose carries none.
 
     Player guard: a non-GM with no bound mailbox identity can't compose;
     we warn here so the window never opens empty. */
  static #onComposeMessage(event, target) {
    event?.stopPropagation?.();
    const screenId = target?.dataset?.screenId;
    if (!screenId) return;
 
    if (!game.user.isGM && !boundMemberId()) {
      ui.notifications?.warn("Terminal: you have no mailbox identity to send from.");
      return;
    }
 
    new ComposeMessageApp({
      screenId
      // Fresh compose: no prefill. Replies are handled separately by
      // #onReplyThread (ComposeMessageApp reply mode). sendMessage updates
      // the journal; the updateJournalEntry hook re-renders open terminals.
    }).render(true);
  }

  /* Open the "new post" window for a feed screen. Player guard mirrors
     compose: a non-GM with no bound crew identity can't post. The addPost
     write re-renders open terminals via the journal hook, so no callback. */
  static #onComposePost(event, target) {
    event?.stopPropagation?.();
    const screenId = target?.dataset?.screenId;
    if (!screenId) return;

    if (!game.user.isGM && !boundMemberId()) {
      ui.notifications?.warn("Terminal: you have no crew identity to post as.");
      return;
    }

    new ComposePostApp({ screenId }).render(true);
  }

  /* After each render: wire a one-shot document click that closes any open
     feed owner-menus when the user clicks outside a menu. Re-bound each
     render (the element is replaced); we namespace by storing the handler
     so we can detach the previous one. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this.#menuOutsideHandler) {
      document.removeEventListener("click", this.#menuOutsideHandler, true);
    }
    this.#menuOutsideHandler = (ev) => {
      // If the click is on a menu trigger or inside a menu, leave it; the
      // action handler manages those. Otherwise close all open menus.
      if (ev.target?.closest?.(".post-menu, .reply-menu")) return;
      this.element?.querySelectorAll?.(".post-menu.open, .reply-menu.open")
        .forEach(m => m.classList.remove("open"));
    };
    document.addEventListener("click", this.#menuOutsideHandler, true);

    // GM mailbox filter dropdown (a <select>; actions are click-bound, so
    // wire its change event here).
    const filterSel = this.element?.querySelector?.(".inbox-filter-select");
    if (filterSel) {
      filterSel.addEventListener("change", (ev) => {
        TerminalApp.#onFilterInbox.call(this, ev, ev.target);
      });
    }
  }

  #menuOutsideHandler = null;

  /* Detach the outside-click handler when the app closes. */
  _onClose(options) {
    if (this.#menuOutsideHandler) {
      document.removeEventListener("click", this.#menuOutsideHandler, true);
      this.#menuOutsideHandler = null;
    }
    super._onClose?.(options);
  }


  async _prepareContext(_options) {
    const themeClass = game.settings.get(MODULE_ID, "themeClass");
    const target = this.currentTarget;
    const { collection, id, view, threadId } = TerminalApp.parseTarget(target);
    const homeId = game.settings.get(MODULE_ID, "homeScreenId");

    const base = {
      themeClass,
      canGoBack: this.#history.length > 0,
      isHome: target === homeId
    };

    /* Collection member target (e.g. crew/matthews, missions/dark-horizon):
       load that member, render with its own render type. For members
       that participate in parent/child relations (missions), derive the
       parent's display name and the child list from the collection (one
       in-memory filter over the already-loaded set). */
    if (collection) {
      const res = loadMember(collection, id);
      if (!res.ok) return { ...base, error: res.error };
      const screen = res.data;
      const renderType = screen.render ?? null;
      const renderTemplate = RENDER_TEMPLATES[renderType] ?? null;

      let parent = null;
      let children = null;
      if (screen.parent || renderType === "mission") {
        const all = loadCollection(collection)
          .map(m => ({ id: m.id, collection, ...m.data }));
        // children: anyone claiming THIS member as their parent
        children = all
          .filter(m => m.parent === id)
          .map(m => ({ target: `${collection}/${m.id}`, name: m.name ?? m.title ?? m.id, status: m.status }));
        // parent: resolve this member's declared parent for a display name
        if (screen.parent) {
          const p = all.find(m => m.id === screen.parent);
          parent = {
            target: `${collection}/${screen.parent}`,
            name: p ? (p.name ?? p.title ?? screen.parent) : screen.parent
          };
        }
      }

      let datapad = null;
      if (renderType === "datapad") {
        datapad = TerminalApp.#prepDatapad(screen, collection, id);
      }

      let location = null;
      if (renderType === "location") {
        location = TerminalApp.#prepLocation(screen, collection, id);
      }

      return {
        ...base,
        error: null,
        screen,
        member: { collection, id },
        parent,
        children: (children && children.length) ? children : null,
        datapad,
        location,
        renderType,
        renderTemplate,
        unknownRender: !renderTemplate
      };
    }

    /* Standalone screen target. */
    const res = loadScreen(id);
    if (!res.ok) return { ...base, error: res.error };
    const screen = res.data;
    const renderType = screen.render ?? "hub";
    const renderTemplate = RENDER_TEMPLATES[renderType] ?? null;

    /* If this screen draws from a collection, load + structure its
       members for the partial. Roster groups by department; board
       groups by status-section. Both produce ordered groups the
       partial just renders. */
    let groups = null;
    if (screen.collection) {
      const members = loadCollection(screen.collection)
        .map(m => ({ id: m.id, collection: screen.collection, ...m.data }));

      if (renderType === "mission-board") {
        groups = TerminalApp.#groupByStatus(members, screen.sections ?? []);
      } else if (renderType === "datapad-directory") {
        groups = TerminalApp.#prepDatapadDirectory(members);
      } else if (renderType === "location-directory") {
        groups = TerminalApp.#prepLocationDirectory(members);
      } else {
        groups = TerminalApp.#groupRoster(members, screen.departments ?? []);
      }
    }

    /* Black box: derive the "current" entry (flagged, else last) and
       build it as labeled fields for the callout. */
    let blackbox = null;
    if (renderType === "blackbox") {
      blackbox = TerminalApp.#prepBlackbox(screen);
    }

    /* Feed: compose the like-line string per post and resolve author
       link targets, so the template stays declarative. */
    let feed = null;
    if (renderType === "feed") {
      feed = TerminalApp.#prepFeed(screen, id);
    }

    /* Request board (requisitions / crew requests): group the screen's
       requests array into declared status-sections, date descending. */
    let requestBoard = null;
    if (renderType === "request-board") {
      requestBoard = TerminalApp.#prepRequestBoard(screen, id);
    }

    let inbox = null;
    let thread = null;
    let headerOverride = null;
    let effectiveRenderType = renderType;
    let effectiveTemplate = renderTemplate;
    if (renderType === "inbox") {
      // GM mailbox filter (instance state): view the inbox/thread as a
      // chosen crew member. Ignored for non-GM and cleared when leaving.
      const asMemberId = game.user.isGM ? (this.#inboxFilter ?? null) : null;
      if (view === "thread" && threadId) {
        // Thread detail: a derived view over this same inbox journal.
        thread = TerminalApp.#prepThread(screen, threadId, id, asMemberId);
        effectiveRenderType = "thread";
        effectiveTemplate = RENDER_TEMPLATES["thread"] ?? null;
        // Header breadcrumb so the chrome itself signals "inside a thread":
        // "THREAD › <subject>" (+ "as <member>" when GM-filtering).
        headerOverride = {
          title: `THREAD  ›  ${thread.subject}`,
          tag: thread.filteredAs ? `AS ${thread.filteredAs}` : null
        };
      } else {
        inbox = TerminalApp.#prepInbox(screen, id, asMemberId);
      }
    }

    return {
      ...base,
      error: null,
      screen,
      groups,
      blackbox,
      feed,
      requestBoard,
      inbox,
      thread,
      headerOverride,
      renderType: effectiveRenderType,
      renderTemplate: effectiveTemplate,
      unknownRender: !effectiveTemplate
    };
  }

  async _preFirstRender(context, options) {
    await super._preFirstRender?.(context, options);
    const hb = foundry.applications.handlebars;
    // Load render partials (used via dynamic lookup in shell.hbs).
    await hb.loadTemplates(Object.values(RENDER_TEMPLATES));
    // Register the shared status-flag partial under a stable name.
    await hb.loadTemplates({
      terminalStatusFlag: `modules/${MODULE_ID}/templates/partials/status-flag.hbs`,
      terminalFeedPost: `modules/${MODULE_ID}/templates/partials/feed-post.hbs`
    });
  }

  /* Sortable key from a date string. Handles ISO ("2186-10-28") and
     short forms ("28 Oct", "28 October 2186"). Short forms without a
     year are parsed against a fixed reference year so month/day order
     is consistent within a board. Unparseable -> -Infinity (sorts last
     in descending). */
  static #dateSortKey(raw) {
    if (!raw) return -Infinity;
    let t = Date.parse(raw);
    if (!Number.isNaN(t)) return t;
    // try "<day> <Mon>" by appending a reference year
    t = Date.parse(`${raw} 2186`);
    return Number.isNaN(t) ? -Infinity : t;
  }

  /* Build inbox render data for the current viewer.
     - Messages whose `to` includes the viewer's member id, OR a
       department the viewer belongs to, are "received" (Inbox).
     - Messages whose `from` is the viewer are "sent" (Sent).
     - GM sees ALL messages as Inbox.
     - Sender/recipient ids resolve to display names from crew; a
       department token displays as the department name as-is.
     - read: array of member ids who've read it; unread = viewer absent.
     Sorted newest first. */
  /* Shared inbox helpers: crew lookup + viewer identity. Returns the
     name resolver, recipient resolver, and the viewer's id/department. */
  /* Shared inbox context. `asMemberId` lets the GM view the inbox as a
     specific crew member (the mailbox filter): visibility/read/delete all
     resolve from that member's perspective, while `isGM` stays true so
     write controls remain gated off in the GM view. Without it: a player
     views as their bound member; the GM (no override) sees everything. */
  static #inboxContext(asMemberId = null) {
    const crew = loadCollection("crew");
    const byId = new Map(crew.map(m => [m.id, {
      name: m.data?.name ?? m.id,
      department: m.data?.department ?? null
    }]));
    const nameOf = (id) => byId.get(id)?.name ?? id;          // dept names pass through
    const resolveRecipients = (to) =>
      (Array.isArray(to) ? to : []).map(r => ({ id: r, label: nameOf(r) }));
    const isGM = game.user.isGM;

    // Identity we render the mailbox AS.
    let viewerId, viewerDept, filteredAs;
    if (isGM && asMemberId) {
      viewerId = asMemberId;                                  // GM impersonating a mailbox
      viewerDept = byId.get(asMemberId)?.department ?? null;
      filteredAs = byId.get(asMemberId)?.name ?? asMemberId;
    } else {
      viewerId = isGM ? null : boundMemberId();               // GM=all, player=bound
      viewerDept = viewerId ? (byId.get(viewerId)?.department ?? null) : null;
      filteredAs = null;
    }
    // `seeAll` is the GM admin pass-through (all threads); only when the GM
    // is NOT filtering to a specific member.
    const seeAll = isGM && !asMemberId;
    return { byId, nameOf, resolveRecipients, isGM, viewerId, viewerDept, seeAll, filteredAs };
  }

  /* Whether `m` is visible in the current context (GM admin sees all;
     otherwise recipient, department, or sender from the viewed identity). */
  static #msgVisible(m, ctx) {
    if (ctx.seeAll) return true;
    const toList = Array.isArray(m.to) ? m.to : [];
    if (ctx.viewerId && toList.includes(ctx.viewerId)) return true;        // direct
    if (ctx.viewerDept && toList.includes(ctx.viewerDept)) return true;    // department
    return m.from === ctx.viewerId;                                        // sender
  }

  /* Build inbox render data as a list of THREADS for the current viewer.
     Messages live on the inbox screen JSON as `messages: [...]`; thread
     read-state lives in `threads: { "<threadId>": { read: [memberId] } }`.
     A thread row aggregates the viewer's visible messages sharing a
     threadId: subject (from the root), participant names, newest visible
     wt, message count, and unread = the viewer is NOT in threads.read.
     Clicking a row navigates to inbox/thread/<threadId>. */
  static #prepInbox(screen, screenId, asMemberId = null) {
    const messages = Array.isArray(screen.messages) ? screen.messages : [];
    const threadsMeta = (screen.threads && typeof screen.threads === "object") ? screen.threads : {};
    const ctx = TerminalApp.#inboxContext(asMemberId);

    // Group the viewer's visible messages by threadId.
    const groups = new Map();
    for (const m of messages) {
      if (!TerminalApp.#msgVisible(m, ctx)) continue;
      const tid = m.threadId ?? m.id;     // legacy messages: own id is the thread
      if (!groups.has(tid)) groups.set(tid, []);
      groups.get(tid).push(m);
    }

    const threads = [];
    for (const [tid, msgs] of groups) {
      // Root = the message whose id is the threadId, else earliest by wt.
      const root = msgs.find(m => m.id === tid)
        ?? [...msgs].sort((a, b) => (a.wt ?? Infinity) - (b.wt ?? Infinity))[0];
      const newestWt = msgs.reduce((mx, m) => Math.max(mx, m.wt ?? -Infinity), -Infinity);

      // Participants = union of all from + to across visible messages,
      // resolved to names (departments pass through), minus duplicates.
      const ids = new Set();
      for (const m of msgs) {
        if (m.from) ids.add(m.from);
        for (const r of (Array.isArray(m.to) ? m.to : [])) ids.add(r);
      }
      const participants = [...ids].map(id => ctx.nameOf(id));

      const read = Array.isArray(threadsMeta[tid]?.read) ? threadsMeta[tid].read : [];
      const unread = ctx.viewerId ? !read.includes(ctx.viewerId) : false;
      const deleted = Array.isArray(threadsMeta[tid]?.deleted) ? threadsMeta[tid].deleted : [];
      // GM view ignores per-user delete (admin sees everything).
      const isTrashed = ctx.viewerId ? deleted.includes(ctx.viewerId) : false;

      threads.push({
        threadId: tid,
        screenId,
        subject: root?.subject ?? "(no subject)",
        participants,
        participantLine: participants.join(", "),
        count: msgs.length,
        wt: Number.isFinite(newestWt) ? newestWt : null,
        time: Number.isFinite(newestWt) ? formatWorldTime(newestWt) : "",
        unread,
        isTrashed
      });
    }

    // Newest-active thread first.
    threads.sort((a, b) => (b.wt ?? -Infinity) - (a.wt ?? -Infinity));
    // Split active vs trashed (trashed only ever true for a bound viewer).
    const active = threads.filter(t => !t.isTrashed);
    const trashed = threads.filter(t => t.isTrashed);
    const unreadCount = active.filter(t => t.unread).length;

    // GM mailbox filter: a crew dropdown so the GM can view any member's
    // mailbox. Only built for the GM; the selected member (if any) is
    // flagged so the template can mark it active.
    let filterCrew = null;
    if (ctx.isGM) {
      filterCrew = [...ctx.byId.entries()]
        .map(([id, m]) => ({ id, name: m.name, selected: id === asMemberId }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      isGM: ctx.isGM,
      screenId,
      hasBinding: ctx.isGM || !!ctx.viewerId,
      canCompose: ctx.isGM || !!ctx.viewerId,
      threads: active,                // back-compat: the visible (non-trashed) list
      trashed,
      trashCount: trashed.length,
      hasTrash: trashed.length > 0,
      unreadCount,
      // GM filter
      filterCrew,
      filteredAs: ctx.filteredAs,     // name of the member being viewed, or null
      filterMemberId: asMemberId
    };
  }

  /* Build the thread detail view: every message in `threadId` the viewer
     can see, oldest-first (reading order). Subject comes from the root.
     reply defaults are computed per-message in the template via data
     attributes; the thread carries the participant set for the composer. */
  static #prepThread(screen, threadId, screenId, asMemberId = null) {
    const messages = Array.isArray(screen.messages) ? screen.messages : [];
    const ctx = TerminalApp.#inboxContext(asMemberId);

    const msgs = messages
      .filter(m => (m.threadId ?? m.id) === threadId && TerminalApp.#msgVisible(m, ctx))
      .map(m => ({
        ...m,
        screenId,
        threadId,
        wt: Number.isFinite(m.wt) ? m.wt : null,
        time: Number.isFinite(m.wt) ? formatWorldTime(m.wt) : (m.time ?? ""),
        fromLabel: ctx.nameOf(m.from),
        fromId: m.from,
        toLabels: ctx.resolveRecipients(m.to),
        // Reply default: this message's participants (from + to) minus the
        // viewer. Passed to the composer as a comma list of ids.
        replyToIds: [m.from, ...(Array.isArray(m.to) ? m.to : [])]
          .filter(x => x && x !== ctx.viewerId)
      }))
      .sort((a, b) => (a.wt ?? Infinity) - (b.wt ?? Infinity));   // oldest-first

    const root = msgs.find(m => m.id === threadId) ?? msgs[0] ?? null;
    const subject = root?.subject ?? "(no subject)";

    // The newest visible message drives the default reply target + the
    // thread reply button's prefill.
    const newest = msgs[msgs.length - 1] ?? null;
    const replyToIds = newest ? newest.replyToIds : [];

    return {
      screenId,
      threadId,
      subject,
      messages: msgs,
      countLabel: `${msgs.length} message${msgs.length === 1 ? "" : "s"}`,
      empty: msgs.length === 0,
      canCompose: ctx.isGM || !!ctx.viewerId,
      replyToCsv: replyToIds.join(","),
      isGM: ctx.isGM,
      filteredAs: ctx.filteredAs
    };
  }


  /* Group the screen's requests array into the declared status-sections
     (same section model as the mission board), date descending within
     each. Unmatched statuses go to a fallback "OTHER" section. */
  static #prepRequestBoard(screen, screenId) {
    const requests = Array.isArray(screen.requests) ? screen.requests : [];
    const sections = Array.isArray(screen.sections) ? screen.sections : [];
    const cardClass = screen.cardClass ?? ""; // e.g. "req-mission" for crew requests

    const byDateDesc = (a, b) =>
      TerminalApp.#dateSortKey(b.date) - TerminalApp.#dateSortKey(a.date) ||
      String(a.title ?? "").localeCompare(String(b.title ?? ""));

    const decorate = (r, dim) => ({ ...r, cardClass, dim, screenId });
    const claimed = new Set();
    const groups = [];

    for (const sec of sections) {
      const statuses = new Set(sec.statuses ?? []);
      const matched = requests.filter(r => statuses.has(r.status));
      matched.forEach(r => claimed.add(r));
      groups.push({
        name: sec.name,
        dim: sec.dim === true,
        requests: matched.map(r => decorate(r, sec.dim === true)).sort(byDateDesc)
      });
    }

    const leftover = requests.filter(r => !claimed.has(r));
    if (leftover.length) {
      groups.push({
        name: "OTHER",
        dim: false,
        requests: leftover.map(r => decorate(r, false)).sort(byDateDesc)
      });
    }

    return { groups };
  }

  /* Number of reactor names shown in a tooltip before "+ X more". */
  static REACTION_NAMES_SHOWN = 12;

  /* Reactions are stored as a single map keyed by crew member ID:
       { "byas": "up", "markov": "down", ... }
     One entry per member enforces "like XOR dislike" structurally, and id
     keys survive nickname/name changes. This derives the render data from
     that map (plus back-compat with the old `likes` name-array and the
     interim name-keyed `reactions` map — see #resolveReactor).

     Returns:
       up / down            : counts
       upNames / downNames  : resolved display names (for hover tooltips)
       upTip / downTip      : pre-joined tooltip strings (truncated)
       mineUp / mineDown    : whether the current viewer holds that reaction
     `viewerId` is the current user's bound member id (null for the GM,
     whose reaction identity is chosen per-click). */
  static #reactionData(post, viewerId) {
    // Normalize source into an id/key -> dir map.
    let map = {};
    if (post.reactions && typeof post.reactions === "object") {
      map = post.reactions;
    } else if (Array.isArray(post.likes)) {
      for (const n of post.likes) if (n) map[n] = "up";   // legacy name-array -> up
    }

    // Build a crew id -> display(nickname||name) lookup once.
    const crew = loadCollection("crew");
    const display = (key) => {
      const m = crew.find(c => c.id === key);
      if (m) return m.data?.nickname ?? m.data?.name ?? key;
      return key;   // legacy/name-keyed entries: key is already a name
    };

    const upNames = [];
    const downNames = [];
    for (const [key, dir] of Object.entries(map)) {
      if (dir === "up") upNames.push(display(key));
      else if (dir === "down") downNames.push(display(key));
    }

    const tip = (names) => {
      if (!names.length) return "";
      const N = TerminalApp.REACTION_NAMES_SHOWN;
      if (names.length <= N) return names.join(", ");
      return `${names.slice(0, N).join(", ")} + ${names.length - N} more`;
    };

    const mineDir = viewerId ? (map[viewerId] ?? null) : null;
    return {
      up: upNames.length,
      down: downNames.length,
      upNames,
      downNames,
      upTip: tip(upNames),
      downTip: tip(downNames),
      mineUp: mineDir === "up",
      mineDown: mineDir === "down"
    };
  }

  /* Build feed render data:
       - format each post/reply's display time from its stored sortable
         `wt` (worldTime); fall back to a legacy `time` string if present.
       - sort newest-first by `wt`, with pinned posts floated to the top.
       - partition into `recent` and `archived` (older than feedArchiveDays
         in-world days); pinned posts are never archived.
       - per-post / per-reply capability flags drive the owner menu:
           canEdit/canDelete = GM, or the item's author (bound member).
           canPin            = per feedPinAuthority setting.
     Replies may carry a stable `id`; legacy replies fall back to index. */
  static #prepFeed(screen, screenId) {
    const posts = Array.isArray(screen.posts) ? screen.posts : [];
    const isGM = game.user.isGM;
    const selfId = isGM ? null : boundMemberId();
    const mine = (authorId) => isGM || (!!selfId && authorId === selfId);
    // The viewer's bound member id (for highlighting their own reaction).
    // Null for the GM (no fixed reaction identity; chosen per-click).
    const viewerId = selfId;

    const decorate = (p) => {
      const wt = Number.isFinite(p.wt) ? p.wt : null;
      const reactions = TerminalApp.#reactionData(p, viewerId);
      return {
        ...p,
        screenId,
        wt,
        time: wt != null ? formatWorldTime(wt) : (p.time ?? ""),
        pinned: !!p.pinned,
        reactions,                          // { up, down, upNames, downNames, upTip, downTip, mine }
        canEdit: mine(p.authorId),
        canDelete: mine(p.authorId),
        canPin: canPinOrNotice(game.user, p.authorId),
        hasMenu: mine(p.authorId) || canPinOrNotice(game.user, p.authorId),
        replies: (Array.isArray(p.replies) ? p.replies : []).map((r, i) => {
          const rwt = Number.isFinite(r.wt) ? r.wt : null;
          return {
            ...r,
            replyId: r.id ?? null,
            replyIndex: i,
            time: rwt != null ? formatWorldTime(rwt) : (r.time ?? ""),
            canEdit: mine(r.authorId),
            canDelete: mine(r.authorId),
            hasMenu: mine(r.authorId)
          };
        })
      };
    };

    const decorated = posts.map(decorate);

    // Sort: pinned first, then newest-first by wt. Posts without a wt
    // (shouldn't happen on fresh data) sort oldest.
    const byRecency = (a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.wt ?? -Infinity) - (a.wt ?? -Infinity);
    };
    decorated.sort(byRecency);

    // Archive partition. feedArchiveDays = 0 disables archiving.
    let archiveDays = 7;
    try { archiveDays = Number(game.settings.get(MODULE_ID, "feedArchiveDays")) ?? 7; } catch { /* default */ }

    let recent = decorated;
    let archived = [];
    const now = terminalWorldTime();
    // Fail-safe: if the world clock reads 0 (calendar not initialized) or is
    // somehow before the newest post, "now" is unreliable — don't hide
    // anything. Archiving only kicks in once there's a sane clock ahead of
    // the content.
    const newestWt = decorated.reduce((mx, p) => Math.max(mx, p.wt ?? -Infinity), -Infinity);
    const clockUsable = now > 0 && now >= newestWt;
    if (archiveDays > 0 && clockUsable) {
      const cutoff = now - archiveDays * secondsPerDay();
      recent = [];
      for (const p of decorated) {
        // Pinned posts never archive; posts with no wt stay visible.
        if (p.pinned || p.wt == null || p.wt >= cutoff) recent.push(p);
        else archived.push(p);
      }
    }

    return {
      posts: recent,            // back-compat: existing template iterates feed.posts
      recent,
      archived,
      hasArchive: archived.length > 0,
      archiveCount: archived.length,
      screenId
    };
  }

  /* Build black-box render data from a blackbox screen.
     - columns: ordered column names (screen.columns, else union of
       keys across the log).
     - currentFields: the current entry as labeled {label,value} pairs
       for the callout (all columns). current = entry flagged
       current:true, else the LAST entry.
     - rows: every entry as { cells:[...], current:bool } aligned to
       columns, so the table highlights the current row. */
  static #prepBlackbox(screen) {
    const log = Array.isArray(screen.log) ? screen.log : [];
    let columns = Array.isArray(screen.columns) ? screen.columns.slice() : [];
    if (!columns.length) {
      const seen = new Set();
      for (const e of log) for (const k of Object.keys(e)) {
        if (k !== "current" && !seen.has(k)) { seen.add(k); columns.push(k); }
      }
    }

    let currentIdx = log.findIndex(e => e.current === true);
    if (currentIdx === -1) currentIdx = log.length - 1;

    const cellFor = (e, c) => ({
      value: e[c] ?? "",
      locId: (e.links && typeof e.links === "object") ? (e.links[c] ?? null) : null
    });

    const rows = log.map((e, i) => ({
      cells: columns.map(c => cellFor(e, c)),
      current: i === currentIdx
    }));

    const currentEntry = log[currentIdx] ?? null;
    const currentFields = currentEntry
      ? columns.map(c => ({ label: c, value: currentEntry[c] ?? "", locId: (currentEntry.links?.[c] ?? null) }))
      : [];

    return { columns, rows, currentFields, hasCurrent: !!currentEntry };
  }

  /* Flat directory of datapads: limited header info, each navigates to
     its detail. Returned as a single group for the directory template. */
  static #prepDatapadDirectory(members) {
    const rows = members
      .map(m => ({
        target: `${m.collection}/${m.id}`,
        title: m.title ?? m.id,
        tag: m.tag ?? "",
        source: m.source ?? "",
        date: m.date ?? ""
      }))
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return [{ name: null, rows }];
  }

  /* Datapad detail: walk blocks, resolve secret/reveal per viewer.
     - secret:true block is hidden from players unless its id is in the
       datapad's `revealed` array.
     - GM sees all blocks; secret ones are marked + get a reveal toggle.
     Each block gets a stable id (b.id or fallback `b<index>`) for
     reveal targeting. */
  static #prepDatapad(screen, collection, id) {
    const isGM = game.user.isGM;
    const blocks = Array.isArray(screen.blocks) ? screen.blocks : [];
    const revealed = new Set(Array.isArray(screen.revealed) ? screen.revealed : []);

    const out = [];
    blocks.forEach((b, i) => {
      const blockId = b.id ?? `b${i}`;
      const isSecret = b.secret === true;
      const isRevealed = revealed.has(blockId);

      // Player + secret + not revealed: emit a PLACEHOLDER (locked bar)
      // instead of the content, so they know data exists to uncover.
      if (!isGM && isSecret && !isRevealed) {
        out.push({
          blockId,
          isSecret: true,
          isRevealed: false,
          isPlaceholder: true,
          // Optional author-set hint label for what's locked here.
          lockLabel: b.lockLabel ?? b.label ?? null
        });
        return;
      }

      out.push({
        ...b,
        blockId,
        isSecret,
        isRevealed,
        isPlaceholder: false,
        showToggle: isGM && isSecret
      });
    });

    return { blocks: out, isGM, memberTarget: `${collection}/${id}`, collection, memberId: id };
  }

  /* Location directory: list the top-tier regions. */
  static #prepLocationDirectory(members) {
    const rows = members
      .filter(m => m.tier === "region")
      .map(m => ({ target: `${m.collection}/${m.id}`, name: m.name ?? m.id, summary: TerminalApp.#locSummary(m) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return [{ name: null, rows }];
  }

  /* One-line teaser for location index tables: explicit `summary` if
     authored, else the first sentence of the description, else a
     character-truncated description. Keeps directory/children tables
     scannable instead of dumping the full description. */
  static #locSummary(m) {
    if (m.summary) return m.summary;
    const desc = String(m.description ?? "").trim();
    if (!desc) return "";
    const sentence = desc.match(/^.*?[.!?](?=\s|$)/);
    let s = sentence ? sentence[0] : desc;
    if (s.length > 140) s = s.slice(0, 137).trimEnd() + "…";
    return s;
  }

  /* Location detail: one render type for all tiers (region/cluster/
     system/body). Derives this entity's CHILDREN (collection members
     whose parent === this id) for the table, and builds the PARENT
     BREADCRUMB chain by walking up via parent links. The child tier
     label is derived for the table header. */
  /* War-status severity ranking (higher = more severe). Used to derive
     a parent's effective status from its worst descendant. Unlisted /
     "clear" states rank 0 (no tag). */
  static #WAR_SEVERITY = {
    "liberated": 1,
    "evacuated": 2,
    "contested": 3,
    "under assault": 4,
    "occupied": 5
  };

  static #warRank(status) {
    if (!status) return 0;
    return TerminalApp.#WAR_SEVERITY[String(status).toLowerCase()] ?? 0;
  }

  /* Effective war status for a location:
       - direct: the location's own warStatus (if any)
       - derived: the most severe warStatus among ALL descendants
     Returns { status, direct } where `direct` is true if the location
     itself is flagged, false if the status is inherited from below,
     null status if nothing is flagged anywhere in the subtree.
     `childrenOf` maps a parent id -> array of child member objects. */
  /* Effective war status for a location, with bidirectional inheritance:
       - direct: the location's OWN warStatus always wins for itself.
       - down: a flagged ancestor (up to the cluster ceiling) flows DOWN
         to descendants.
       - up: a flagged descendant flows UP to ancestors, but only as far
         as the CLUSTER tier — regions never inherit (clusters are vast
         and independent; a conflict in one cluster doesn't endanger
         sibling clusters or color the whole region).
     Returns { status, direct }: direct=true if the location is itself
     flagged; false if inherited (either direction); null if nothing
     applies. `byId` resolves ancestors; `childrenOf` resolves descendants. */
  static #effectiveWar(member, childrenOf, byId) {
    // A region is above the propagation ceiling — it shows only its own
    // explicit status, never inherited.
    const own = member.warStatus ?? null;
    const ownRank = TerminalApp.#warRank(own);
    if (member.tier === "region") {
      return ownRank > 0 ? { status: own, direct: true } : { status: null, direct: false };
    }

    // Own status always wins for the location itself.
    if (ownRank > 0) return { status: own, direct: true };

    let worst = null, worstRank = 0;
    const consider = (status) => {
      const r = TerminalApp.#warRank(status);
      if (r > worstRank) { worstRank = r; worst = status; }
    };

    // DOWN: worst status among all descendants.
    const stack = [...(childrenOf.get(member.id) ?? [])];
    const seen = new Set();
    while (stack.length) {
      const m = stack.pop();
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      consider(m.warStatus);
      for (const c of (childrenOf.get(m.id) ?? [])) stack.push(c);
    }

    // UP: walk ancestors, but stop AT the cluster (don't read region).
    // A flagged system/cluster above this body/system flows down to it.
    let cur = member.parent ? byId.get(member.parent) : null;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      if (cur.tier === "region") break;       // ceiling: regions don't propagate
      consider(cur.warStatus);
      if (cur.tier === "cluster") break;       // cluster is the topmost source
      cur = cur.parent ? byId.get(cur.parent) : null;
    }

    if (worstRank === 0) return { status: null, direct: false };
    return { status: worst, direct: false };
  }

  static #prepLocation(screen, collection, id) {
    const all = loadCollection(collection)
      .map(m => ({ id: m.id, collection, ...m.data }));
    const byId = new Map(all.map(m => [m.id, m]));

    // Parent -> children index, for war-status derivation up the tree.
    const childrenOf = new Map();
    for (const m of all) {
      if (!m.parent) continue;
      if (!childrenOf.has(m.parent)) childrenOf.set(m.parent, []);
      childrenOf.get(m.parent).push(m);
    }

    // This location's own effective war status (direct or inherited).
    const selfMember = byId.get(id) ?? { id, ...screen };
    const war = TerminalApp.#effectiveWar(selfMember, childrenOf, byId);

    // Children: next tier down (anyone claiming this as parent).
    const children = all
      .filter(m => m.parent === id)
      .map(m => {
        const w = TerminalApp.#effectiveWar(m, childrenOf, byId);
        return {
          target: `${collection}/${m.id}`,
          name: m.name ?? m.id,
          tier: m.tier,
          bodyType: m.bodyType ?? "",
          summary: TerminalApp.#locSummary(m),
          warStatus: w.status,
          warDirect: w.direct
        };
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // Breadcrumb: walk up the parent chain.
    const crumbs = [];
    let cur = screen.parent ? byId.get(screen.parent) : null;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      crumbs.unshift({ target: `${collection}/${cur.id}`, name: cur.name ?? cur.id });
      cur = cur.parent ? byId.get(cur.parent) : null;
    }

    // Child tier label (for the table header): the tier of the first
    // child, or a sensible default from this entity's tier.
    const childTierLabel = children.length
      ? TerminalApp.#tierLabel(children[0].tier)
      : null;

    // Bodies show a type; the children table shows a Type column only
    // when listing bodies.
    const childrenAreBodies = children.length > 0 && children[0].tier === "body";

    return {
      tier: screen.tier ?? null,
      tierLabel: TerminalApp.#tierLabel(screen.tier),
      bodyType: screen.bodyType ?? null,
      affiliation: screen.affiliation ?? null,
      warStatus: war.status,
      warDirect: war.direct,
      description: screen.description ?? "",
      details: Array.isArray(screen.details) ? screen.details : null,
      children: children.length ? children : null,
      childTierLabel,
      childrenAreBodies,
      crumbs: crumbs.length ? crumbs : null
    };
  }

  /* Map a tier id to a display label (singular + plural for headers). */
  static #tierLabel(tier) {
    switch (tier) {
      case "region": return "Region";
      case "cluster": return "Cluster";
      case "system": return "System";
      case "body": return "Celestial Body";
      default: return tier ? String(tier) : "";
    }
  }

  /* Group mission members into ordered status-sections defined on the
     board screen. Each section: { name, statuses: [...], archive? }.
     Within a section, sort by date descending (missing dates last).
     Missions whose status isn't in any section are appended to a
     fallback "OTHER" section so nothing vanishes. */
  static #groupByStatus(members, sections) {
    const dateKey = (m) => {
      const raw = m.date ?? m.issueDate ?? null;
      if (!raw) return -Infinity;
      const t = Date.parse(raw);
      return Number.isNaN(t) ? -Infinity : t;
    };
    const byDateDesc = (a, b) => dateKey(b) - dateKey(a) ||
      String(a.name ?? a.title ?? "").localeCompare(String(b.name ?? b.title ?? ""));

    const claimed = new Set();
    const out = [];

    for (const sec of sections) {
      const statuses = new Set(sec.statuses ?? []);
      const inSection = members.filter(m => statuses.has(m.status));
      inSection.forEach(m => claimed.add(m.id));
      out.push({
        name: sec.name,
        archive: sec.archive === true,
        members: inSection.sort(byDateDesc).map(TerminalApp.#missionRow)
      });
    }

    const leftover = members.filter(m => !claimed.has(m.id));
    if (leftover.length) {
      out.push({
        name: "OTHER",
        archive: false,
        members: leftover.sort(byDateDesc).map(TerminalApp.#missionRow)
      });
    }
    return out;
  }

  /* Shape a mission into the row fields the board partial renders.
     `date` column shows the human issueDate. `location` column shows
     the short flat `locationLabel` (since the detail `location` is now
     a structured object); falls back to system/planet if no label. */
  static #missionRow(m) {
    let loc = m.locationLabel ?? "";
    if (!loc && m.location && typeof m.location === "object") {
      loc = [m.location.planet, m.location.system].filter(Boolean).join(" — ");
    } else if (!loc && typeof m.location === "string") {
      loc = m.location;
    }
    return {
      target: `${m.collection}/${m.id}`,
      name: m.name ?? m.title ?? m.id,
      status: m.status,
      date: m.issueDate ?? m.date ?? "",
      location: loc,
      reward: m.reward ?? ""
    };
  }

  /* Group roster members into the ordered department structure the
     roster screen defines. Each department entry in screen.departments
     is either a string (no subgroups) or { name, subgroups: [...] }.
     Returns an ordered array of:
       { name, members: [...], subgroups: [{ name, members: [...] }] }
     Members sort by their numeric `sort` (then name). Unknown
     departments (present on a member but not in the order list) are
     appended at the end so nobody silently vanishes. */
  static #groupRoster(members, departmentOrder) {
    const byName = (a, b) =>
      (a.sort ?? 999) - (b.sort ?? 999) || String(a.name).localeCompare(String(b.name));

    // Normalize the department order into {name, subgroups[]} entries.
    const order = departmentOrder.map(d =>
      typeof d === "string" ? { name: d, subgroups: [] } : { name: d.name, subgroups: d.subgroups ?? [] }
    );
    const known = new Set(order.map(d => d.name));

    // Bucket members by department.
    const byDept = new Map();
    for (const m of members) {
      const dept = m.department ?? "Unassigned";
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(m);
    }

    // Append any departments that members reference but the order omits.
    for (const dept of byDept.keys()) {
      if (!known.has(dept)) order.push({ name: dept, subgroups: [] });
    }

    // Build the ordered structure.
    return order
      .filter(d => byDept.has(d.name))
      .map(d => {
        const all = byDept.get(d.name);
        const subgroups = [];
        const direct = [];
        const subSet = new Set(d.subgroups);

        for (const m of all) {
          if (m.subgroup && subSet.has(m.subgroup)) continue; // handled below
          if (m.subgroup && !subSet.has(m.subgroup)) {
            // member declares a subgroup not listed in order: treat as ad-hoc subgroup
            continue;
          }
          direct.push(m);
        }

        // Ordered, declared subgroups first.
        for (const sgName of d.subgroups) {
          const sgMembers = all.filter(m => m.subgroup === sgName).sort(byName);
          if (sgMembers.length) subgroups.push({ name: sgName, members: sgMembers });
        }
        // Any ad-hoc subgroups (declared on members, not in order).
        const adHoc = new Set(
          all.filter(m => m.subgroup && !subSet.has(m.subgroup)).map(m => m.subgroup)
        );
        for (const sgName of adHoc) {
          const sgMembers = all.filter(m => m.subgroup === sgName).sort(byName);
          subgroups.push({ name: sgName, members: sgMembers });
        }

        return { name: d.name, members: direct.sort(byName), subgroups };
      });
  }
}

/* ---- Module API ---- */
function buildApi() {
  let instance = null;
  const api = {
    open(target = null) {
      if (!instance) instance = new TerminalApp();
      // Default to home each open: reset target + history unless an
      // explicit target was requested.
      if (target) {
        instance.target = target;
      } else {
        instance.target = null;
        instance.clearHistory();
      }
      instance.render(true);
      return instance;
    },
    close() { if (instance?.rendered) instance.close(); },
    toggle() { if (instance?.rendered) instance.close(); else api.open(); },
    goTo(target) { api.open(); instance.goTo(target); },
    debugTime,
    get app() { return instance; }
  };
  return api;
}

/* ---- Lifecycle ---- */
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);

  /* Handlebars helper: lowercase (used for status -> flag class). */
  Handlebars.registerHelper("lower", (s) => String(s ?? "").toLowerCase());

  /* Handlebars helper: equality (used for select option selected state). */
  Handlebars.registerHelper("eq", (a, b) => a === b);

  /* slug: lowercase + hyphenate, for safe CSS class names from
     multi-word values (e.g. "Under Assault" -> "under-assault"). */
  Handlebars.registerHelper("slug", (s) =>
    String(s ?? "").toLowerCase().trim().replace(/\s+/g, "-"));

  /* locLink: render a location reference. If an id is given, emit a
     clickable nav link to location/<id>; otherwise plain text. Used by
     Black Box and Mission Log to link into the galaxy hierarchy. */
  Handlebars.registerHelper("locLink", (name, id) => {
    const text = Handlebars.escapeExpression(name ?? "");
    if (!text) return "";
    // id may be omitted (helper receives the options object in its place)
    const hasId = typeof id === "string" && id.length > 0;
    if (!hasId) return new Handlebars.SafeString(text);
    const safeId = Handlebars.escapeExpression(id);
    return new Handlebars.SafeString(
      `<a class="loc-link" data-action="navigate" data-target="location/${safeId}">${text}</a>`
    );
  });

  game.settings.register(MODULE_ID, "themeClass", {
    name: "Theme Class",
    hint: "CSS class for the active terminal theme (e.g. 'me-terminal').",
    scope: "world", config: true, type: String, default: "me-terminal"
  });
  game.settings.register(MODULE_ID, "homeScreenId", {
    name: "Home Screen ID",
    hint: "The screen id the terminal opens to.",
    scope: "world", config: true, type: String, default: "main"
  });

  /* ---- Crew feed settings ---- */
  game.settings.register(MODULE_ID, "feedArchiveDays", {
    name: "Feed: archive after (in-world days)",
    hint: "Posts older than this many in-world days move into a collapsible Archive section. Pinned posts are never archived. 0 disables archiving (all posts shown).",
    scope: "world", config: true, type: Number, default: 7
  });
  game.settings.register(MODULE_ID, "feedPinAuthority", {
    name: "Feed: who can pin / flag as Notice",
    hint: "Which users may pin posts and flag posts as Notices.",
    scope: "world", config: true, type: String, default: "gm",
    choices: {
      gm: "GM only",
      authored: "GM + post author (anyone, on their own posts)",
      all: "GM + all players"
    }
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (!mod) {
    console.error(`${MODULE_ID} | module not found in game.modules — the MODULE_ID constant ("${MODULE_ID}") must match the "id" in module.json and the install folder name. The terminal will not open until these agree.`);
    return;
  }
  mod.api = buildApi();
  console.log(`${MODULE_ID} | ready`);
});
