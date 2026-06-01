// Assistant activity timeline (#202/#206) — подробная лента ВСЕГО, что
// ассистент писал боту: текст, расшифровка голосовых (+ file_id оригинала
// для проигрывания), фото/документы. Источник «ленты сообщений» в дашборде.
//
// Хранилище: Upstash Redis (клиент из state.mjs), ZSET по времени.
//   assistant:timeline:{chatId}   ZSET: score=ts, member=JSON записи
//
// Глубина — 30 дней (owner locked #206): при каждой записи срезаем старое.
// Ретро нет — лента наполняется только с момента включения логирования.

import { getRedis } from './state.mjs';

const r = () => getRedis();
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const MAX_ENTRIES = 3000;                       // safety cap на ассистента

const tlKey = (chatId) => `assistant:timeline:${String(chatId)}`;

// Записать одно входящее сообщение ассистента в его ленту.
// entry: { kind:'text'|'voice'|'photo'|'doc', text?, transcript?,
//          audio_file_id?, media_file_id?, lead_key?, lead_name? }
export async function appendTimeline(chatId, entry = {}) {
  if (!chatId) return;
  try {
    const ts = entry.ts || Date.now();
    const rec = { ts, ...entry };
    const key = tlKey(chatId);
    await r().zadd(key, { score: ts, member: JSON.stringify(rec) });
    // Срез по времени (30 дней) + жёсткий cap по количеству (защита от роста).
    await r().zremrangebyscore(key, 0, ts - RETENTION_MS);
    const n = await r().zcard(key);
    if (n > MAX_ENTRIES) await r().zremrangebyrank(key, 0, n - MAX_ENTRIES - 1);
  } catch (e) {
    // Лента — не критичный путь: не валим обработку сообщения если Redis моргнул.
    console.warn('[timeline] append failed:', e?.message);
  }
}

// Лента ассистента (по умолчанию вся в пределах retention), от старых к новым.
export async function getTimeline(chatId, sinceMs = 0) {
  try {
    const raw = await r().zrange(tlKey(chatId), sinceMs || 0, 99999999999999, { byScore: true });
    return (raw || [])
      .map((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    console.warn('[timeline] read failed:', e?.message);
    return [];
  }
}
