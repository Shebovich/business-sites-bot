// GET /api/intent/poll
//
// Vercel cron entry — fires каждую минуту. Сканит Redis assistant-intent:*
// для записей idle >=30s и материализует их в GH issues с label intent-pending.
// (Debounce 30s + cron 1m = total latency assistant-message → GH issue ~30-90s.
// Assistant сразу получает «принял, жду Pavel» — latency скрыта.)
//
// Auth: Vercel cron sends Authorization: Bearer ${CRON_SECRET}. Local /
// manual triggers via x-cron-secret header also accepted.
//
// See INTENT_ROUTER_PLAN.md Phase C2.

import { runCronPoll } from '../../scripts/bot/lib/intent.mjs';
import { getEnv } from '../../scripts/bot/config.mjs';

const CRON_SECRET = (getEnv('CRON_SECRET') || '').trim();

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    const headerSecret = req.headers['x-cron-secret'] || '';
    const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
    const provided = bearerMatch ? bearerMatch[1] : headerSecret;
    if (provided !== CRON_SECRET) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  try {
    const results = await runCronPoll({ idleSeconds: 30 });
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    res.status(200).json({
      ok: true,
      scanned: results.length,
      materialized: ok,
      failed,
      results,
    });
  } catch (e) {
    console.error('[intent/poll] runCronPoll fatal:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
