/* =============================================================
   TERMINAL — socket relay (player writes)
   -------------------------------------------------------------
   Players don't own the data journals, so they can't write to them
   directly. Instead a player emits a write-REQUEST over a socket; the
   GM's client (which owns the journals) receives it, validates, and
   performs the actual write. The document-update hook then re-renders
   open terminals for everyone.

   This is the REUSABLE core for all player interactions. Each action
   is a message {action, ...payload}; add new actions (like, comment)
   as new cases in performWrite(). Requires a GM logged in (only the
   GM client has write permission).

   Socket channel: module.terminal
   ============================================================= */

import { findScreenJournal, getPayload, findCollectionMember } from "./data.mjs";
import { terminalWorldTime } from "./gametime.mjs";
import { getBindings, canPinOrNotice } from "./bindings.mjs";

const MODULE_ID = "vtt-terminal";
const CHANNEL = `module.${MODULE_ID}`;

/* ---- Public: request a write. Called from the UI on any client. ----
   If the caller IS a GM, perform directly (no round-trip). Otherwise
   emit to the GM. */
export async function requestWrite(message) {
  const stamped = { ...message, userId: game.user.id };
  if (game.user.isGM) {
    return performWrite(stamped, game.user);
  }
  const gmOnline = game.users.some(u => u.isGM && u.active);
  if (!gmOnline) {
    ui.notifications.warn("Terminal: no GM is connected, so the change can't be saved right now.");
    return;
  }
  game.socket.emit(CHANNEL, stamped);
}

/* ---- GM-side: actually perform the write. ----
   Dispatches by action. Returns nothing; the document update triggers
   re-render via the hook below. */
async function performWrite(message, requestingUser) {
  if (!game.user.isGM) return; // only the GM client writes

  switch (message.action) {
    case "setRequestStatus":
      return setRequestStatus(message, requestingUser);
    case "react":
      return react(message, requestingUser);
    case "addComment":
      return addComment(message, requestingUser);
    case "addPost":
      return addPost(message, requestingUser);
    case "deletePost":
      return deletePost(message, requestingUser);
    case "deleteComment":
      return deleteComment(message, requestingUser);
    case "editPost":
      return editPost(message, requestingUser);
    case "editComment":
      return editComment(message, requestingUser);
    case "togglePin":
      return togglePin(message, requestingUser);
    case "readThread":
      return readThread(message, requestingUser);
    case "deleteThread":
      return deleteThread(message, requestingUser);
    case "restoreThread":
      return restoreThread(message, requestingUser);
    case "sendMessage":
      return sendMessage(message, requestingUser);
    case "toggleReveal":
      return toggleReveal(message, requestingUser);
    default:
      console.warn(`terminal | unknown write action: ${message.action}`);
  }
}

/* Update one request's status (and who set it) on a board screen.
   message: { action, screenId, requestId, status, by } */
async function setRequestStatus(message, requestingUser) {
  const { screenId, requestId, status, by } = message;
  const journal = findScreenJournal(screenId, { includeDisabled: true });
  if (!journal) {
    ui.notifications?.warn(`Terminal: board "${screenId}" not found.`);
    return;
  }

  const parsed = getPayload(journal);
  if (!parsed.ok) {
    ui.notifications?.error(`Terminal: couldn't read board data — ${parsed.error}`);
    return;
  }
  const data = parsed.data;
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const req = requests.find(r => r.id === requestId);
  if (!req) {
    ui.notifications?.warn(`Terminal: request "${requestId}" not found.`);
    return;
  }

  const validStatuses = new Set((data.sections ?? []).flatMap(s => s.statuses ?? []));
  if (validStatuses.size && !validStatuses.has(status)) {
    ui.notifications?.warn(`Terminal: "${status}" isn't valid for this board.`);
    return;
  }

  req.status = status;
  // updatedBy: explicit name if given; else the requesting player's name.
  // A GM leaving the field blank stores NO name (cleared).
  if (by) req.updatedBy = by;
  else if (requestingUser && !requestingUser.isGM) req.updatedBy = requestingUser.name;
  else delete req.updatedBy;
  req.updatedAt = new Date().toISOString();

  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info(`Terminal: status updated to "${status}".`);
}

/* ---- Feed helpers ---- */

/* Load a feed screen's journal + parsed data + the target post. */
function loadFeedPost(screenId, postId) {
  const journal = findScreenJournal(screenId, { includeDisabled: true });
  if (!journal) return { error: `Feed "${screenId}" not found.` };
  const parsed = getPayload(journal);
  if (!parsed.ok) return { error: `Couldn't read feed — ${parsed.error}` };
  const data = parsed.data;
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const post = posts.find(p => p.id === postId);
  if (!post) return { error: `Post "${postId}" not found.` };
  return { journal, data, post };
}

/* Toggle a name in a post's likes array (add if absent, remove if
   present). De-dup is inherent. message: { screenId, postId, name } */
/* React to a post. message: { screenId, postId, memberId, dir } where dir
   is "up" or "down". Reactions live in a single map keyed by crew member
   ID: { memberId: "up"|"down" }. One entry per member => like XOR dislike,
   and id keys survive name/nickname changes. Toggle semantics: clicking the
   same direction you hold clears it; the other direction flips it; first
   click sets it. Migrates a legacy `likes` name-array into the map (as
   name-keyed "up" entries) on first touch — those render fine via the
   id->name resolver's fallthrough, and convert to id-keyed naturally as
   people re-react. */
async function react(message, _requestingUser) {
  const { screenId, postId, memberId } = message;
  const dir = message.dir === "down" ? "down" : "up";
  if (!memberId) return;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (!post.reactions || typeof post.reactions !== "object") {
    post.reactions = {};
    if (Array.isArray(post.likes)) {
      for (const n of post.likes) if (n) post.reactions[n] = "up";  // legacy names
    }
  }
  if ("likes" in post) delete post.likes;

  const current = post.reactions[memberId] ?? null;
  if (current === dir) delete post.reactions[memberId];  // same dir -> clear
  else post.reactions[memberId] = dir;                   // set or flip

  await journal.setFlag(MODULE_ID, "json", data);
}

/* Append a comment to a post's replies. message:
   { screenId, postId, author, authorId, body } */
async function addComment(message, requestingUser) {
  const { screenId, postId, author, authorId, body } = message;
  if (!body || !author) return;

  // Anti-spoof: a non-GM may only comment as their own bound member
  // (matched by authorId), same model as addPost / sendMessage.
  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only reply as your own character.");
      return;
    }
  }

  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (!Array.isArray(post.replies)) post.replies = [];
  const comment = {
    id: `reply-${foundry.utils.randomID(8)}`,
    author,
    wt: terminalWorldTime(),
    body
  };
  if (authorId) comment.authorId = authorId;
  post.replies.push(comment);

  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: comment posted.");
}

/* Delete a post. message: { screenId, postId }
   Ownership: GM may delete any post; a non-GM may delete only a post
   authored by their bound member (post.authorId === their binding). */
async function deletePost(message, requestingUser) {
  const { screenId, postId } = message;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || post.authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only delete your own posts.");
      return;
    }
  }

  data.posts = (Array.isArray(data.posts) ? data.posts : []).filter(p => p.id !== postId);
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: post deleted.");
}

/* Delete a reply. message: { screenId, postId, replyId, replyIndex }
   Targets by replyId when present, else by replyIndex (legacy replies).
   Ownership: GM any; non-GM only their own (reply.authorId === binding). */
async function deleteComment(message, requestingUser) {
  const { screenId, postId, replyId, replyIndex } = message;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  const replies = Array.isArray(post.replies) ? post.replies : [];
  // Locate the reply: prefer stable id, fall back to index.
  let idx = -1;
  if (replyId) idx = replies.findIndex(r => r.id === replyId);
  if (idx === -1 && replyIndex !== null && replyIndex !== undefined) {
    const n = Number(replyIndex);
    if (Number.isInteger(n) && n >= 0 && n < replies.length) idx = n;
  }
  if (idx === -1) { ui.notifications?.warn("Terminal: reply not found."); return; }

  const reply = replies[idx];
  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || reply.authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only delete your own replies.");
      return;
    }
  }

  replies.splice(idx, 1);
  post.replies = replies;
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: reply deleted.");
}

/* Prepend a new post to a feed's posts array. message:
   { screenId, author, authorId, role, official, body }
   Newest-first: unshift so it appears at the top of the feed. */
async function addPost(message, requestingUser) {
  const { screenId, author, authorId, role, official, body } = message;
  if (!body || !author) return;

  // Anti-spoof: a non-GM may only post as their own bound member. We check
  // the bound id against the post's authorId (the identity that links to a
  // dossier), matching the mail-compose model.
  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only post as your own character.");
      return;
    }
  }

  const journal = findScreenJournal(screenId, { includeDisabled: true });
  if (!journal) { ui.notifications?.warn(`Terminal: feed "${screenId}" not found.`); return; }
  const parsed = getPayload(journal);
  if (!parsed.ok) { ui.notifications?.error(`Terminal: couldn't read feed — ${parsed.error}`); return; }
  const data = parsed.data;
  if (!Array.isArray(data.posts)) data.posts = [];

  const post = {
    id: `post-${foundry.utils.randomID(8)}`,
    author,
    wt: terminalWorldTime(),     // sortable in-world time; display formatted at render
    body,
    likes: [],
    replies: []
  };
  if (authorId) post.authorId = authorId;   // omit when absent -> no dossier link
  if (role) post.role = role;
  // Notice is gated by feedPinAuthority; re-check GM-side regardless of
  // what the client sent.
  if (official && canPinOrNotice(requestingUser ?? game.user, authorId)) {
    post.official = true;
  }

  data.posts.unshift(post);
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: posted to the feed.");
}

/* Edit a post's body (body-only; author/time/notice unchanged).
   message: { screenId, postId, body }. Ownership: GM or the post's
   author (bound member). Sets edited:true. */
async function editPost(message, requestingUser) {
  const { screenId, postId, body } = message;
  if (!body) return;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || post.authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only edit your own posts.");
      return;
    }
  }

  post.body = body;
  post.edited = true;
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: post updated.");
}

/* Edit a reply's body. message: { screenId, postId, replyId, replyIndex,
   body }. Targets by id, falls back to index. Ownership as above. */
async function editComment(message, requestingUser) {
  const { screenId, postId, replyId, replyIndex, body } = message;
  if (!body) return;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  const replies = Array.isArray(post.replies) ? post.replies : [];
  let idx = -1;
  if (replyId) idx = replies.findIndex(r => r.id === replyId);
  if (idx === -1 && replyIndex !== null && replyIndex !== undefined) {
    const n = Number(replyIndex);
    if (Number.isInteger(n) && n >= 0 && n < replies.length) idx = n;
  }
  if (idx === -1) { ui.notifications?.warn("Terminal: reply not found."); return; }

  const reply = replies[idx];
  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || reply.authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only edit your own replies.");
      return;
    }
  }

  reply.body = body;
  reply.edited = true;
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: reply updated.");
}

/* Pin / unpin a post. message: { screenId, postId }. Permission per
   feedPinAuthority (re-checked GM-side). */
async function togglePin(message, requestingUser) {
  const { screenId, postId } = message;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (!canPinOrNotice(requestingUser ?? game.user, post.authorId)) {
    ui.notifications?.warn("Terminal: you don't have permission to pin posts.");
    return;
  }

  if (post.pinned) delete post.pinned;
  else post.pinned = true;
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info(post.pinned ? "Terminal: post pinned." : "Terminal: post unpinned.");
}

/* ---- Inbox helpers ---- */

/* Load an inbox screen's journal + parsed data. */
function loadInbox(screenId) {
  const journal = findScreenJournal(screenId, { includeDisabled: true });
  if (!journal) return { error: `Inbox "${screenId}" not found.` };
  const parsed = getPayload(journal);
  if (!parsed.ok) return { error: `Couldn't read inbox — ${parsed.error}` };
  return { journal, data: parsed.data };
}

/* Mark a message read for a member (append member id to read[]).
   message: { screenId, messageId, memberId } */
/* Read-state writes should NOT live-refresh the terminal (it would
   collapse the message the reader just opened). The client that opens a
   message sets a short suppress window BEFORE the write round-trips, so
   when the resulting update arrives back, that client skips the
   re-render. Unread indicators update on the next natural render. */
let readOnlyWriteUntil = 0;
export function suppressReadRender() { readOnlyWriteUntil = Date.now() + 2000; }
function isReadOnlyWriteWindow() { return Date.now() < readOnlyWriteUntil; }



/* Send a message (GM compose). message:
   { screenId, from, to:[...], subject, body } */
async function sendMessage(message, requestingUser) {
  const { screenId, from, to, subject, body } = message;
  // Reply fields (optional): present when replying within an existing thread.
  const inReplyTo = message.inReplyTo ?? null;
  if (!Array.isArray(to) || !to.length || !body) return;

  // Anti-spoof: a non-GM sender may only send AS their bound member.
  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || from !== bound) {
      ui.notifications?.warn("Terminal: you can only send as your own character.");
      return;
    }
  }

  const res = loadInbox(screenId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data } = res;
  if (!Array.isArray(data.messages)) data.messages = [];
  if (!data.threads || typeof data.threads !== "object") data.threads = {};

  const msgId = `msg-${foundry.utils.randomID(8)}`;
  // A new message roots its own thread (threadId === its own id). A reply
  // inherits the parent's threadId (passed in message.threadId).
  const threadId = message.threadId ?? msgId;

  const newMsg = {
    id: msgId,
    threadId,
    inReplyTo,
    from,
    to,
    // Subject lives on the thread root only; replies omit it.
    ...(inReplyTo ? {} : { subject: subject || "(no subject)" }),
    wt: terminalWorldTime(),     // sortable in-world time; display formatted at render
    body
  };
  data.messages.push(newMsg);

  // Thread-level read state lives in data.threads[threadId].read (array of
  // member ids who are caught up). Sending/replying marks the SENDER read;
  // a reply clears read for its recipients (they have new unread content).
  // The parallel `deleted` array (member ids who dismissed the thread to
  // Trash) is cleared for the same recipients, so a reply directed at
  // someone resurfaces the thread in their inbox.
  const trec = data.threads[threadId] ?? (data.threads[threadId] = { read: [], deleted: [] });
  if (!Array.isArray(trec.read)) trec.read = [];
  if (!Array.isArray(trec.deleted)) trec.deleted = [];
  if (inReplyTo) {
    // Remove each recipient of this reply from read + deleted (departments
    // can't be "read"/"deleted" so only member-id recipients matter).
    trec.read = trec.read.filter(id => !to.includes(id));
    trec.deleted = trec.deleted.filter(id => !to.includes(id));
  }
  if (!trec.read.includes(from)) trec.read.push(from);

  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info(inReplyTo ? "Terminal: reply sent." : "Terminal: message sent.");
}

/* Mark a whole thread read for one member (adds them to threads[id].read).
   message: { screenId, threadId, memberId } */
async function readThread(message, _requestingUser) {
  const { screenId, threadId, memberId } = message;
  if (!threadId || !memberId) return;
  const res = loadInbox(screenId);
  if (res.error) return; // silent: read-marking shouldn't nag
  const { journal, data } = res;
  if (!data.threads || typeof data.threads !== "object") data.threads = {};
  const trec = data.threads[threadId] ?? (data.threads[threadId] = { read: [] });
  if (!Array.isArray(trec.read)) trec.read = [];
  if (trec.read.includes(memberId)) return; // already read; no write
  trec.read.push(memberId);
  await journal.setFlag(MODULE_ID, "json", data);
}

/* Delete a thread from one member's mailbox (move to Trash). Adds the
   member to threads[id].deleted. message: { screenId, threadId, memberId } */
async function deleteThread(message, _requestingUser) {
  const { screenId, threadId, memberId } = message;
  if (!threadId || !memberId) return;
  const res = loadInbox(screenId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data } = res;
  if (!data.threads || typeof data.threads !== "object") data.threads = {};
  const trec = data.threads[threadId] ?? (data.threads[threadId] = { read: [], deleted: [] });
  if (!Array.isArray(trec.deleted)) trec.deleted = [];
  if (!trec.deleted.includes(memberId)) trec.deleted.push(memberId);
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: thread moved to trash.");
}

/* Restore a thread from one member's Trash back to their inbox. Removes
   the member from threads[id].deleted. message: { screenId, threadId, memberId } */
async function restoreThread(message, _requestingUser) {
  const { screenId, threadId, memberId } = message;
  if (!threadId || !memberId) return;
  const res = loadInbox(screenId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data } = res;
  const trec = data.threads?.[threadId];
  if (!trec || !Array.isArray(trec.deleted)) return;
  trec.deleted = trec.deleted.filter(id => id !== memberId);
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: thread restored.");
}

/* Toggle a datapad block's revealed state. GM-only (the reveal control
   only renders for the GM, and this re-checks). message:
   { collection, memberId, blockId } */
async function toggleReveal(message, requestingUser) {
  if (!(requestingUser?.isGM)) return; // reveal is a GM action
  const { collection, memberId, blockId } = message;
  const journal = findCollectionMember(collection, memberId, { includeDisabled: true });
  if (!journal) { ui.notifications?.warn(`Terminal: datapad "${memberId}" not found.`); return; }
  const parsed = getPayload(journal);
  if (!parsed.ok) { ui.notifications?.error(`Terminal: couldn't read datapad — ${parsed.error}`); return; }
  const data = parsed.data;

  const revealed = new Set(Array.isArray(data.revealed) ? data.revealed : []);
  if (revealed.has(blockId)) revealed.delete(blockId);
  else revealed.add(blockId);
  data.revealed = [...revealed];

  await journal.setFlag(MODULE_ID, "json", data);
}

/* ---- Wire the socket + the re-render hook ---- */
Hooks.once("ready", () => {
  // GM services incoming write requests.
  game.socket.on(CHANNEL, (message) => {
    if (game.user.isGM) performWrite(message, game.users.get(message.userId));
  });

  // When any terminal-data journal changes, re-render open terminals so
  // everyone sees writes live. We don't rely on the change-diff shape
  // (nested setFlag diffs vary); instead we re-render if the updated
  // journal carries our flag at all.
  Hooks.on("updateJournalEntry", (doc) => {
    const isTerminalDoc = doc.getFlag(MODULE_ID, "id") !== undefined
      || doc.getFlag(MODULE_ID, "json") !== undefined;
    if (!isTerminalDoc) return;
    if (isReadOnlyWriteWindow()) return; // skip read-state re-render
    const app = game.modules.get(MODULE_ID)?.api?.app;
    if (app?.rendered) app.render(false);
  });
});
