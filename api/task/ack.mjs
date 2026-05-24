// POST /api/task/ack
//
// Wave 2 W2 — locked §24.11 Решение 3 (A3 hybrid).
//
// CC шлёт когда подхватывает webhook event и берёт issue в работу — это
// confirms «не просто heartbeat жив, но реально reactive Monitor сработал
// и agent chain запустился». Stores `cc:ack:{issue}` TTL 24h для diagnostics
// + защиты от false-alive (heartbeat есть, но Monitor мёртв).
//
// Auth: shared secret в `x-notify-secret` header.
//
// Body:
//   {
//     issue_number: <number>,
//     claimed_at?: ISO timestamp (default: now),
//     agent_chain?: ["builder", "design-reviewer", "tester"],
//     note?: string  // free-form e.g. "Mode fix" / "Mode skeleton"
//   }

import { setCcAck } from '../../scripts/bot/lib/state.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['CLAUDE_NOTIFY_SECRET']);
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

  const issueNumber = Number(body.issue_number);
  if (!issueNumber || !Number.isFinite(issueNumber)) {
    res.status(400).json({ ok: false, error: 'missing or invalid issue_number' });
    return;
  }

  try {
    const data = await setCcAck(issueNumber, {
      claimed_at: body.claimed_at,
      agent_chain: Array.isArray(body.agent_chain) ? body.agent_chain : [],
      note: body.note,
    });
    res.status(200).json({ ok: true, ttl_seconds: 24 * 60 * 60, stored: data });
  } catch (e) {
    console.error('[task/ack] failed:', e?.message, e?.stack);
    res.status(500).json({ ok: false, error: 'redis_failed', detail: e?.message });
  }
}
