// Upstash Redis state machine for the visual-review TG bot.
// Uses REST API client — works in Vercel serverless (no connection pooling).

import { Redis } from '@upstash/redis';
import { getEnv } from '../config.mjs';

let _redis = null;

export function getRedis() {
  if (_redis) return _redis;
  const url = getEnv('UPSTASH_REDIS_REST_URL');
  const token = getEnv('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. See BOT_SETUP.md.');
  }
  _redis = new Redis({ url, token });
  return _redis;
}

// Re-export so handlers can `import { redis } from '.../state.mjs'`
export const redis = new Proxy({}, {
  get(_t, prop) {
    return getRedis()[prop].bind(getRedis());
  },
});

// ---- Keys ----------------------------------------------------------------

const K = {
  currentTask: (chatId) => `task:current:${chatId}`,
  activeList: () => `task:list:active`,
  photos:     (issueNumber, section) => `task:${issueNumber}:photos:${section}`,
  textEdits:  (issueNumber) => `task:${issueNumber}:text_edits`,
  skipped:    (issueNumber) => `task:${issueNumber}:skipped_sections`,
  taskMeta:   (issueNumber) => `task:${issueNumber}:meta`,
  // ephemeral: which section the user is currently inputting for (after pressing a section button)
  activeSection: (chatId) => `task:section:${chatId}`,
  // M3a review loop:
  round:            (issueNumber) => `task:${issueNumber}:round`,
  lastSubmitHash:   (issueNumber) => `task:${issueNumber}:last_submit_hash`,
  assistantChatId:  (issueNumber) => `task:${issueNumber}:assistant_chat_id`,
  // ephemeral: owner has tapped [💬 Замечания] and the bot is waiting for the
  // next text message to forward as feedback. Stored per ownerId → issueNumber.
  feedbackPending:  (chatId) => `task:feedback_pending:${chatId}`,
  // M3.1 — free-form notes per task. Each entry is JSON with section + text.
  notes:            (issueNumber) => `task:${issueNumber}:notes`,
  // Debug: owner-only role override for testing assistant/unknown flows
  // without needing a second TG account. TTL'd so it can't accidentally
  // lock owner out of their own commands forever.
  roleOverride:     (chatId) => `role-override:${chatId}`,
  // Dynamic assistant whitelist (overlay on top of env TG_ASSISTANT_CHAT_IDS).
  // Set of chat_id strings. Persistent — no TTL.
  assistantsSet:    () => `assistants:approved`,
  // Pending access requests, hash with username + first_name + requested_at.
  // TTL'd so abandoned requests don't pile up.
  pendingAccess:    (chatId) => `assistants:pending:${chatId}`,
  // Conversational flow: command awaiting free-form input on next message.
  // TTL'd short — abandoned prompts shouldn't capture unrelated text later.
  cmdPending:       (chatId) => `cmd-pending:${chatId}`,
  // Phase 1.2 — task ownership state machine.
  // assignee: chatId of the assistant currently owning task N (or owner).
  // blocker:  JSON { reason, set_by, set_at } when task is in /block state.
  // activeTask: per-chatId pointer to "my current WIP task #" (single WIP rule).
  taskAssignee:     (issueNumber) => `task:${issueNumber}:assignee`,
  taskBlocker:      (issueNumber) => `task:${issueNumber}:blocker`,
  activeTask:       (chatId) => `assistant:${chatId}:active_task`,
  // Last activity marker for auto-stale sweep (scheduled-poke 7d warning + 24h auto-abandon).
  // Updated on any /current /skip /unskip /note /photo etc. for assigned task.
  taskLastTouched:  (issueNumber) => `task:${issueNumber}:last_touched`,
  // Phase 1.3 — pitch tracking. Set when owner taps [Pitched] + picks channel.
  // JSON { at, channel }. Used by scheduled-poke for 3d/7d/14d reminders +
  // 21d auto-ghosted suggestion.
  pitchInfo:        (issueNumber) => `task:${issueNumber}:pitch`,
  // /bug feature — pending session collecting media + description before /done submit.
  // TTL 30 min — abandoned sessions roll off.
  bugSession:       (chatId) => `bug-session:${chatId}`,
  // /prompt feature — same shape as bug session (text + media + documents),
  // semantically different: «task/idea для Claude Code» вместо «проблема бота».
  promptSession:    (chatId) => `prompt-session:${chatId}`,
  // Per-task prompts — assistant's thoughts/instructions для specific task
  // (как enriched note с media support). Included в visual_review_input.json
  // на /submit; builder Mode fix applies semantically.
  taskPrompts:      (issueNumber) => `task:${issueNumber}:task_prompts`,
  // Claude Code ↔ TG bridge: question + answer storage.
  // Claude POSTs question → bot shows inline keyboard owner → owner taps →
  // bot stores answer → Claude polls /api/claude/answer.
  claudeQuestion:   (sessionId) => `claude-q:${sessionId}`,
  claudeAnswer:     (sessionId) => `claude-a:${sessionId}`,
  // Wave 2 W2 — CC session liveness (locked §24.11 Решение 3, A3 hybrid).
  // heartbeat: CC sends every 60s while /start-session active. TTL 180s
  // (3× heartbeat interval — stale если >180s без обновления).
  // ack: CC sends when подхватывает webhook event для issue. TTL 24h
  // (for diagnostics — какие issues CC видел/обрабатывал).
  ccHeartbeat:      (ownerChatId) => `cc:heartbeat:${ownerChatId}`,
  ccAck:            (issueNumber) => `cc:ack:${issueNumber}`,
  // Set of (owner)+(issue) pairs нотифицированных как «CC offline, awaits» —
  // защита от спама: один push на label change, не повторяем пока CC не вернётся.
  ccOfflineNotified: (ownerChatId, issueNumber) => `cc:offline-notified:${ownerChatId}:${issueNumber}`,
  // INTERVIEW (CC-driven QnA over TG, see INTERVIEW.md).
  // session  → JSON { questions[], current_index, target_chat, started_at }
  // answers  → JSON { responses {key:value}, started_at, completed_at|null }
  // waiting  → sessionId, reverse lookup для handleText branch (TTL = session TTL)
  interviewSession: (sessionId) => `interview:session:${sessionId}`,
  interviewAnswers: (sessionId) => `interview:answers:${sessionId}`,
  interviewWaiting: (chatId) => `interview:waiting:${chatId}`,
  // INTENT router (assistant free-form UX, see INTENT_ROUTER_PLAN.md).
  // assistantIntent (uuid)        → JSON { chat_id, text, media[], started_at, last_touch_at }
  //                                  Vercel cron сканит — записи с (now-last_touch >10s) → create GH issue
  // intentDebounceByChat (chatId) → uuid строка, защита от race при первом message + быстрый lookup open intent
  // intentDraft (uuid)            → JSON draft from CC intent-router agent, TTL 24h (auto-expire)
  // intentUuidByIssue (issueN)    → uuid строка, reverse lookup для callback handlers
  assistantIntent:    (uuid) => `assistant-intent:${uuid}`,
  intentDebounceByChat: (chatId) => `intent-debounce:${chatId}`,
  intentDraft:        (uuid) => `intent-draft:${uuid}`,
  intentUuidByIssue:  (issueNumber) => `intent-uuid:${issueNumber}`,
};

// ---- CC session liveness (W2) --------------------------------------------

const CC_HEARTBEAT_TTL = 180;  // 3× heartbeat interval (60s)
const CC_ACK_TTL = 24 * 60 * 60;  // 24h
const CC_OFFLINE_NOTIFIED_TTL = 6 * 60 * 60;  // 6h — chill между повторениями

export async function setCcHeartbeat(ownerChatId, payload = {}) {
  const data = {
    started_at: payload.started_at || new Date().toISOString(),
    last_ping_at: new Date().toISOString(),
    cwd: payload.cwd || null,
    host: payload.host || null,
    pid: payload.pid || null,
  };
  await getRedis().set(K.ccHeartbeat(ownerChatId), JSON.stringify(data), { ex: CC_HEARTBEAT_TTL });
  return data;
}

export async function getCcHeartbeat(ownerChatId) {
  const v = await getRedis().get(K.ccHeartbeat(ownerChatId));
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; }
  catch { return null; }
}

export async function isCcAlive(ownerChatId) {
  return (await getCcHeartbeat(ownerChatId)) !== null;
}

export async function setCcAck(issueNumber, payload = {}) {
  const data = {
    claimed_at: payload.claimed_at || new Date().toISOString(),
    agent_chain: payload.agent_chain || [],
    note: payload.note || null,
  };
  await getRedis().set(K.ccAck(issueNumber), JSON.stringify(data), { ex: CC_ACK_TTL });
  return data;
}

export async function getCcAck(issueNumber) {
  const v = await getRedis().get(K.ccAck(issueNumber));
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; }
  catch { return null; }
}

// Spam-guard для «CC offline, task awaits» push. TTL 6h.
export async function markCcOfflineNotified(ownerChatId, issueNumber) {
  await getRedis().set(K.ccOfflineNotified(ownerChatId, issueNumber), '1', { ex: CC_OFFLINE_NOTIFIED_TTL });
}

export async function wasCcOfflineNotified(ownerChatId, issueNumber) {
  return (await getRedis().get(K.ccOfflineNotified(ownerChatId, issueNumber))) === '1';
}

// ---- Role override (debug) -----------------------------------------------

// TTL in seconds — long enough for a test session, short enough that a
// forgotten override silently expires.
const ROLE_OVERRIDE_TTL = 30 * 60;

export async function getRoleOverride(chatId) {
  return await getRedis().get(K.roleOverride(chatId));
}

export async function setRoleOverride(chatId, role) {
  await getRedis().set(K.roleOverride(chatId), role, { ex: ROLE_OVERRIDE_TTL });
}

export async function clearRoleOverride(chatId) {
  await getRedis().del(K.roleOverride(chatId));
}

export async function getRoleOverrideTtl(chatId) {
  return await getRedis().ttl(K.roleOverride(chatId));
}

// ---- Dynamic assistant whitelist (Redis overlay on top of env) -----------

export async function isApprovedAssistant(chatId) {
  return (await getRedis().sismember(K.assistantsSet(), String(chatId))) === 1;
}

export async function addApprovedAssistant(chatId) {
  await getRedis().sadd(K.assistantsSet(), String(chatId));
}

export async function removeApprovedAssistant(chatId) {
  await getRedis().srem(K.assistantsSet(), String(chatId));
}

export async function getApprovedAssistants() {
  const members = await getRedis().smembers(K.assistantsSet());
  return members || [];
}

// ---- Pending access requests --------------------------------------------

// 7 days — long enough for owner to notice and decide; short enough that
// abandoned requests roll off on their own.
const PENDING_ACCESS_TTL = 7 * 24 * 60 * 60;

export async function setPendingAccess(chatId, meta) {
  const value = JSON.stringify({
    username: meta.username || '',
    first_name: meta.first_name || '',
    requested_at: new Date().toISOString(),
    last_pinged_at: new Date().toISOString(),
  });
  await getRedis().set(K.pendingAccess(chatId), value, { ex: PENDING_ACCESS_TTL });
}

// Refresh the last_pinged_at marker without resetting requested_at.
// Used to self-heal: if owner-ping failed previously, next interaction
// retriggers ping after a cooldown (avoids spam if owner-ping is slow).
export async function refreshPendingPing(chatId) {
  const cur = await getPendingAccess(chatId);
  if (!cur) return;
  const value = JSON.stringify({
    ...cur,
    last_pinged_at: new Date().toISOString(),
  });
  await getRedis().set(K.pendingAccess(chatId), value, { ex: PENDING_ACCESS_TTL });
}

export async function getPendingAccess(chatId) {
  const raw = await getRedis().get(K.pendingAccess(chatId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function clearPendingAccess(chatId) {
  await getRedis().del(K.pendingAccess(chatId));
}

// ---- Command-pending (conversational input flow) ------------------------

// Short TTL — if the user abandons a prompt and types something else, we
// don't want a stale pending to hijack their next note 20 min later.
const CMD_PENDING_TTL = 5 * 60;

export async function setCommandPending(chatId, command, extras = {}) {
  const value = JSON.stringify({
    command,
    extras,
    set_at: new Date().toISOString(),
  });
  await getRedis().set(K.cmdPending(chatId), value, { ex: CMD_PENDING_TTL });
}

export async function getCommandPending(chatId) {
  const raw = await getRedis().get(K.cmdPending(chatId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function clearCommandPending(chatId) {
  await getRedis().del(K.cmdPending(chatId));
}

// ---- Current task --------------------------------------------------------

export async function getCurrentTask(chatId) {
  const r = getRedis();
  const data = await r.get(K.currentTask(chatId));
  return data || null;
}

export async function setCurrentTask(chatId, taskData) {
  const r = getRedis();
  await r.set(K.currentTask(chatId), taskData);
}

export async function clearCurrentTask(chatId) {
  const r = getRedis();
  await r.del(K.currentTask(chatId));
  await r.del(K.activeSection(chatId));
}

export async function getActiveSection(chatId) {
  return await getRedis().get(K.activeSection(chatId));
}

export async function setActiveSection(chatId, sectionId) {
  await getRedis().set(K.activeSection(chatId), sectionId);
}

// ---- Photos --------------------------------------------------------------

export async function addPhoto(issueNumber, section, photoData) {
  const r = getRedis();
  const entry = { ...photoData, added_at: new Date().toISOString() };
  await r.rpush(K.photos(issueNumber, section), JSON.stringify(entry));
}

export async function getPhotos(issueNumber, section) {
  const r = getRedis();
  const raw = await r.lrange(K.photos(issueNumber, section), 0, -1);
  return (raw || []).map(s => typeof s === 'string' ? JSON.parse(s) : s);
}

export async function countPhotos(issueNumber, section) {
  const r = getRedis();
  return await r.llen(K.photos(issueNumber, section));
}

// ---- Text edits ----------------------------------------------------------

export async function addTextEdit(issueNumber, field, newValue, oldValue = null) {
  const r = getRedis();
  const entry = { field, old_value: oldValue, new_value: newValue, added_at: new Date().toISOString() };
  await r.rpush(K.textEdits(issueNumber), JSON.stringify(entry));
}

export async function getTextEdits(issueNumber) {
  const r = getRedis();
  const raw = await r.lrange(K.textEdits(issueNumber), 0, -1);
  return (raw || []).map(s => typeof s === 'string' ? JSON.parse(s) : s);
}

// ---- Section progress / skips -------------------------------------------

export async function markSectionDone(issueNumber, section) {
  // No-op marker — progress is derived from countPhotos. Kept for API symmetry,
  // could be used later for explicit "done without min" overrides.
  const r = getRedis();
  await r.sadd(`task:${issueNumber}:sections_done`, section);
}

export async function skipSection(issueNumber, section) {
  const r = getRedis();
  await r.sadd(K.skipped(issueNumber), section);
}

export async function getSkipped(issueNumber) {
  const r = getRedis();
  const arr = await r.smembers(K.skipped(issueNumber));
  return arr || [];
}

// ---- Active task list ----------------------------------------------------

export async function getActiveTasks() {
  const r = getRedis();
  const numbers = await r.smembers(K.activeList());
  if (!numbers || numbers.length === 0) return [];
  const result = [];
  for (const n of numbers) {
    const meta = await r.get(K.taskMeta(n));
    if (meta) result.push(meta);
  }
  return result;
}

export async function registerActiveTask(issueNumber, meta) {
  const r = getRedis();
  await r.sadd(K.activeList(), String(issueNumber));
  await r.set(K.taskMeta(issueNumber), meta);
}

export async function clearTask(issueNumber) {
  const r = getRedis();
  // Wipe all keys for this issue.
  await Promise.all([
    r.srem(K.activeList(), String(issueNumber)),
    r.del(K.taskMeta(issueNumber)),
    r.del(K.textEdits(issueNumber)),
    r.del(K.skipped(issueNumber)),
    r.del(`task:${issueNumber}:sections_done`),
  ]);
  // Note: per-section photo lists left untouched in case of accidental clear;
  // they'll be overwritten on next session for same issue.
}

// ---- M3a: full state wipe on /approve (Q22b) -----------------------------
// Unlike clearTask above, this scans for every `task:{N}:*` key — per-section
// photo lists, round counter, hash, etc. — so the next visual-review session
// for the same slug starts clean. Mirrors the logic in scripts/bot/clear-task.mjs
// (CLI helper) for the in-bot path.
//
// Exception: `assistant_chat_id` is preserved permanently. It's routing info,
// not session data — the bot needs it after approve (and after sold/lost) so
// /api/task/notify can still push completion/needs-fix updates to the original
// assistant. Issue numbers are never reused by GitHub, so the keys don't
// accumulate problematically.
const PRESERVED_SUFFIXES = [':assistant_chat_id'];

export async function clearTaskState(issueNumber) {
  const r = getRedis();
  const prefix = `task:${issueNumber}:`;
  let cursor = 0;
  const allKeys = [];
  do {
    const [next, batch] = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
    cursor = Number(next);
    for (const k of batch) {
      if (PRESERVED_SUFFIXES.some(suffix => k.endsWith(suffix))) continue;
      allKeys.push(k);
    }
  } while (cursor !== 0);

  await r.srem(K.activeList(), String(issueNumber));
  if (allKeys.length > 0) {
    await r.del(...allKeys);
  }
  return allKeys.length;
}

// ---- M3a: round counter (Q21) -------------------------------------------

export async function getRound(issueNumber) {
  const r = getRedis();
  const v = await r.get(K.round(issueNumber));
  return Number(v) || 0;
}

export async function incRound(issueNumber) {
  return await getRedis().incr(K.round(issueNumber));
}

// ---- M3a: noop-submit hash (Q24) ----------------------------------------

export async function getLastSubmitHash(issueNumber) {
  return await getRedis().get(K.lastSubmitHash(issueNumber));
}

export async function setLastSubmitHash(issueNumber, hash) {
  await getRedis().set(K.lastSubmitHash(issueNumber), hash);
}

// ---- M3a: link assistant chat_id to issue (Q20 push back) ---------------

export async function getAssistantChatId(issueNumber) {
  return await getRedis().get(K.assistantChatId(issueNumber));
}

export async function setAssistantChatId(issueNumber, chatId) {
  await getRedis().set(K.assistantChatId(issueNumber), String(chatId));
}

// ---- M3a: pending feedback (Q20 owner replies after [💬 Замечания]) ----

export async function getFeedbackPending(chatId) {
  return await getRedis().get(K.feedbackPending(chatId));
}

export async function setFeedbackPending(chatId, issueNumber) {
  await getRedis().set(K.feedbackPending(chatId), String(issueNumber));
}

export async function clearFeedbackPending(chatId) {
  await getRedis().del(K.feedbackPending(chatId));
}

// ---- M3a: photo /rm + /unskip (Q24.5) -----------------------------------

// Remove one photo entry by index. Returns the removed entry or null.
// Index is 1-based for user UX (the bot says "[hero] 1/2" → /rm hero 1).
export async function removePhotoAt(issueNumber, section, oneBasedIdx) {
  const r = getRedis();
  const key = K.photos(issueNumber, section);
  const raw = await r.lrange(key, 0, -1);
  const list = (raw || []).map(s => typeof s === 'string' ? JSON.parse(s) : s);
  const idx = oneBasedIdx - 1;
  if (idx < 0 || idx >= list.length) return null;
  const [removed] = list.splice(idx, 1);
  await r.del(key);
  if (list.length > 0) {
    await r.rpush(key, ...list.map(o => JSON.stringify(o)));
  }
  return removed;
}

export async function unskipSection(issueNumber, section) {
  await getRedis().srem(K.skipped(issueNumber), section);
}

// ---- M3.1: free-form notes (Q16.7 partial implementation) --------------
// Each note has { text, section, added_at }. section is `null` for task-wide
// notes (no active section at the time of writing). Notes are appended to a
// list and never auto-deduplicated — assistant can write multiple instructions
// per section over time, and we want to preserve the order for context.

export async function addNote(issueNumber, section, text) {
  const r = getRedis();
  const entry = {
    text: String(text).slice(0, 2000),  // cap each note at 2KB
    section: section || null,
    added_at: new Date().toISOString(),
  };
  await r.rpush(K.notes(issueNumber), JSON.stringify(entry));
}

export async function getNotes(issueNumber) {
  const r = getRedis();
  const raw = await r.lrange(K.notes(issueNumber), 0, -1);
  return (raw || []).map(s => typeof s === 'string' ? JSON.parse(s) : s);
}

export async function removeNoteAt(issueNumber, oneBasedIdx) {
  const r = getRedis();
  const key = K.notes(issueNumber);
  const raw = await r.lrange(key, 0, -1);
  const list = (raw || []).map(s => typeof s === 'string' ? JSON.parse(s) : s);
  const idx = oneBasedIdx - 1;
  if (idx < 0 || idx >= list.length) return null;
  const [removed] = list.splice(idx, 1);
  await r.del(key);
  if (list.length > 0) {
    await r.rpush(key, ...list.map(o => JSON.stringify(o)));
  }
  return removed;
}

export async function clearNotes(issueNumber) {
  await getRedis().del(K.notes(issueNumber));
}

// ---- Phase 1.2: task ownership state machine ----------------------------
// Single-WIP-per-assistant rule: an assistant may have at most one active
// task. /block parks the current one (frees the WIP slot, keeps assignee).
// /abandon fully releases (clears assignee + blocker). /reassign is
// owner-only and transfers assignee atomically.
//
// Owner is exempt from single-WIP enforcement — they coordinate everything
// and may juggle several tasks in parallel.

export async function getTaskAssignee(issueNumber) {
  return await getRedis().get(K.taskAssignee(issueNumber));
}

export async function setTaskAssignee(issueNumber, chatId) {
  await getRedis().set(K.taskAssignee(issueNumber), String(chatId));
}

export async function clearTaskAssignee(issueNumber) {
  await getRedis().del(K.taskAssignee(issueNumber));
}

export async function getTaskBlocker(issueNumber) {
  const raw = await getRedis().get(K.taskBlocker(issueNumber));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function setTaskBlocker(issueNumber, { reason, setBy }) {
  const value = JSON.stringify({
    reason: String(reason || '').slice(0, 500),
    set_by: String(setBy),
    set_at: new Date().toISOString(),
  });
  await getRedis().set(K.taskBlocker(issueNumber), value);
}

export async function clearTaskBlocker(issueNumber) {
  await getRedis().del(K.taskBlocker(issueNumber));
}

export async function getActiveTask(chatId) {
  const v = await getRedis().get(K.activeTask(chatId));
  return v ? Number(v) : null;
}

export async function setActiveTask(chatId, issueNumber) {
  await getRedis().set(K.activeTask(chatId), String(issueNumber));
}

export async function clearActiveTask(chatId) {
  await getRedis().del(K.activeTask(chatId));
}

export async function touchTask(issueNumber) {
  await getRedis().set(K.taskLastTouched(issueNumber), new Date().toISOString());
}

export async function getTaskLastTouched(issueNumber) {
  return await getRedis().get(K.taskLastTouched(issueNumber));
}

// ---- Phase 1.3: pitch tracking ------------------------------------------

export async function setPitchInfo(issueNumber, { channel }) {
  const value = JSON.stringify({
    channel: String(channel || 'other').slice(0, 32),
    at: new Date().toISOString(),
  });
  await getRedis().set(K.pitchInfo(issueNumber), value);
}

export async function getPitchInfo(issueNumber) {
  const raw = await getRedis().get(K.pitchInfo(issueNumber));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function clearPitchInfo(issueNumber) {
  await getRedis().del(K.pitchInfo(issueNumber));
}

// ---- /bug feature: pending session --------------------------------------

const BUG_SESSION_TTL = 30 * 60; // 30 min — abandoned sessions roll off

// Returns { description, media: [{type, file_id, caption}], started_at } or null.
export async function getBugSession(chatId) {
  const raw = await getRedis().get(K.bugSession(chatId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function startBugSession(chatId, initialDescription = '') {
  const value = JSON.stringify({
    description: String(initialDescription || '').slice(0, 4000),
    media: [],
    started_at: new Date().toISOString(),
  });
  await getRedis().set(K.bugSession(chatId), value, { ex: BUG_SESSION_TTL });
}

export async function appendBugText(chatId, text) {
  const session = await getBugSession(chatId);
  if (!session) return false;
  const sep = session.description ? '\n\n' : '';
  session.description = (session.description + sep + text).slice(0, 8000);
  await getRedis().set(K.bugSession(chatId), JSON.stringify(session), { ex: BUG_SESSION_TTL });
  return true;
}

export async function appendBugMedia(chatId, media) {
  const session = await getBugSession(chatId);
  if (!session) return false;
  session.media = session.media || [];
  if (session.media.length >= 10) return false; // TG sendMediaGroup limit
  const caption = (media.caption || '').trim();
  session.media.push({
    type: media.type, // 'photo' | 'video'
    file_id: media.file_id,
    caption,
  });
  // Auto-merge caption в description чтобы issue title был descriptive
  // (вместо «(no description, media-only)»). User просто посылает фото
  // с подписью — caption становится частью bug description.
  if (caption) {
    const sep = session.description ? '\n\n' : '';
    session.description = (session.description + sep + caption).slice(0, 8000);
  }
  await getRedis().set(K.bugSession(chatId), JSON.stringify(session), { ex: BUG_SESSION_TTL });
  return true;
}

export async function clearBugSession(chatId) {
  await getRedis().del(K.bugSession(chatId));
}

// ---- /prompt session (mirror /bug) -------------------------------------

const PROMPT_SESSION_TTL = 30 * 60;

export async function getPromptSession(chatId) {
  const raw = await getRedis().get(K.promptSession(chatId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function startPromptSession(chatId, initialDescription = '') {
  const value = JSON.stringify({
    description: String(initialDescription || '').slice(0, 4000),
    media: [],
    started_at: new Date().toISOString(),
  });
  await getRedis().set(K.promptSession(chatId), value, { ex: PROMPT_SESSION_TTL });
}

export async function appendPromptText(chatId, text) {
  const session = await getPromptSession(chatId);
  if (!session) return false;
  const sep = session.description ? '\n\n' : '';
  session.description = (session.description + sep + text).slice(0, 16000);
  await getRedis().set(K.promptSession(chatId), JSON.stringify(session), { ex: PROMPT_SESSION_TTL });
  return true;
}

export async function appendPromptMedia(chatId, media) {
  const session = await getPromptSession(chatId);
  if (!session) return false;
  session.media = session.media || [];
  if (session.media.length >= 10) return false;
  const caption = (media.caption || '').trim();
  session.media.push({
    type: media.type, // 'photo' | 'video' | 'document'
    file_id: media.file_id,
    file_name: media.file_name || null,  // documents have file_name
    mime_type: media.mime_type || null,
    caption,
  });
  if (caption) {
    const sep = session.description ? '\n\n' : '';
    session.description = (session.description + sep + caption).slice(0, 16000);
  }
  await getRedis().set(K.promptSession(chatId), JSON.stringify(session), { ex: PROMPT_SESSION_TTL });
  return true;
}

export async function clearPromptSession(chatId) {
  await getRedis().del(K.promptSession(chatId));
}

// ---- Per-task prompts (enriched notes с media support) -----------------

export async function addTaskPrompt(issueNumber, entry) {
  const r = getRedis();
  const obj = {
    text: entry.text || '',
    type: entry.type || 'text',     // 'text' | 'photo' | 'video' | 'document'
    file_id: entry.file_id || null,
    file_name: entry.file_name || null,
    mime_type: entry.mime_type || null,
    caption: entry.caption || '',
    added_at: new Date().toISOString(),
  };
  await r.rpush(K.taskPrompts(issueNumber), JSON.stringify(obj));
}

export async function getTaskPrompts(issueNumber) {
  const r = getRedis();
  const raw = await r.lrange(K.taskPrompts(issueNumber), 0, -1);
  return (raw || []).map(s => typeof s === 'string' ? JSON.parse(s) : s);
}

export async function clearTaskPrompts(issueNumber) {
  await getRedis().del(K.taskPrompts(issueNumber));
}

// ---- Claude Code ↔ TG bridge --------------------------------------------

const CLAUDE_Q_TTL = 30 * 60; // 30 min — abandoned questions roll off

export async function setClaudeQuestion(sessionId, payload) {
  await getRedis().set(K.claudeQuestion(sessionId), JSON.stringify({
    ...payload,
    sent_at: new Date().toISOString(),
  }), { ex: CLAUDE_Q_TTL });
}

export async function getClaudeQuestion(sessionId) {
  const raw = await getRedis().get(K.claudeQuestion(sessionId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function setClaudeAnswer(sessionId, key, by) {
  await getRedis().set(K.claudeAnswer(sessionId), JSON.stringify({
    key,
    by,
    answered_at: new Date().toISOString(),
  }), { ex: CLAUDE_Q_TTL });
}

export async function getClaudeAnswer(sessionId) {
  const raw = await getRedis().get(K.claudeAnswer(sessionId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

// Convenience for auto-stale sweep — returns all task numbers with
// assignee set. Caller filters by last_touched age.
export async function listAssignedTasks() {
  const r = getRedis();
  let cursor = 0;
  const numbers = new Set();
  do {
    const [next, batch] = await r.scan(cursor, { match: 'task:*:assignee', count: 100 });
    cursor = Number(next);
    for (const k of batch) {
      const m = k.match(/^task:(\d+):assignee$/);
      if (m) numbers.add(Number(m[1]));
    }
  } while (cursor !== 0);
  return [...numbers];
}

// ---- INTERVIEW (CC ↔ TG QnA) --------------------------------------------

const INTERVIEW_TTL = 30 * 60; // 30 min — session expires

export async function startInterviewSession(sessionId, { questions, targetChatId }) {
  const session = {
    questions,                  // [{key, prompt, hint?}]
    current_index: 0,
    target_chat: String(targetChatId),
    started_at: new Date().toISOString(),
  };
  const answers = {
    responses: {},
    started_at: session.started_at,
    completed_at: null,
  };
  const r = getRedis();
  await Promise.all([
    r.set(K.interviewSession(sessionId), JSON.stringify(session), { ex: INTERVIEW_TTL }),
    r.set(K.interviewAnswers(sessionId), JSON.stringify(answers), { ex: INTERVIEW_TTL }),
    r.set(K.interviewWaiting(targetChatId), sessionId, { ex: INTERVIEW_TTL }),
  ]);
  return session;
}

export async function getInterviewSession(sessionId) {
  const raw = await getRedis().get(K.interviewSession(sessionId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function getInterviewAnswers(sessionId) {
  const raw = await getRedis().get(K.interviewAnswers(sessionId));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

// Returns sessionId for chat if waiting, else null.
export async function getInterviewWaitingForChat(chatId) {
  return await getRedis().get(K.interviewWaiting(chatId));
}

// Append answer to current question, advance index, mark completed if done.
// Returns { question_key, completed: bool, next_question: {...} | null }.
export async function captureInterviewAnswer(sessionId, answerText) {
  const session = await getInterviewSession(sessionId);
  const answers = await getInterviewAnswers(sessionId);
  if (!session || !answers) return null;
  const q = session.questions[session.current_index];
  if (!q) return null;
  answers.responses[q.key] = String(answerText).slice(0, 4000);
  session.current_index += 1;
  const completed = session.current_index >= session.questions.length;
  if (completed) {
    answers.completed_at = new Date().toISOString();
    // Clear waiting key so chat returns to normal handlers.
    await getRedis().del(K.interviewWaiting(session.target_chat));
  }
  const r = getRedis();
  await Promise.all([
    r.set(K.interviewSession(sessionId), JSON.stringify(session), { ex: INTERVIEW_TTL }),
    r.set(K.interviewAnswers(sessionId), JSON.stringify(answers), { ex: INTERVIEW_TTL }),
  ]);
  return {
    question_key: q.key,
    completed,
    next_question: completed ? null : session.questions[session.current_index],
  };
}

export async function cancelInterview(sessionId) {
  const session = await getInterviewSession(sessionId);
  const r = getRedis();
  await r.del(K.interviewSession(sessionId));
  await r.del(K.interviewAnswers(sessionId));
  if (session) await r.del(K.interviewWaiting(session.target_chat));
}

// ---- INTENT router (assistant free-form UX layer) -----------------------
// See INTENT_ROUTER_PLAN.md. Mirror of bugSession/promptSession pattern,
// плюс reverse uuid<->issue mapping и list-expired для Vercel cron.

const INTENT_TTL = 30 * 60;             // 30 min — abandoned intents roll off
const INTENT_DEBOUNCE_TTL = 5 * 60;     // 5 min — long enough для cron grab, short enough чтобы stale debounce keys не висели
const INTENT_DRAFT_TTL = 24 * 60 * 60;  // 24h auto-expire (Q6 locked)
const INTENT_ISSUE_MAP_TTL = 7 * 24 * 60 * 60;  // 7d — issue→uuid reverse lookup, expires после очевидного abandon

// Start a new intent OR append to existing one for this chat (debounce-aware).
// Returns the uuid (existing or newly created).
export async function startOrAppendIntent(chatId, { text = '', media = null } = {}) {
  const r = getRedis();
  const existingUuid = await r.get(K.intentDebounceByChat(chatId));
  if (existingUuid) {
    if (text) await appendIntentText(existingUuid, text);
    if (media) await appendIntentMedia(existingUuid, media);
    // bump debounce TTL so cron не дёрнет посередине input'a
    await r.set(K.intentDebounceByChat(chatId), existingUuid, { ex: INTENT_DEBOUNCE_TTL });
    return existingUuid;
  }
  // Create new
  const uuid = newIntentUuid();
  const now = new Date().toISOString();
  const payload = {
    uuid,
    chat_id: String(chatId),
    text: String(text || '').slice(0, 8000),
    media: media ? [normalizeMedia(media)] : [],
    started_at: now,
    last_touch_at: now,
  };
  await r.set(K.assistantIntent(uuid), JSON.stringify(payload), { ex: INTENT_TTL });
  await r.set(K.intentDebounceByChat(chatId), uuid, { ex: INTENT_DEBOUNCE_TTL });
  return uuid;
}

export async function appendIntentText(uuid, text) {
  const intent = await getIntent(uuid);
  if (!intent) return false;
  const sep = intent.text ? '\n\n' : '';
  intent.text = (intent.text + sep + String(text || '')).slice(0, 16000);
  intent.last_touch_at = new Date().toISOString();
  await getRedis().set(K.assistantIntent(uuid), JSON.stringify(intent), { ex: INTENT_TTL });
  return true;
}

export async function appendIntentMedia(uuid, media) {
  const intent = await getIntent(uuid);
  if (!intent) return false;
  intent.media = intent.media || [];
  if (intent.media.length >= 10) return false;
  intent.media.push(normalizeMedia(media));
  // Auto-merge caption to text (same as bugSession behaviour)
  const caption = (media.caption || '').trim();
  if (caption) {
    const sep = intent.text ? '\n\n' : '';
    intent.text = (intent.text + sep + caption).slice(0, 16000);
  }
  intent.last_touch_at = new Date().toISOString();
  await getRedis().set(K.assistantIntent(uuid), JSON.stringify(intent), { ex: INTENT_TTL });
  return true;
}

export async function getIntent(uuid) {
  const raw = await getRedis().get(K.assistantIntent(uuid));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function clearIntent(uuid) {
  const intent = await getIntent(uuid);
  await getRedis().del(K.assistantIntent(uuid));
  if (intent && intent.chat_id) {
    // Only clear debounce if it still points to THIS uuid (assistant might have started a new one)
    const current = await getRedis().get(K.intentDebounceByChat(intent.chat_id));
    if (current === uuid) await getRedis().del(K.intentDebounceByChat(intent.chat_id));
  }
}

// Returns open uuid for chat (or null) — used by handleText to decide append vs new.
export async function getOpenIntentForChat(chatId) {
  return await getRedis().get(K.intentDebounceByChat(chatId));
}

// Vercel cron sweeper — returns intents quiet for >= idleSeconds.
// Default 30s: debounce window assistant's multi-message burst before issue creation.
export async function listIdleIntents({ idleSeconds = 30 } = {}) {
  const r = getRedis();
  let cursor = 0;
  const out = [];
  const cutoff = Date.now() - idleSeconds * 1000;
  do {
    const [next, batch] = await r.scan(cursor, { match: 'assistant-intent:*', count: 100 });
    cursor = Number(next);
    for (const k of batch) {
      const raw = await r.get(k);
      if (!raw) continue;
      let intent;
      try { intent = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { continue; }
      const touchedMs = Date.parse(intent.last_touch_at || intent.started_at || 0);
      if (touchedMs && touchedMs <= cutoff) out.push(intent);
    }
  } while (cursor !== 0);
  return out;
}

// ---- Intent draft (CC → bot) --------------------------------------------

export async function setIntentDraft(uuid, draft) {
  await getRedis().set(K.intentDraft(uuid), JSON.stringify({
    ...draft,
    drafted_at: new Date().toISOString(),
  }), { ex: INTENT_DRAFT_TTL });
}

export async function getIntentDraft(uuid) {
  const raw = await getRedis().get(K.intentDraft(uuid));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
}

export async function clearIntentDraft(uuid) {
  await getRedis().del(K.intentDraft(uuid));
}

// Reverse lookup uuid ↔ issue (callback handlers receive issue from button, need uuid).
export async function mapIntentIssueToUuid(issueNumber, uuid) {
  await getRedis().set(K.intentUuidByIssue(issueNumber), uuid, { ex: INTENT_ISSUE_MAP_TTL });
}

export async function getIntentUuidByIssue(issueNumber) {
  return await getRedis().get(K.intentUuidByIssue(issueNumber));
}

// ---- helpers ------------------------------------------------------------

function newIntentUuid() {
  // 12 hex chars — collisions practically impossible at our scale and
  // short enough to fit in TG callback_data (64-byte limit).
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function normalizeMedia(m) {
  return {
    type: m.type,                   // 'photo' | 'video' | 'document'
    file_id: m.file_id,
    file_name: m.file_name || null,
    mime_type: m.mime_type || null,
    caption: (m.caption || '').trim(),
  };
}
