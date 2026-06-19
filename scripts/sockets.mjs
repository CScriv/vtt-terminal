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
import { terminalTimestamp } from "./gametime.mjs";
import { getBindings } from "./bindings.mjs";

const MODULE_ID = "terminal";
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
    case "toggleLike":
      return toggleLike(message, requestingUser);
    case "addComment":
      return addComment(message, requestingUser);
    case "markRead":
      return markRead(message, requestingUser);
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
async function toggleLike(message, _requestingUser) {
  const { screenId, postId, name } = message;
  if (!name) return;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (!Array.isArray(post.likes)) post.likes = [];
  const i = post.likes.indexOf(name);
  if (i === -1) post.likes.push(name);   // add
  else post.likes.splice(i, 1);          // remove (un-like)

  await journal.setFlag(MODULE_ID, "json", data);
}

/* Append a comment to a post's replies. message:
   { screenId, postId, author, authorId, body } */
async function addComment(message, _requestingUser) {
  const { screenId, postId, author, authorId, body } = message;
  if (!body || !author) return;
  const res = loadFeedPost(screenId, postId);
  if (res.error) { ui.notifications?.warn(`Terminal: ${res.error}`); return; }
  const { journal, data, post } = res;

  if (!Array.isArray(post.replies)) post.replies = [];
  const comment = {
    author,
    time: terminalTimestamp(),
    body
  };
  if (authorId) comment.authorId = authorId;
  post.replies.push(comment);

  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: comment posted.");
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

async function markRead(message, _requestingUser) {
  const { screenId, messageId, memberId } = message;
  if (!memberId) return;
  const res = loadInbox(screenId);
  if (res.error) return; // silent: read-marking shouldn't nag
  const { journal, data } = res;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return;
  if (!Array.isArray(msg.read)) msg.read = [];
  if (msg.read.includes(memberId)) return; // already read; no write
  msg.read.push(memberId);
  await journal.setFlag(MODULE_ID, "json", data);
}

/* Send a message (GM compose). message:
   { screenId, from, to:[...], subject, body } */
async function sendMessage(message, requestingUser) {
  const { screenId, from, to, subject, body } = message;
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

  const newMsg = {
    id: `msg-${foundry.utils.randomID(8)}`,
    from,
    to,
    subject: subject || "(no subject)",
    time: terminalTimestamp(),
    body,
    read: []
  };
  data.messages.push(newMsg);
  await journal.setFlag(MODULE_ID, "json", data);
  ui.notifications?.info("Terminal: message sent.");
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
