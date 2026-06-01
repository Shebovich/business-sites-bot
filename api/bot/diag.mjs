export default async function handler(req, res) {
  const ownerId = process.env.TG_OWNER_CHAT_ID || '';
  const token = (process.env.TG_BOT_TOKEN || '').replace(/^﻿/, '').trim();

  // ?assistants=1 — список approved assistants с TG getChat metadata
  // (только если X-Notify-Secret валиден — содержит PII).
  if (req.url?.includes('assistants=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    try {
      const { getApprovedAssistants } = await import('../../scripts/bot/lib/state.mjs');
      const ids = await getApprovedAssistants();
      const enriched = await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${id}`);
          const j = await r.json();
          if (j.ok) {
            return { chat_id: id, first_name: j.result.first_name, last_name: j.result.last_name, username: j.result.username };
          }
          return { chat_id: id, error: j.description };
        } catch (e) {
          return { chat_id: id, error: e.message };
        }
      }));
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, count: enriched.length, assistants: enriched }, null, 2));
      return;
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
      return;
    }
  }

  // ?seedpool=1 — засев пула лидов из POST-тела { leads:[{handle,name,kind,profile_url,niche}] }. Gated. ВРЕМЕННОЕ.
  if (req.url?.includes('seedpool=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const L = await import('../../scripts/bot/lib/leads.mjs');
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const list = (body && body.leads) || [];
      const seeded = await L.seedLeads(list.map((l) => ({ ...l, source: 'adlib' })));
      // backfill глобального пула leads:available из всех нишевых пулов (для лидов, засеянных до #122)
      const { getRedis } = await import('../../scripts/bot/lib/state.mjs');
      const r2 = getRedis();
      const poolKeys = await r2.keys('leads:pool:*');
      let backfilled = 0;
      for (const pk of poolKeys) { if (pk.includes('__test__')) continue; const m = await r2.smembers(pk); if (m && m.length) { await r2.sadd('leads:available', ...m); backfilled += m.length; } }
      const available = await r2.scard('leads:available');
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, seeded, backfilled, available }, null, 2)); return;
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }

  // ?clearpool=1 — очистка ТОЛЬКО СВОБОДНЫХ лидов перед пересевом (gated).
  // КРИТИЧНО (#186): взятые/закреплённые лиды НЕ трогаем — они неприкосновенны.
  // Удаляем только записи без owner и со статусом new; нишевые пулы свободных; available.
  if (req.url?.includes('clearpool=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const { getRedis } = await import('../../scripts/bot/lib/state.mjs');
      const r2 = getRedis();
      let deleted = 0, kept = 0;
      const all = (await r2.smembers('leads:all')) || [];
      for (const k of all) {
        const l = await r2.get(`lead:${k}`);
        if (l && (l.owner || (l.status && l.status !== 'new'))) { kept++; continue; } // ВЗЯТОЕ — не трогаем
        await r2.del(`lead:${k}`); await r2.srem('leads:all', k); deleted++;
      }
      // нишевые пулы и available содержат только свободных — их безопасно пересобрать
      const pools = await r2.keys('leads:pool:*');
      for (const pk of pools) await r2.del(pk);
      await r2.del('leads:available'); await r2.del('leads:reoffer');
      // leads:owner:* и взятые lead:{key} остаются нетронутыми
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, deleted, kept_taken: kept }, null, 2)); return;
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }

  // ?claimlead=1 — добавить лида и сразу закрепить за владельцем (он уже написал сам),
  // чтобы дедуп не предлагал его никому. Body {handle,name,niche,owner,contact_url}. Gated.
  if (req.url?.includes('claimlead=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const L = await import('../../scripts/bot/lib/leads.mjs');
      let b = req.body; if (typeof b === 'string') b = JSON.parse(b);
      const owner = String(b.owner || process.env.TG_OWNER_CHAT_ID || '').trim();
      const up = await L.upsertLead({ handle: b.handle, name: b.name || '', kind: 'ig', niche: b.niche || 'свой', contact_url: b.contact_url || `https://ig.me/m/${L.normKey(b.handle)}`, profile_url: b.profile_url || `https://instagram.com/${L.normKey(b.handle)}`, source: 'owner-manual' });
      const key = up.key || L.normKey(b.handle);
      // обновить поля даже если лид уже был (исправление имени/ниши)
      const { getRedis } = await import('../../scripts/bot/lib/state.mjs');
      const rr = getRedis(); const rec = await rr.get(`lead:${key}`);
      if (rec) { if (b.name) rec.name = b.name; if (b.niche) rec.niche = b.niche; if (b.contact_url) rec.contact_url = b.contact_url; await rr.set(`lead:${key}`, rec); }
      const take = await L.takeLead(owner, key);
      if (take.ok) await L.setStatus(key, 'contacted', owner);
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, added: !!up.added, dup: !!up.dup, claimed: take.ok, key }, null, 2)); return;
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }

  // ?poolstats=1 — сводка по пулу лидов: всего, по статусам, по нишам, доступно. Gated.
  if (req.url?.includes('poolstats=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const { getRedis } = await import('../../scripts/bot/lib/state.mjs');
      const r2 = getRedis();
      const keys = (await r2.smembers('leads:all')) || [];
      const byStatus = {}, byNiche = {}; let withSite = 0;
      for (const k of keys) {
        const l = await r2.get(`lead:${k}`); if (!l) continue;
        byStatus[l.status || 'new'] = (byStatus[l.status || 'new'] || 0) + 1;
        byNiche[l.niche || '—'] = (byNiche[l.niche || '—'] || 0) + 1;
        if (l.has_site) withSite++;
      }
      const available = await r2.scard('leads:available');
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, total: keys.length, available, withSite, byStatus, byNiche }, null, 2)); return;
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }

  // ?dayreport=1 — сводка событий за сегодня (с полуночи по Минску) по действиям и людям. Gated.
  if (req.url?.includes('dayreport=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const L = await import('../../scripts/bot/lib/leads.mjs');
      const nowMs = Date.now();
      const minskNow = new Date(nowMs + 3 * 3600 * 1000); // UTC+3
      const midnightMinsk = nowMs - ((minskNow.getUTCHours() * 3600 + minskNow.getUTCMinutes() * 60 + minskNow.getUTCSeconds()) * 1000);
      const evs = await L.eventsSince(midnightMinsk);
      const byAction = {}, byWho = {};
      for (const e of evs) { byAction[e.action] = (byAction[e.action] || 0) + 1; byWho[e.who] = byWho[e.who] || {}; byWho[e.who][e.action] = (byWho[e.who][e.action] || 0) + 1; }
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, since: 'midnight-minsk', total_events: evs.length, byAction, byWho }, null, 2)); return;
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }

  // ?gemini=1 — health-probe каждого Gemini-ключа (voice transcription path).
  // Owner #204: голосовые должны работать + перепроверять при старте сессии.
  // Шлёт минимальный text generateContent на тот же model что и transcribe →
  // точный per-key статус (200 ok / 429 quota / 403 invalid key / 400 model).
  // Gated (секрет): делает реальные API-вызовы (расход квоты).
  if (req.url?.includes('gemini=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const GEMINI_MODEL = 'gemini-2.5-flash';
      const multi = (process.env.GEMINI_API_KEYS || '').trim();
      const keys = multi
        ? multi.split(',').map((k) => k.trim()).filter(Boolean)
        : ((process.env.GEMINI_API_KEY || '').trim() ? [process.env.GEMINI_API_KEY.trim()] : []);
      if (!keys.length) { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'no GEMINI_API_KEYS / GEMINI_API_KEY configured', keys: 0 }, null, 2)); return; }
      const body = { contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1, temperature: 0 } };
      const probes = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const prefix = key.slice(0, 6) + '…' + key.slice(-3);
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          let detail = '';
          if (!r.ok) { const t = await r.text(); detail = t.slice(0, 160); }
          probes.push({ idx: i + 1, key: prefix, status: r.status, ok: r.ok });
          if (detail) probes[probes.length - 1].detail = detail;
        } catch (e) {
          probes.push({ idx: i + 1, key: prefix, status: 0, ok: false, detail: e.message });
        }
      }
      const anyOk = probes.some((p) => p.ok);
      const allQuota = probes.length > 0 && probes.every((p) => p.status === 429);
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: anyOk, model: GEMINI_MODEL, keys: keys.length, healthy: probes.filter((p) => p.ok).length, all_quota_exhausted: allQuota, probes }, null, 2));
      return;
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); return; }
  }

  // ?transcribe=1 — end-to-end проверка голоса: POST {file_id} → реальный
  // transcribeTgVoice (тот же путь что в handleVoice). Возвращает транскрипт
  // или ошибку. Для верификации фикса #204 + ручной диагностики. Gated.
  if (req.url?.includes('transcribe=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      let b = req.body; if (typeof b === 'string') b = JSON.parse(b);
      const fileId = b?.file_id;
      if (!fileId) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'file_id required in body' })); return; }
      const { transcribeTgVoice } = await import('../../scripts/bot/lib/voice-transcribe.mjs');
      const t0 = Date.now();
      const transcript = await transcribeTgVoice(fileId);
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ms: Date.now() - t0, length: transcript.length, transcript }, null, 2));
      return;
    } catch (e) {
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: e.message }, null, 2));
      return;
    }
  }

  // Identify bot via getMe so мы знаем КАКОМУ именно боту owner должен писать /start.
  let botInfo = null;
  let getMeError = null;
  if (token) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const j = await r.json();
      if (j.ok) {
        botInfo = { id: j.result.id, username: j.result.username, first_name: j.result.first_name };
      } else {
        getMeError = `HTTP ${r.status}: ${j.description || 'unknown'}`;
      }
    } catch (e) {
      getMeError = e.message;
    }
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    TG_OWNER_CHAT_ID: {
      raw: ownerId,
      length: ownerId.length,
      asNumber: Number(ownerId),
    },
    TG_BOT_TOKEN_present: token.length > 0,
    TG_BOT_TOKEN_length: token.length,
    bot_identity: botInfo,
    bot_identity_error: getMeError,
    UPSTASH_URL_present: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_TOKEN_present: !!process.env.UPSTASH_REDIS_REST_TOKEN,
  }, null, 2));
}
