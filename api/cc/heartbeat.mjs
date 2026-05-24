// POST /api/cc/heartbeat
//
// Wave 2 W2 — locked §24.11 Решение 3 (A3 hybrid).
//
// Claude Code (`/start-session` skill background loop) шлёт сюда каждые 60s
// пока сессия активна. Бот хранит `cc:heartbeat:{owner_chat}` в Redis TTL 180s.
// Stale heartbeat (TTL expired) = сессия выключена / зависла → бот в
// github-webhook handler видит и HOLD'ит работу + ping owner (см. W3).
//
// Auth: shared secret в `x-notify-secret` header (env: CLAUDE_NOTIFY_SECRET).
//
// Body:
//   {
//     owner_chat_id?: string,    // default = TG_OWNER_CHAT_ID env
//     started_at?: ISO timestamp, // время запуска текущей сессии (для дебага)
//     cwd?: string,              // working directory Claude Code (для дебага)
//     host?: string,             // hostname (Mac/Windows)
//     pid?: number               // PID процесса CC (для дебага)
//   }
//
// Response: { ok: true, ttl_seconds: 180 }

import { setCcHeartbeat } from '../../scripts/bot/lib/state.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_OWNER_CHAT_ID', 'CLAUDE_NOTIFY_SECRET']);
const OWNER_ID = String(getEnv('TG_OWNER_CHAT_ID')).trim();
const SECRET = getEnv('CLAUDE_NOTIFY_SECRET').trim();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const provided = req.headers['x-notify-secret'];
  if (!provided || provided !== SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

  const ownerChatId = String(body.owner_chat_id || OWNER_ID).trim();
  if (!ownerChatId) {
    res.status(400).json({ ok: false, error: 'missing owner_chat_id' });
    return;
  }

  try {
    const data = await setCcHeartbeat(ownerChatId, {
      started_at: body.started_at,
      cwd: body.cwd,
      host: body.host,
      pid: body.pid,
    });
    res.status(200).json({ ok: true, ttl_seconds: 180, stored: data });
  } catch (e) {
    console.error('[cc/heartbeat] failed:', e?.message, e?.stack);
    res.status(500).json({ ok: false, error: 'redis_failed', detail: e?.message });
  }
}
