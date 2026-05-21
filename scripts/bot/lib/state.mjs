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
};

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
// Unlike clearTask above, this scans for every `task:{N}:*` key — including
// per-section photo lists, round counter, hash, assistant_chat_id — so the
// next visual-review session for the same slug starts clean. Mirrors the
// logic in scripts/bot/clear-task.mjs (CLI helper) for the in-bot path.
export async function clearTaskState(issueNumber) {
  const r = getRedis();
  const prefix = `task:${issueNumber}:`;
  let cursor = 0;
  const allKeys = [];
  do {
    const [next, batch] = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
    cursor = Number(next);
    for (const k of batch) allKeys.push(k);
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
