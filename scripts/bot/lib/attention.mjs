// Owner Attention Queue (Ф5.5) — единый классифицированный inbox всего, что требует owner.
// Дизайн: LEADGEN_AUTOMATION_PLAN.md §4.9. Делает систему «умной»: проактивно ловит
// проблемы, типизирует, приоритизирует, фильтрует рутину.
//
// Хранилище (Upstash Redis):
//   attn:counter              INCR — id
//   attn:item:{id}            JSON-запись элемента
//   attn:open                 ZSET открытых (score = prio*1e13 + created_sec) — urgent сверху, дальше FIFO
//   attn:snooze               ZSET отложенных (score = время пробуждения)
//   attn:dedup:{fingerprint}  TTL-ключ против повторного создания одной и той же аномалии
//
// Слой ума = Claude Code (классификация свободной речи, баги из логов). Бот = ввод/вывод
// + rule-based сканер аномалий по данным лидов (server-side, т.к. CC не имеет доступа к Redis).

import { getRedis } from './state.mjs';
import * as Leads from './leads.mjs';

const r = () => getRedis();
const now = () => Date.now();
const SEC = () => Math.floor(now() / 1000);

export const PRIO = { urgent: 0, normal: 1, info: 2 };
export const TYPE_EMOJI = { prototype: '🧩', bug: '🐞', recommendation: '💡', access: '🔑', anomaly: '⚠️', escalation: '🆘' };
export const TYPE_LABEL = { prototype: 'Прототип на ревью', bug: 'Баг/сбой', recommendation: 'Рекомендация', access: 'Запрос доступа', anomaly: 'Аномалия', escalation: 'Эскалация' };

const scoreOf = (prio, createdMs) => (PRIO[prio] ?? 1) * 1e13 + Math.floor((createdMs || now()) / 1000);

// Создать элемент. fingerprint → дедуп (аномалии не спамят). Возвращает {id,rec} или {deduped:true}.
export async function addItem(it) {
  if (it.fingerprint) {
    const fresh = await r().set(`attn:dedup:${it.fingerprint}`, '1', { nx: true, ex: it.dedupTtl || 21600 });
    if (!fresh) return { deduped: true };
  }
  const id = await r().incr('attn:counter');
  const rec = {
    id, type: it.type || 'escalation', priority: it.priority || 'normal',
    title: it.title || '(без названия)', detail: it.detail || '',
    initiator: it.initiator || '', lead_key: it.lead_key || '', url: it.url || '',
    suggested_action: it.suggested_action || '', source: it.source || 'cc',
    fixed: !!it.fixed, status: 'open', created_at: now(),
  };
  await r().set(`attn:item:${id}`, rec);
  await r().zadd('attn:open', { score: scoreOf(rec.priority, rec.created_at), member: String(id) });
  return { id, rec };
}

export async function getItem(id) { return await r().get(`attn:item:${id}`); }

export async function listOpen(limit = 50) {
  const ids = await r().zrange('attn:open', 0, limit - 1);
  const out = [];
  for (const id of ids) { const it = await getItem(id); if (it && it.status === 'open') out.push(it); }
  return out;
}

// status: done | dismissed | snoozed | open
export async function setStatus(id, status) {
  const it = await getItem(id);
  if (!it) return null;
  it.status = status; it.updated_at = now();
  await r().set(`attn:item:${id}`, it);
  if (status === 'snoozed') {
    await r().zrem('attn:open', String(id));
    await r().zadd('attn:snooze', { score: now() + 4 * 3600 * 1000, member: String(id) });
  } else if (status === 'open') {
    await r().zadd('attn:open', { score: scoreOf(it.priority, it.created_at), member: String(id) });
  } else {
    await r().zrem('attn:open', String(id));
  }
  return it;
}

// Вернуть отложенные, у которых наступило время — обратно в open. Вызывается из cron-дайджеста.
export async function wakeSnoozed() {
  const due = await r().zrange('attn:snooze', 0, now(), { byScore: true });
  for (const id of due) {
    const it = await getItem(id);
    if (it) { it.status = 'open'; await r().set(`attn:item:${id}`, it); await r().zadd('attn:open', { score: scoreOf(it.priority, it.created_at), member: String(id) }); }
    await r().zrem('attn:snooze', String(id));
  }
  return due.length;
}

// Закрыть открытые элементы по лиду (напр. прототип одобрен/ушёл в правки).
export async function doneByLead(leadKey, type = null) {
  const items = await listOpen(200);
  let n = 0;
  for (const it of items) { if (it.lead_key === leadKey && (!type || it.type === type)) { await setStatus(it.id, 'done'); n++; } }
  return n;
}

export async function counts() {
  const items = await listOpen(200);
  const byType = {}; let urgent = 0;
  for (const it of items) { byType[it.type] = (byType[it.type] || 0) + 1; if (it.priority === 'urgent') urgent++; }
  return { total: items.length, urgent, byType };
}

// --- Форматтеры (TG-агностичные: возвращают text + reply_markup) ---
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const who = (init) => (init && /^\d+$/.test(String(init)) ? `ассистент ${init}` : init);

export function itemText(it) {
  const lines = [`${TYPE_EMOJI[it.type] || '•'} <b>${esc(it.title)}</b> <i>#${it.id}</i>`];
  if (it.detail) lines.push(esc(it.detail));
  if (it.initiator) lines.push(`👤 ${esc(who(it.initiator))}`);
  if (it.suggested_action) lines.push(`▶️ ${esc(it.suggested_action)}`);
  if (it.fixed) lines.push('<i>(уже починил автоматически — это на заметку)</i>');
  return lines.join('\n');
}

export function itemKeyboard(it) {
  const rows = [];
  if (it.url) rows.push([{ text: '🔗 Открыть', url: it.url }]);
  rows.push([{ text: '✅ Ок', callback_data: `attn:done:${it.id}` }, { text: '✏️ Правки', callback_data: `attn:fix:${it.id}` }]);
  rows.push([{ text: '🔕 Отложить', callback_data: `attn:snooze:${it.id}` }, { text: '🗑 Не важно', callback_data: `attn:dismiss:${it.id}` }]);
  return { inline_keyboard: rows };
}

export function digestText(items, c, period) {
  const head = `📋 <b>Сводка (${period})</b>`;
  if (!items.length) return `${head}\n\nЧисто — ничего не ждёт твоего решения. 👌`;
  const order = ['prototype', 'bug', 'recommendation', 'access', 'anomaly', 'escalation'];
  const rows = order.filter((t) => c.byType[t]).map((t) => `${TYPE_EMOJI[t]} ${TYPE_LABEL[t]}: <b>${c.byType[t]}</b>`);
  const top = items.slice(0, 6).map((it) => `${TYPE_EMOJI[it.type] || '•'} <i>#${it.id}</i> ${esc(it.title)}${it.initiator ? ` — ${esc(who(it.initiator))}` : ''}`);
  return [head, '', ...rows, c.urgent ? `\n🔔 срочных: <b>${c.urgent}</b>` : '', '', '<b>Ждут:</b>', ...top, items.length > 6 ? `…и ещё ${items.length - 6}` : ''].filter((x) => x !== '').join('\n');
}

export function digestKeyboard() {
  return { inline_keyboard: [[{ text: '📥 Открыть очередь', callback_data: 'attn:list' }]] };
}

// --- Rule-based сканер аномалий (server-side: CC не имеет доступа к Redis) ---
// Ловит «всё»: зависшие лиды, кончающийся пул. Идемпотентно через dedup-fingerprints.
const DAY = 24 * 3600 * 1000;
export async function scanAnomalies() {
  const created = [];
  // 1. Лиды, зависшие в статусе
  let keys = [];
  try { keys = await r().smembers('leads:all'); } catch { keys = []; }
  for (const key of keys) {
    const l = await Leads.getLead(key);
    if (!l) continue;
    const age = now() - (l.updated_at || l.created_at || now());
    if (l.status === 'taken' && age > 2 * DAY) {
      const res = await addItem({ type: 'anomaly', priority: 'normal', title: `Лид взят, но не написан 2д+: ${l.name || l.handle}`, detail: `Ассистент взял «${l.name || l.handle}», но не отметил «написал в ЛС» уже ${Math.floor(age / DAY)}д.`, initiator: String(l.owner || ''), lead_key: key, suggested_action: 'Пинговать ассистента или вернуть лида в пул', fingerprint: `stuck-taken-${key}`, dedupTtl: DAY, source: 'scan' });
      if (res.id) created.push(res.id);
    } else if (l.status === 'contacted' && age > 5 * DAY) {
      const res = await addItem({ type: 'anomaly', priority: 'normal', title: `Лид «остывает»: ${l.name || l.handle}`, detail: `Контакт был, но 5д+ нет движения (статус contacted).`, initiator: String(l.owner || ''), lead_key: key, suggested_action: 'Проверить, ответил ли лид; не тянет ли ассистент', fingerprint: `cooling-${key}`, dedupTtl: 2 * DAY, source: 'scan' });
      if (res.id) created.push(res.id);
    }
  }
  // 2. Пул ниши заканчивается
  for (const niche of Leads.NICHES) {
    const { available } = await Leads.poolStats(niche);
    if (available != null && available < 3) {
      const res = await addItem({ type: 'anomaly', priority: 'normal', title: `Пул ниши «${niche}» заканчивается (${available})`, detail: `Свободных лидов в нише ${niche}: ${available}. Нужен новый сорсинг (Ad Library).`, suggested_action: 'Запустить сорсинг Ad Library по нише', fingerprint: `pool-low-${niche}`, dedupTtl: DAY, source: 'scan' });
      if (res.id) created.push(res.id);
    }
  }
  return { created: created.length, ids: created };
}
