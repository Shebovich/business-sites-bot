// Lead pool — CRM-ядро lead-gen автоматизации (Ф1).
// Дизайн: LEADGEN_AUTOMATION_PLAN.md (в business-sites repo).
//
// Хранилище: Upstash Redis (переиспользуем клиент из state.mjs).
// Дедуп: глобально по handle (бизнес, по которому уже кто-то писал, не предлагается
// повторно НИКОМУ). Захват: атомарно через SREM из пула (первый забравший выигрывает).
//
// Ключи:
//   leads:all                  SET всех ключей (мембершип-дедуп)
//   lead:{key}                 JSON-запись лида
//   leads:pool:{niche}         SET доступных (status=new) ключей в нише — отсюда раздаём
//   leads:owner:{ownerId}      SET ключей, закреплённых за ассистентом
//   leads:reoffer              ZSET: score=время повторного предложения, member="{owner}::{key}" (skip-кулдаун)
//
// key = нормализованный handle (lowercase, без @). Один бизнес = один лид (любая ниша).

import { getRedis } from './state.mjs';

const r = () => getRedis();
const now = () => Date.now();
const SKIP_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

export const normKey = (handle) => String(handle || '').toLowerCase().replace(/^@/, '').trim();

const poolKey = (niche) => `leads:pool:${String(niche || 'misc').toLowerCase()}`;
const ownerKey = (ownerId) => `leads:owner:${ownerId}`;

export async function getLead(key) {
  return await r().get(`lead:${normKey(key)}`);
}

async function saveLead(rec) {
  rec.updated_at = now();
  await r().set(`lead:${rec.key}`, rec);
  return rec;
}

// Upsert с дедупом. Возвращает {added} или {dup}.
export async function upsertLead(lead) {
  const key = normKey(lead.handle);
  if (!key) return { error: 'no_handle' };
  const added = await r().sadd('leads:all', key); // 1 если новый, 0 если уже был
  if (!added) return { dup: true, key };
  const niche = String(lead.niche || 'misc').toLowerCase();
  const rec = {
    key, handle: lead.handle, name: lead.name || '', niche,
    kind: lead.kind || 'fb', profile_url: lead.profile_url || '',
    contact_url: lead.contact_url || '', needs_manual_ig: !!lead.needs_manual_ig,
    source: lead.source || 'adlib', status: 'new', owner: null,
    created_at: now(), updated_at: now(),
    history: [{ s: 'new', at: now() }],
  };
  await r().set(`lead:${key}`, rec);
  await r().sadd(poolKey(niche), key);
  await r().sadd('leads:available', key); // глобальный пул — выдаём лида без выбора ниши (#122)
  return { added: true, key };
}

export async function seedLeads(list) {
  let added = 0, dup = 0, err = 0;
  for (const l of list) {
    const res = await upsertLead(l);
    if (res.added) added++; else if (res.dup) dup++; else err++;
  }
  return { added, dup, err, total: list.length };
}

// Предложить лида ассистенту (soft — не блокирует). Берём случайного из пула ниши.
export async function offerNext(niche, ownerId) {
  const key = await r().srandmember(poolKey(niche));
  if (!key) return null;
  return await getLead(key);
}

// Предложить ЛЮБОГО свободного лида (без выбора ниши, #122).
export async function offerAny(ownerId) {
  const key = await r().srandmember('leads:available');
  if (!key) return null;
  return await getLead(key);
}

// Атомарный захват. SREM из пула возвращает 1 только первому → коллизий нет.
export async function takeLead(ownerId, key) {
  key = normKey(key);
  const rec = await getLead(key);
  if (!rec) return { ok: false, error: 'not_found' };
  const removed = await r().srem('leads:available', key); // атомарный захват из глобального пула
  if (removed === 0) return { ok: false, error: 'already_taken', by: rec.owner };
  await r().srem(poolKey(rec.niche), key);
  rec.owner = String(ownerId);
  rec.status = 'taken';
  rec.taken_at = now();
  rec.history.push({ s: 'taken', by: String(ownerId), at: now() });
  await saveLead(rec);
  await r().sadd(ownerKey(ownerId), key);
  return { ok: true, lead: rec };
}

// Пропуск: парковка, повторное предложение ТОМУ ЖЕ через 7 дней.
export async function skipLead(ownerId, key) {
  key = normKey(key);
  const rec = await getLead(key);
  if (!rec) return { ok: false, error: 'not_found' };
  await r().srem(poolKey(rec.niche), key);
  await r().srem('leads:available', key);
  const reAt = now() + SKIP_COOLDOWN_MS;
  await r().zadd('leads:reoffer', { score: reAt, member: `${ownerId}::${key}` });
  rec.status = 'skipped';
  rec.skipped_by = String(ownerId);
  rec.reoffer_at = reAt;
  rec.history.push({ s: 'skipped', by: String(ownerId), at: now() });
  await saveLead(rec);
  return { ok: true, reoffer_at: reAt };
}

// Отклонить с причиной — навсегда из пула.
export async function rejectLead(ownerId, key, reason = '') {
  key = normKey(key);
  const rec = await getLead(key);
  if (!rec) return { ok: false, error: 'not_found' };
  await r().srem(poolKey(rec.niche), key);
  await r().srem('leads:available', key);
  rec.status = 'rejected';
  rec.reject_reason = String(reason);
  rec.rejected_by = String(ownerId);
  rec.history.push({ s: 'rejected', by: String(ownerId), reason: String(reason), at: now() });
  await saveLead(rec);
  return { ok: true };
}

// Обновить статус (contacted, responded, in-build, ready, pitched, sold, lost, ghosted...).
export async function setStatus(key, status, by = null) {
  key = normKey(key);
  const rec = await getLead(key);
  if (!rec) return { ok: false, error: 'not_found' };
  rec.status = status;
  rec.history.push({ s: status, by: by ? String(by) : undefined, at: now() });
  await saveLead(rec);
  return { ok: true, lead: rec };
}

// Вернуть в пул лиды, у которых истёк skip-кулдаун. Запускать периодически (cron).
export async function releaseCooldowns() {
  const due = await r().zrange('leads:reoffer', 0, now(), { byScore: true });
  let released = 0;
  for (const member of due) {
    const idx = member.indexOf('::');
    const key = member.slice(idx + 2);
    const rec = await getLead(key);
    if (rec && rec.status === 'skipped') {
      rec.status = 'new';
      rec.history.push({ s: 'reoffered', at: now() });
      await saveLead(rec);
      await r().sadd(poolKey(rec.niche), key);
      await r().sadd('leads:available', key);
      released++;
    }
    await r().zrem('leads:reoffer', member);
  }
  return { released, checked: due.length };
}

export async function listByOwner(ownerId) {
  const keys = await r().smembers(ownerKey(ownerId));
  const out = [];
  for (const k of keys) { const rec = await getLead(k); if (rec) out.push(rec); }
  return out;
}

export async function poolStats(niche = null) {
  if (niche) return { niche, available: await r().scard(poolKey(niche)) };
  const total = await r().scard('leads:all');
  return { total_leads: total };
}

// --- Ниша ассистента (MVP; полноценный интервью-онбординг — позже, Ф2.1) ---
export const NICHES = ['матрасы', 'натяжные потолки', 'электромонтаж', 'сантехника', 'ремонт под ключ', 'кухни на заказ'];
export async function setNiche(chatId, niche) { await r().set(`assistant:niche:${chatId}`, String(niche || '')); }
export async function getNiche(chatId) { const v = await r().get(`assistant:niche:${chatId}`); return v || null; }

// --- Build-mode (Ф3): какой лид человек сейчас собирает через CC ---
// Пока set — все его сообщения (голос/текст/фото) идут в CC как [lead-build] этого лида.
export async function setBuilding(chatId, key) { await r().set(`lead:building:${chatId}`, normKey(key)); }
export async function getBuilding(chatId) { const v = await r().get(`lead:building:${chatId}`); return v || null; }
export async function clearBuilding(chatId) { await r().del(`lead:building:${chatId}`); }
