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

  // ?clearpool=1 — полная очистка пула лидов перед пересевом (gated). ВРЕМЕННОЕ.
  if (req.url?.includes('clearpool=1')) {
    const SECRET = (process.env.CLAUDE_NOTIFY_SECRET || '').trim();
    if (req.headers['x-notify-secret'] !== SECRET) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    try {
      const { getRedis } = await import('../../scripts/bot/lib/state.mjs');
      const r2 = getRedis();
      let deleted = 0;
      for (const pat of ['lead:*', 'leads:pool:*', 'leads:owner:*']) {
        const ks = await r2.keys(pat);
        for (const k of ks) { await r2.del(k); deleted++; }
      }
      for (const k of ['leads:all', 'leads:available', 'leads:reoffer']) { await r2.del(k); deleted++; }
      res.statusCode = 200; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, deleted }, null, 2)); return;
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
