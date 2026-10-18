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

import { findScreenRecord, getPayload, findMemberRecord, savePayload, createRecord, renameRecord } from "./data.mjs";
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

/* ---- GM-side: serialize writes. ----
   Every action is read-modify-write on a whole payload: read the
   journal's JSON, change it, write it back. If two requests overlap
   (two players reacting at once), the second reads BEFORE the first's
   update has landed and its write silently discards the first change.
   Chaining every write onto one promise makes them run strictly one at
   a time, so each read sees the previous write. A failed write is
   logged and doesn't stall the queue. */
let writeQueue = Promise.resolve();

function performWrite(message, requestingUser) {
  if (!game.user.isGM) return; // only the GM client writes
  const run = writeQueue.then(() => dispatchWrite(message, requestingUser));
  writeQueue = run.catch(err => {
    console.error(`terminal | write "${message.action}" failed`, err);
  });
  return run;
}

/* Dispatches by action. Returns nothing; the document update triggers
   re-render via the hook below. */
async function dispatchWrite(message, requestingUser) {
  switch (message.action) {
    case "setRequestStatus":
      return setRequestStatus(message, requestingUser);
    case "upsertRequest":
      return upsertRequest(message, requestingUser);
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
    case "createDatapad":
      return createDatapad(message, requestingUser);
    case "setDatapadMeta":
      return setDatapadMeta(message, requestingUser);
    case "setDiscovered":
      return setDiscovered(message, requestingUser);
    case "upsertBlock":
      return upsertBlock(message, requestingUser);
    case "moveBlock":
      return moveBlock(message, requestingUser);
    case "deleteBlock":
      return deleteBlock(message, requestingUser);
    default:
      console.warn(`terminal | unknown write action: ${message.action}`);
  }
}

/* Update one request's status (and who set it) on a board screen.
   message: { action, screenId, requestId, status, by } */
async function setRequestStatus(message, requestingUser) {
  const { screenId, requestId, status, by } = message;
  const record = findScreenRecord(screenId, { includeDisabled: true });
  if (!record) {
    ui.notifications?.warn(`Terminal: board "${screenId}" not found.`);
    return;
  }

  const parsed = getPayload(record);
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

  await savePayload(record, data);
  ui.notifications?.info(`Terminal: status updated to "${status}".`);
}

/* Create or edit a request on a board screen. One handler for both:
   a requestId that resolves to an existing entry is patched in place,
   anything else appends a new one.
   message: { screenId, requestId, title, from, fromId, role, status,
              body, date, promote, wt }

   GM-ONLY. Authoring board content is a GM action; the controls only
   render for the GM and this re-checks, so a crafted socket emit from
   a player client can't create or rewrite requests. Status changes are
   unaffected — those keep going through setRequestStatus. */
async function upsertRequest(message, requestingUser) {
  if (!(requestingUser?.isGM)) {
    ui.notifications?.warn("Terminal: only the GM can create or edit requests.");
    return;
  }

  const { screenId, requestId } = message;
  const record = findScreenRecord(screenId, { includeDisabled: true });
  if (!record) {
    ui.notifications?.warn(`Terminal: board "${screenId}" not found.`);
    return;
  }

  const parsed = getPayload(record);
  if (!parsed.ok) {
    ui.notifications?.error(`Terminal: couldn't read board data — ${parsed.error}`);
    return;
  }
  const data = parsed.data;
  if (!Array.isArray(data.requests)) data.requests = [];

  const title = String(message.title ?? "").trim();
  if (!title) return; // the composer already guards this

  // The status must be one this board declares, same rule the status
  // popup enforces. A board with no sections accepts anything.
  const validStatuses = new Set((data.sections ?? []).flatMap(s => s.statuses ?? []));
  let status = String(message.status ?? "").trim();
  if (validStatuses.size && !validStatuses.has(status)) {
    // Fall back to the first declared status rather than writing a
    // request that lands in the OTHER bucket.
    status = [...validStatuses][0];
  }

  const existing = requestId ? data.requests.find(r => r.id === requestId) : null;
  if (requestId && !existing) {
    ui.notifications?.warn(`Terminal: request "${requestId}" not found.`);
    return;
  }

  const req = existing ?? { id: nextRequestId(data.requests) };

  // Assign present fields; strip the ones cleared in the form so the
  // card's optional blocks disappear rather than rendering empty.
  req.title = title;
  req.status = status;
  assignOrDelete(req, "from", message.from);
  assignOrDelete(req, "fromId", message.fromId);
  assignOrDelete(req, "role", message.role);
  assignOrDelete(req, "body", message.body);
  assignOrDelete(req, "date", message.date);
  assignOrDelete(req, "promote", message.promote);

  // wt: sortable in-world stamp, set once at creation. Editing leaves
  // it alone (message.wt is undefined from an edit), so correcting a
  // typo doesn't move the card up the board.
  if (Number.isFinite(message.wt) && !Number.isFinite(req.wt)) req.wt = message.wt;

  if (existing) {
    req.editedAt = new Date().toISOString();
  } else {
    req.createdAt = new Date().toISOString();
    data.requests.push(req);
  }

  await savePayload(record, data);
  ui.notifications?.info(existing ? "Terminal: request updated." : "Terminal: request posted.");
}

/* Next sequential request id ("rq-004"), continuing the hand-authored
   numbering rather than switching to random ids mid-board. Only the GM
   writes, so a max+1 scan can't race; the while-loop is belt-and-braces
   for boards with duplicate or non-sequential ids. */
function nextRequestId(requests) {
  const taken = new Set(requests.map(r => r.id));
  let n = 0;
  for (const r of requests) {
    const m = /^rq-(\d+)$/.exec(String(r.id ?? ""));
    if (m) n = Math.max(n, Number(m[1]));
  }
  let id;
  do { id = `rq-${String(++n).padStart(3, "0")}`; } while (taken.has(id));
  return id;
}

/* Set a field when it has a value, remove it when it doesn't. Keeps
   cleared fields out of the JSON so `{{#if}}` blocks in the template
   stay accurate and the payload doesn't accumulate empty strings. */
function assignOrDelete(obj, key, value) {
  if (value === undefined) return;                 // not sent -> untouched
  if (value === null || value === "") delete obj[key];
  else obj[key] = value;
}

/* ---- Feed helpers ---- */

/* Load a feed screen's journal + parsed data + the target post. */
function loadFeedPost(screenId, postId) {
  const record = findScreenRecord(screenId, { includeDisabled: true });
  if (!record) return { error: `Feed "${screenId}" not found.` };
  const parsed = getPayload(record);
  if (!parsed.ok) return { error: `Couldn't read feed — ${parsed.error}` };
  const data = parsed.data;
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const post = posts.find(p => p.id === postId);
  if (!post) return { error: `Post "${postId}" not found.` };
  return { record, data, post };
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
  const { record, data, post } = res;

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

  await savePayload(record, data);
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
  const { record, data, post } = res;

  if (!Array.isArray(post.replies)) post.replies = [];
  const comment = {
    id: `reply-${foundry.utils.randomID(8)}`,
    author,
    wt: terminalWorldTime(),
    body
  };
  if (authorId) comment.authorId = authorId;
  post.replies.push(comment);

  await savePayload(record, data);
  ui.notifications?.info("Terminal: comment posted.");
}

/* Delete a post. message: { screenId, postId }
   Ownership: GM may delete any post; a non-GM may delete only a post
   authored by their bound member (post.authorId === their binding). */
async function deletePost(message, requestingUser) {
  const { screenId, postId } = message;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data, post } = res;

  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || post.authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only delete your own posts.");
      return;
    }
  }

  data.posts = (Array.isArray(data.posts) ? data.posts : []).filter(p => p.id !== postId);
  await savePayload(record, data);
  ui.notifications?.info("Terminal: post deleted.");
}

/* Delete a reply. message: { screenId, postId, replyId, replyIndex }
   Targets by replyId when present, else by replyIndex (legacy replies).
   Ownership: GM any; non-GM only their own (reply.authorId === binding). */
async function deleteComment(message, requestingUser) {
  const { screenId, postId, replyId, replyIndex } = message;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data, post } = res;

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
  await savePayload(record, data);
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

  const record = findScreenRecord(screenId, { includeDisabled: true });
  if (!record) { ui.notifications?.warn(`Terminal: feed "${screenId}" not found.`); return; }
  const parsed = getPayload(record);
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
  await savePayload(record, data);
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
  const { record, data, post } = res;

  if (requestingUser && !requestingUser.isGM) {
    const bound = getBindings()[requestingUser.id] ?? null;
    if (!bound || post.authorId !== bound) {
      ui.notifications?.warn("Terminal: you can only edit your own posts.");
      return;
    }
  }

  post.body = body;
  post.edited = true;
  await savePayload(record, data);
  ui.notifications?.info("Terminal: post updated.");
}

/* Edit a reply's body. message: { screenId, postId, replyId, replyIndex,
   body }. Targets by id, falls back to index. Ownership as above. */
async function editComment(message, requestingUser) {
  const { screenId, postId, replyId, replyIndex, body } = message;
  if (!body) return;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data, post } = res;

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
  await savePayload(record, data);
  ui.notifications?.info("Terminal: reply updated.");
}

/* Pin / unpin a post. message: { screenId, postId }. Permission per
   feedPinAuthority (re-checked GM-side). */
async function togglePin(message, requestingUser) {
  const { screenId, postId } = message;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data, post } = res;

  if (!canPinOrNotice(requestingUser ?? game.user, post.authorId)) {
    ui.notifications?.warn("Terminal: you don't have permission to pin posts.");
    return;
  }

  if (post.pinned) delete post.pinned;
  else post.pinned = true;
  await savePayload(record, data);
  ui.notifications?.info(post.pinned ? "Terminal: post pinned." : "Terminal: post unpinned.");
}

/* ---- Inbox helpers ---- */

/* Load an inbox screen's journal + parsed data. */
function loadInbox(screenId) {
  const record = findScreenRecord(screenId, { includeDisabled: true });
  if (!record) return { error: `Inbox "${screenId}" not found.` };
  const parsed = getPayload(record);
  if (!parsed.ok) return { error: `Couldn't read inbox — ${parsed.error}` };
  return { record, data: parsed.data };
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
  const { record, data } = res;
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

  await savePayload(record, data);
  ui.notifications?.info(inReplyTo ? "Terminal: reply sent." : "Terminal: message sent.");
}

/* Mark a whole thread read for one member (adds them to threads[id].read).
   message: { screenId, threadId, memberId } */
async function readThread(message, _requestingUser) {
  const { screenId, threadId, memberId } = message;
  if (!threadId || !memberId) return;
  const res = loadInbox(screenId);
  if (res.error) return; // silent: read-marking shouldn't nag
  const { record, data } = res;
  if (!data.threads || typeof data.threads !== "object") data.threads = {};
  const trec = data.threads[threadId] ?? (data.threads[threadId] = { read: [] });
  if (!Array.isArray(trec.read)) trec.read = [];
  if (trec.read.includes(memberId)) return; // already read; no write
  trec.read.push(memberId);
  await savePayload(record, data);
}

/* Delete a thread from one member's mailbox (move to Trash). Adds the
   member to threads[id].deleted. message: { screenId, threadId, memberId } */
async function deleteThread(message, _requestingUser) {
  const { screenId, threadId, memberId } = message;
  if (!threadId || !memberId) return;
  const res = loadInbox(screenId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;
  if (!data.threads || typeof data.threads !== "object") data.threads = {};
  const trec = data.threads[threadId] ?? (data.threads[threadId] = { read: [], deleted: [] });
  if (!Array.isArray(trec.deleted)) trec.deleted = [];
  if (!trec.deleted.includes(memberId)) trec.deleted.push(memberId);
  await savePayload(record, data);
  ui.notifications?.info("Terminal: thread moved to trash.");
}

/* Restore a thread from one member's Trash back to their inbox. Removes
   the member from threads[id].deleted. message: { screenId, threadId, memberId } */
async function restoreThread(message, _requestingUser) {
  const { screenId, threadId, memberId } = message;
  if (!threadId || !memberId) return;
  const res = loadInbox(screenId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;
  const trec = data.threads?.[threadId];
  if (!trec || !Array.isArray(trec.deleted)) return;
  trec.deleted = trec.deleted.filter(id => id !== memberId);
  await savePayload(record, data);
  ui.notifications?.info("Terminal: thread restored.");
}

/* Toggle a datapad block's revealed state. GM-only (the reveal control
   only renders for the GM, and this re-checks). message:
   { collection, memberId, blockId } */
async function toggleReveal(message, requestingUser) {
  if (!(requestingUser?.isGM)) return; // reveal is a GM action
  const { collection, memberId, blockId } = message;
  const record = findMemberRecord(collection, memberId, { includeDisabled: true });
  if (!record) { ui.notifications?.warn(`Terminal: datapad "${memberId}" not found.`); return; }
  const parsed = getPayload(record);
  if (!parsed.ok) { ui.notifications?.error(`Terminal: couldn't read datapad — ${parsed.error}`); return; }
  const data = parsed.data;

  const revealed = new Set(Array.isArray(data.revealed) ? data.revealed : []);
  if (revealed.has(blockId)) revealed.delete(blockId);
  else revealed.add(blockId);
  data.revealed = [...revealed];

  await savePayload(record, data);
}

/* =============================================================
   DATAPAD AUTHORING (GM only)
   -------------------------------------------------------------
   Creating and editing datapads from inside the terminal. Every
   handler here re-checks isGM: the controls only render for the GM,
   but performWrite dispatches on whatever arrives over the socket,
   so the guard has to live at the write.
   ============================================================= */

const DATAPAD_COLLECTION = "datapads";

/* Resolve a datapad journal + parsed payload. */
function loadDatapad(memberId) {
  const record = findMemberRecord(DATAPAD_COLLECTION, memberId, { includeDisabled: true });
  if (!record) return { error: `Datapad "${memberId}" not found.` };
  const parsed = getPayload(record);
  if (!parsed.ok) return { error: `Couldn't read datapad — ${parsed.error}` };
  return { record, data: parsed.data };
}

/* Give every block a stable id, BEFORE any write that could reorder
   or remove one.

   The renderer falls back to `b<index>` for blocks with no id, and
   `revealed[]` stores whatever id was showing at reveal time. So an
   id-less block that gets moved would silently inherit another
   block's reveal state. Backfilling with exactly that same
   `b<index>` value preserves existing reveals, and from then on the
   id travels with the block instead of its position.

   Returns true if anything changed. */
function normalizeBlockIds(data) {
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  let changed = false;
  blocks.forEach((b, i) => {
    if (!b.id) { b.id = `b${i}`; changed = true; }
  });
  data.blocks = blocks;
  return changed;
}

/* Strip nulls so cleared optional fields leave the payload rather
   than sitting in it as empty values the templates would still see. */
function pruneNulls(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") delete obj[k];
  }
  return obj;
}

/* Create a new datapad journal. The ONLY document-creating write in
   the module. Lands in the folder the existing datapads live in, so
   new ones file themselves alongside the old ones; falls back to the
   sidebar root when there are none yet.
   message: { id, title, source, date, tag, prompt } */
async function createDatapad(message, requestingUser) {
  if (!(requestingUser?.isGM)) {
    ui.notifications?.warn("Terminal: only the GM can create datapads.");
    return;
  }
  const { id } = message;
  if (!id) return;

  const clash = findMemberRecord(DATAPAD_COLLECTION, id, { includeDisabled: true });
  if (clash) {
    ui.notifications?.warn(`Terminal: a datapad with the id "${id}" already exists.`);
    return;
  }

  const payload = pruneNulls({
    render: "datapad",
    title: message.title,
    tag: message.tag ?? null,
    prompt: message.prompt ?? null,
    source: message.source ?? null,
    date: message.date ?? null
  });
  // Created hidden: a half-built datapad should never be listed.
  payload.discovered = false;
  payload.revealed = [];
  payload.blocks = [];

  // Files itself alongside the existing datapads (createRecord's default).
  const record = await createRecord({
    collection: DATAPAD_COLLECTION,
    id,
    name: message.title || id,
    payload,
    note: "<p>Content for this datapad is stored in the Terminal module's flag data. Edit it from the terminal, or via the journal header's <strong>Terminal Data</strong> button.</p>"
  });

  if (!record) {
    ui.notifications?.error("Terminal: the datapad journal couldn't be created.");
    return;
  }
  ui.notifications?.info(`Terminal: datapad "${id}" created (hidden).`);
}

/* Update a datapad's header fields. message:
   { memberId, title, source, date, tag, prompt } */
async function setDatapadMeta(message, requestingUser) {
  if (!(requestingUser?.isGM)) return;
  const res = loadDatapad(message.memberId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;

  data.title = message.title;
  for (const k of ["source", "date", "tag", "prompt"]) {
    if (message[k]) data[k] = message[k];
    else delete data[k];
  }

  await savePayload(record, data);
  // Keep the sidebar name in step with the in-terminal title.
  await renameRecord(record, message.title);
  ui.notifications?.info("Terminal: datapad updated.");
}

/* Mark a datapad discovered / undiscovered. Undiscovered datapads are
   filtered out of the directory AND refused on direct navigation for
   players — unlike a locked BLOCK, which shows a placeholder. A
   datapad the crew hasn't found yet shouldn't announce itself.
   message: { memberId, discovered } */
async function setDiscovered(message, requestingUser) {
  if (!(requestingUser?.isGM)) return;
  const res = loadDatapad(message.memberId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;

  data.discovered = message.discovered === true;
  await savePayload(record, data);
  ui.notifications?.info(data.discovered
    ? "Terminal: datapad is now visible to the crew."
    : "Terminal: datapad hidden from the crew.");
}

/* Create or edit one block. A blockId that resolves patches in place,
   anything else appends. message: { memberId, blockId, block } */
async function upsertBlock(message, requestingUser) {
  if (!(requestingUser?.isGM)) return;
  const { memberId, blockId, block } = message;
  if (!block?.type) return;

  const res = loadDatapad(memberId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;
  normalizeBlockIds(data);

  const clean = pruneNulls({ ...block });
  // `secret: false` is meaningful to strip rather than store.
  if (clean.secret !== true) delete clean.secret;

  if (blockId) {
    const idx = data.blocks.findIndex(b => b.id === blockId);
    if (idx === -1) { ui.notifications?.warn("Terminal: block not found."); return; }
    // Keep the id; replace everything else, so a type change doesn't
    // leave the previous type's fields behind.
    data.blocks[idx] = { ...clean, id: blockId };
    // A block that's no longer secret shouldn't linger in revealed[].
    if (clean.secret !== true) {
      data.revealed = (Array.isArray(data.revealed) ? data.revealed : []).filter(x => x !== blockId);
    }
  } else {
    data.blocks.push({ ...clean, id: `blk-${foundry.utils.randomID(8)}` });
  }

  await savePayload(record, data);
  ui.notifications?.info(blockId ? "Terminal: block updated." : "Terminal: block added.");
}

/* Move a block one position up or down.
   message: { memberId, blockId, dir: "up" | "down" } */
async function moveBlock(message, requestingUser) {
  if (!(requestingUser?.isGM)) return;
  const { memberId, blockId } = message;
  const delta = message.dir === "up" ? -1 : 1;

  const res = loadDatapad(memberId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;
  normalizeBlockIds(data);

  const idx = data.blocks.findIndex(b => b.id === blockId);
  const to = idx + delta;
  if (idx === -1 || to < 0 || to >= data.blocks.length) return; // no-op at the ends

  const [moved] = data.blocks.splice(idx, 1);
  data.blocks.splice(to, 0, moved);

  await savePayload(record, data);
}

/* Remove a block, and its reveal record with it.
   message: { memberId, blockId } */
async function deleteBlock(message, requestingUser) {
  if (!(requestingUser?.isGM)) return;
  const { memberId, blockId } = message;

  const res = loadDatapad(memberId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { record, data } = res;
  normalizeBlockIds(data);

  const before = data.blocks.length;
  data.blocks = data.blocks.filter(b => b.id !== blockId);
  if (data.blocks.length === before) { ui.notifications?.warn("Terminal: block not found."); return; }

  data.revealed = (Array.isArray(data.revealed) ? data.revealed : []).filter(x => x !== blockId);

  await savePayload(record, data);
  ui.notifications?.info("Terminal: block deleted.");
}

/* ---- Wire the socket + the re-render hook ---- */
Hooks.once("ready", () => {
  // GM services incoming write requests.
  game.socket.on(CHANNEL, (message) => {
    // Only the ACTIVE GM services requests; with two GMs logged in, every
    // GM client would otherwise perform (and duplicate) the same write.
    if (game.users.activeGM?.isSelf) performWrite(message, game.users.get(message.userId));
  });

  // When any terminal-data journal is created, changed or deleted,
  // re-render open terminals so everyone sees it live. We don't rely on
  // the change-diff shape (nested setFlag diffs vary); instead we
  // re-render if the journal carries our flag at all. Page edits count
  // too: body-authored screens keep their JSON in the first page.
  const rerender = (doc) => {
    const isTerminalDoc = doc?.getFlag(MODULE_ID, "id") !== undefined
      || doc?.getFlag(MODULE_ID, "json") !== undefined;
    if (!isTerminalDoc) return;
    if (isReadOnlyWriteWindow()) return; // skip read-state re-render
    const app = game.modules.get(MODULE_ID)?.api?.app;
    if (app?.rendered) app.render(false);
  };
  for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry"]) {
    Hooks.on(hook, rerender);
  }
  for (const hook of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"]) {
    Hooks.on(hook, (page) => rerender(page.parent));
  }
});
