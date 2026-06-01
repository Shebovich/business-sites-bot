// Dashboard data aggregator (#202/#205/#206). Lib (НЕ serverless function —
// Hobby plan лимит 12 функций). Вызывается из api/bot/diag.mjs веткой
// ?dashboard=1. Owner-only (gating в diag).
//
// Per-assistant: имя (getChat), уровень/XP (trust+события), «сейчас занят»,
// счётчики за день, лиды+прототипы (edits из timeline+history), лента 30д,
// + дневной лидерборд. Медиа ленты фронт тянет через /api/bug/media?file_id=.

import { getApprovedAssistants } from './state.mjs';
import { listByOwner, eventsSince, getNiche, getBuilding, getLead } from './leads.mjs';
import { getTrust } from './trust.mjs';
import { getTimeline } from './timeline.mjs';

const XP = { take: 1, contacted: 2, 'in-build': 3, 'owner-review': 5, approved: 7, sold: 10 };
const levelFromXp = (xp) => Math.floor(Math.sqrt(xp / 3)) + 1; // 3xp→L2, 12→L3, 27→L4...
const ACTIVE_STATUSES = ['taken', 'contacted', 'in-build', 'owner-review'];

function midnightMinskMs() {
  const nowMs = Date.now();
  const m = new Date(nowMs + 3 * 3600 * 1000);
  return nowMs - ((m.getUTCHours() * 3600 + m.getUTCMinutes() * 60 + m.getUTCSeconds()) * 1000);
}

async function resolveName(tgToken, chatId) {
  if (!tgToken) return `id:${chatId}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/getChat?chat_id=${chatId}`);
    const j = await r.json();
    if (j.ok) {
      const full = `${j.result.first_name || ''} ${j.result.last_name || ''}`.trim();
      return full || (j.result.username ? `@${j.result.username}` : `id:${chatId}`);
    }
  } catch {}
  return `id:${chatId}`;
}

export async function buildDashboardData(tgToken) {
  const ids = await getApprovedAssistants();
  const sinceDay = midnightMinskMs();

  const assistants = await Promise.all(ids.map(async (id) => {
    const chatId = String(id);
    const [leads, allEvents, dayEvents, niche, building, trust, timeline, name] = await Promise.all([
      listByOwner(chatId).catch(() => []),
      eventsSince(0, chatId).catch(() => []),
      eventsSince(sinceDay, chatId).catch(() => []),
      getNiche(chatId).catch(() => null),
      getBuilding(chatId).catch(() => null),
      getTrust(chatId).catch(() => ({})),
      getTimeline(chatId).catch(() => []),
      resolveName(tgToken, chatId),
    ]);

    let xp = 0;
    for (const e of allEvents) xp += (XP[e.action] || 0);

    const today = { taken: 0, contacted: 0, built: 0, sold: 0 };
    for (const e of dayEvents) {
      if (e.action === 'take') today.taken++;
      else if (e.action === 'contacted') today.contacted++;
      else if (e.action === 'in-build') today.built++;
      else if (e.action === 'sold') today.sold++;
    }

    let current = null;
    if (building) {
      const l = await getLead(building).catch(() => null);
      current = { lead_key: building, name: (l && (l.name || l.handle)) || building, status: (l && l.status) || 'in-build' };
    } else {
      const act = leads.filter((l) => ACTIVE_STATUSES.includes(l.status));
      if (act.length) current = { lead_key: act[0].key, name: act[0].name || act[0].handle, status: act[0].status };
    }

    const tlByLead = {};
    for (const t of timeline) if (t.lead_key) (tlByLead[t.lead_key] ||= []).push(t);
    const leadCards = leads
      .filter((l) => !['rejected', 'skipped'].includes(l.status))
      .map((l) => ({
        key: l.key,
        name: l.name || l.handle,
        status: l.status,
        niche: l.niche || null,
        profile_url: l.profile_url || l.contact_url || null,
        prototype_url: l.prototype_url || l.site_url || null,
        has_built: ['in-build', 'owner-review', 'pitched', 'sold'].includes(l.status) || !!l.prototype_url,
        history: Array.isArray(l.history) ? l.history : [],
        edits: (tlByLead[l.key] || []).map((t) => ({ ts: t.ts, kind: t.kind, text: t.text, transcript: t.transcript })),
      }));

    const lastTs = Math.max(
      timeline.length ? timeline[timeline.length - 1].ts : 0,
      allEvents.length ? Math.max(...allEvents.map((e) => e.ts || 0)) : 0,
    );
    const online = lastTs > 0 && (Date.now() - lastTs) < 15 * 60 * 1000;

    return {
      chat_id: chatId, name, niche,
      level: levelFromXp(xp), xp,
      trust: trust?.level || 'new', streak: trust?.streak || 0,
      online, last_active: lastTs || null,
      current, today, leads: leadCards, timeline,
    };
  }));

  const leaderboard = assistants
    .map((a) => ({
      chat_id: a.chat_id, name: a.name, level: a.level, xp: a.xp,
      day_score: a.today.taken * XP.take + a.today.contacted * XP.contacted + a.today.built * XP['in-build'] + a.today.sold * XP.sold,
    }))
    .sort((x, y) => y.day_score - x.day_score || y.xp - x.xp);

  return { ok: true, generated_at: Date.now(), assistants, leaderboard };
}
