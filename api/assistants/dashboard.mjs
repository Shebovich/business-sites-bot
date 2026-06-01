// GET /api/assistants/dashboard — агрегатор данных дашборда ассистентов
// (#202/#205/#206). Owner-only: токен в заголовке x-notify-secret ИЛИ ?t=<secret>
// (фронт открывается в браузере по ссылке с токеном).
//
// Отдаёт на каждого approved-ассистента: имя (getChat), уровень/XP (trust+события),
// «сейчас занят», счётчики за день, лиды+прототипы, лента сообщений 30д, лидерборд.
//
// Медиа ленты (голос/фото) фронт тянет лениво через /api/bug/media?file_id=.

import { getApprovedAssistants } from '../../scripts/bot/lib/state.mjs';
import { listByOwner, eventsSince, getNiche, getBuilding, getLead } from '../../scripts/bot/lib/leads.mjs';
import { getTrust } from '../../scripts/bot/lib/trust.mjs';
import { getTimeline } from '../../scripts/bot/lib/timeline.mjs';

// XP за действия (#206 геймификация). Считаем по всему журналу событий.
const XP = { take: 1, contacted: 2, 'in-build': 3, 'owner-review': 5, approved: 7, sold: 10 };
const levelFromXp = (xp) => Math.floor(Math.sqrt(xp / 3)) + 1; // плавный рост: 3xp→L2, 12→L3, 27→L4...
const ACTIVE_STATUSES = ['taken', 'contacted', 'in-build', 'owner-review'];

function midnightMinskMs() {
  const nowMs = Date.now();
  const m = new Date(nowMs + 3 * 3600 * 1000); // UTC+3
  return nowMs - ((m.getUTCHours() * 3600 + m.getUTCMinutes() * 60 + m.getUTCSeconds()) * 1000);
}

export default async function handler(req, res) {
  const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
  const token = req.headers['x-notify-secret'] || (req.url.match(/[?&]t=([^&]+)/) || [])[1];
  if (!SECRET || token !== SECRET) {
    res.statusCode = 401; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return;
  }

  const tgToken = (process.env.TG_BOT_TOKEN || '').replace(/^﻿/, '').trim();

  try {
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

      // XP по всем событиям.
      let xp = 0;
      for (const e of allEvents) xp += (XP[e.action] || 0);

      // Счётчики за день.
      const today = { taken: 0, contacted: 0, built: 0, sold: 0 };
      for (const e of dayEvents) {
        if (e.action === 'take') today.taken++;
        else if (e.action === 'contacted') today.contacted++;
        else if (e.action === 'in-build') today.built++;
        else if (e.action === 'sold') today.sold++;
      }

      // «Сейчас занят» — строящийся лид, иначе самый свежий активный.
      let current = null;
      if (building) {
        const l = await getLead(building).catch(() => null);
        current = { lead_key: building, name: (l && (l.name || l.handle)) || building, status: (l && l.status) || 'in-build' };
      } else {
        const act = leads.filter((l) => ACTIVE_STATUSES.includes(l.status));
        if (act.length) current = { lead_key: act[0].key, name: act[0].name || act[0].handle, status: act[0].status };
      }

      // Лиды + прототипы. edits = сообщения ленты по этому лиду + история статусов.
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

      // Онлайн — была активность за последние 15 мин (по ленте или событиям).
      const lastTs = Math.max(
        timeline.length ? timeline[timeline.length - 1].ts : 0,
        allEvents.length ? Math.max(...allEvents.map((e) => e.ts || 0)) : 0,
      );
      const online = lastTs > 0 && (Date.now() - lastTs) < 15 * 60 * 1000;

      return {
        chat_id: chatId,
        name,
        niche,
        level: levelFromXp(xp),
        xp,
        trust: trust?.level || 'new',
        streak: trust?.streak || 0,
        online,
        last_active: lastTs || null,
        current,
        today,
        leads: leadCards,
        timeline, // полная лента 30д (file_id'ы — фронт резолвит через /api/bug/media)
      };
    }));

    // Лидерборд за день (по очкам действий сегодня) + всего XP.
    const leaderboard = assistants
      .map((a) => {
        let dayScore = 0;
        dayScore += a.today.taken * XP.take + a.today.contacted * XP.contacted + a.today.built * XP['in-build'] + a.today.sold * XP.sold;
        return { chat_id: a.chat_id, name: a.name, day_score: dayScore, xp: a.xp, level: a.level };
      })
      .sort((x, y) => y.day_score - x.day_score || y.xp - x.xp);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, generated_at: Date.now(), assistants, leaderboard }, null, 2));
  } catch (e) {
    res.statusCode = 500; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function resolveName(tgToken, chatId) {
  if (!tgToken) return `id:${chatId}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tgToken}/getChat?chat_id=${chatId}`);
    const j = await r.json();
    if (j.ok) {
      const fn = j.result.first_name || '';
      const ln = j.result.last_name || '';
      const un = j.result.username ? `@${j.result.username}` : '';
      return (`${fn} ${ln}`.trim() || un || `id:${chatId}`);
    }
  } catch {}
  return `id:${chatId}`;
}
