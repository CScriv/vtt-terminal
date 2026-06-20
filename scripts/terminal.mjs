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
import { debugTime } from "./gametime.mjs";
import { resolveSelfAuthor, boundMemberId } from "./bindings.mjs";
import "./config.mjs";
import "./controls.mjs";
import "./sockets.mjs";
import "./bindings.mjs";

import { ComposeMessageApp } from "./compose.mjs";


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
      toggleLike: TerminalApp.#onToggleLike,
      addComment: TerminalApp.#onAddComment,
      openMessage: TerminalApp.#onOpenMessage,
      composeMessage: TerminalApp.#onComposeMessage,
      toggleReveal: TerminalApp.#onToggleReveal
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/shell.hbs` }
  };

  /* Current target: a string like "main" or "crew/matthews". */
  target = null;
  #history = [];

  get currentTarget() {
    return this.target ?? game.settings.get(MODULE_ID, "homeScreenId");
  }

  /* Parse a target into { collection, id }.
     "crew/matthews" -> { collection: "crew", id: "matthews" }
     "missions"      -> { collection: null,  id: "missions"  } */
  static parseTarget(target) {
    if (target.includes("/")) {
      const [collection, id] = target.split("/");
      return { collection, id };
    }
    return { collection: null, id: target };
  }

  async goTo(target, { pushHistory = true } = {}) {
    if (pushHistory && this.currentTarget) this.#history.push(this.currentTarget);
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
  static async #onToggleLike(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;

    let name;
    if (game.user.isGM) {
      const picked = await TerminalApp.#pickCrewMember("Like as…");
      if (!picked) return;
      name = picked.name;
    } else {
      name = resolveSelfAuthor().author;
    }

    await requestWrite({ action: "toggleLike", screenId, postId, name });
  }

  /* Reply control. Player: body input, authored as their BOUND crew
     member (name + authorId) if a binding exists, else their character/
     user name with no link. GM: crew picker + body, authored as the
     chosen NPC (authorId link-correct). */
  static async #onAddComment(event, target) {
    event?.stopPropagation?.();
    const postId = target?.dataset?.postId;
    const screenId = target?.dataset?.screenId;
    if (!postId || !screenId) return;

    const { DialogV2 } = foundry.applications.api;
    const bodyField = `
      <div class="form-group">
        <label>Comment</label>
        <textarea name="body" rows="3" placeholder="Write a reply…"></textarea>
      </div>`;

    let author, authorId = null, body;

    if (game.user.isGM) {
      const picked = await TerminalApp.#pickCrewMember("Reply as…", bodyField);
      if (!picked || !picked.body) return;
      author = picked.name;
      authorId = picked.id;     // link-correct: crew member id
      body = picked.body;
    } else {
      const result = await DialogV2.prompt({
        window: { title: "Reply" },
        content: bodyField,
        ok: {
          label: "Post",
          callback: (_ev, button) => ({ body: button.form.elements.body.value.trim() })
        }
      }).catch(() => null);
      if (!result || !result.body) return;
      const self = resolveSelfAuthor();
      author = self.author;
      authorId = self.authorId; // set if the player is bound to a crew member
      body = result.body;
    }

    await requestWrite({ action: "addComment", screenId, postId, author, authorId, body });
  }

  /* Open a message -> mark it read for the viewer (if bound + unread).
     The <details> itself expands natively to show the body; we only
     need to fire the read-write. */
  static #onOpenMessage(event, target) {
    const messageId = target?.dataset?.messageId;
    const screenId = target?.dataset?.screenId;
    if (!messageId || !screenId) return;
    const memberId = boundMemberId();
    if (!memberId) return; // GM or unbound: nothing to mark
    suppressReadRender();  // keep this client from collapsing the opened message
    requestWrite({ action: "markRead", screenId, messageId, memberId });
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
      screenId,
      prefillTo: target?.dataset?.replyTo || null,
      prefillSubject: target?.dataset?.replySubject || ""
      // No onSent needed: sendMessage updates the journal, and the
      // updateJournalEntry hook in sockets.mjs re-renders open terminals.
    }).render(true);
  }


  async _prepareContext(_options) {
    const themeClass = game.settings.get(MODULE_ID, "themeClass");
    const target = this.currentTarget;
    const { collection, id } = TerminalApp.parseTarget(target);
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
    if (renderType === "inbox") {
      inbox = TerminalApp.#prepInbox(screen, id);
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
      renderType,
      renderTemplate,
      unknownRender: !renderTemplate
    };
  }

  async _preFirstRender(context, options) {
    await super._preFirstRender?.(context, options);
    const hb = foundry.applications.handlebars;
    // Load render partials (used via dynamic lookup in shell.hbs).
    await hb.loadTemplates(Object.values(RENDER_TEMPLATES));
    // Register the shared status-flag partial under a stable name.
    await hb.loadTemplates({
      terminalStatusFlag: `modules/${MODULE_ID}/templates/partials/status-flag.hbs`
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
  /* Build inbox render data, filtered for the current viewer.
     Messages live on the inbox screen JSON as `messages: [...]`. Each:
       { id, from, to: [ "<memberId>" | "<Department>" ], subject,
         time, body, read: [ "<memberId>", ... ] }
     Filtering:
       - GM: sees everything (no filter), inbox = all, sent = none-special.
       - Player: resolve their bound member id; a message is in their
         INBOX if they're a direct recipient OR their department is a
         recipient; in their SENT if they are the `from`.
     Names are resolved from the crew collection at render (store id,
     show name). Departments display as-is. Read state per viewer. */
  static #prepInbox(screen, screenId) {
    const messages = Array.isArray(screen.messages) ? screen.messages : [];

    // Build a crew lookup: id -> { name, department }.
    const crew = loadCollection("crew");
    const byId = new Map(crew.map(m => [m.id, {
      name: m.data?.name ?? m.id,
      department: m.data?.department ?? null
    }]));

    const nameOf = (id) => byId.get(id)?.name ?? id; // dept names pass through
    const resolveRecipients = (to) =>
      (Array.isArray(to) ? to : []).map(r => ({ id: r, label: nameOf(r) }));

    const isGM = game.user.isGM;
    const viewerId = isGM ? null : boundMemberId();
    const viewerDept = viewerId ? (byId.get(viewerId)?.department ?? null) : null;

    // Decide visibility + bucket for a message.
    const decorate = (m) => {
      const toList = Array.isArray(m.to) ? m.to : [];
      const directTo = viewerId && toList.includes(viewerId);
      const deptTo = viewerDept && toList.includes(viewerDept);
      const isRecipient = isGM || directTo || deptTo;
      const isSender = isGM ? false : (m.from === viewerId);
      const read = Array.isArray(m.read) ? m.read : [];
      const isUnread = viewerId ? !read.includes(viewerId) : false;
      return {
        ...m,
        screenId,
        fromLabel: nameOf(m.from),
        toLabels: resolveRecipients(m.to),
        replySubject: /^re:/i.test(m.subject ?? "") ? m.subject : `Re: ${m.subject ?? ""}`,
        isRecipient,
        isSender,
        unread: isUnread
      };
    };

    const decorated = messages.map(decorate);

    // Inbox: received (recipient). Sent: sent by viewer. GM: all in inbox.
    const inboxMsgs = decorated.filter(m => m.isRecipient);
    const sentMsgs = isGM
      ? decorated.filter(m => false)            // GM "sent" not meaningful; compose covers it
      : decorated.filter(m => m.isSender);

    // Newest first (messages carry a sortable time? fall back to array order).
    // We keep authored order reversed so latest-appended shows first.
    inboxMsgs.reverse();
    sentMsgs.reverse();

    const unreadCount = inboxMsgs.filter(m => m.unread).length;

    return {
      isGM,
      screenId,
      hasBinding: isGM || !!viewerId,
      canCompose: isGM || !!viewerId,
      inbox: inboxMsgs,
      sent: sentMsgs,
      unreadCount,
      showSent: !isGM   // GM doesn't get a personal Sent box
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

  /* Number of liker names shown before collapsing to "and X others". */
  static LIKE_NAMES_SHOWN = 3;

  /* Compose a human like-line from an array of names:
       []                      -> ""             (no like line)
       [A]                     -> "A"
       [A,B]                   -> "A and B"
       [A,B,C]                 -> "A, B and C"
       [A,B,C,D]               -> "A, B, C and 1 other"
       [A,B,C,D,E]             -> "A, B, C and 2 others"
     Shows up to LIKE_NAMES_SHOWN names; remainder -> "and X other(s)". */
  static #likeLine(likes) {
    const names = Array.isArray(likes) ? likes.filter(Boolean) : [];
    if (!names.length) return "";
    const N = TerminalApp.LIKE_NAMES_SHOWN;
    const shown = names.slice(0, N);
    const others = names.length - shown.length;

    if (others > 0) {
      return `${shown.join(", ")} and ${others} other${others === 1 ? "" : "s"}`;
    }
    // others <= 0: join all shown with commas + "and" before the last.
    if (shown.length === 1) return shown[0];
    return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  }

  /* Build feed render data: per-post composed like-line + like count. */
  static #prepFeed(screen, screenId) {
    const posts = Array.isArray(screen.posts) ? screen.posts : [];
    const out = posts.map(p => ({
      ...p,
      screenId,
      likeLine: TerminalApp.#likeLine(p.likes),
      likeCount: Array.isArray(p.likes) ? p.likes.length : 0
    }));
    return { posts: out };
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
      .map(m => ({ target: `${m.collection}/${m.id}`, name: m.name ?? m.id, description: m.description ?? "" }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return [{ name: null, rows }];
  }

  /* Location detail: one render type for all tiers (region/cluster/
     system/body). Derives this entity's CHILDREN (collection members
     whose parent === this id) for the table, and builds the PARENT
     BREADCRUMB chain by walking up via parent links. The child tier
     label is derived for the table header. */
  static #prepLocation(screen, collection, id) {
    const all = loadCollection(collection)
      .map(m => ({ id: m.id, collection, ...m.data }));
    const byId = new Map(all.map(m => [m.id, m]));

    // Children: next tier down (anyone claiming this as parent).
    const children = all
      .filter(m => m.parent === id)
      .map(m => ({
        target: `${collection}/${m.id}`,
        name: m.name ?? m.id,
        tier: m.tier,
        bodyType: m.bodyType ?? "",
        description: m.description ?? ""
      }))
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
