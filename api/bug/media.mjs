// GET /api/bug/media?file_id=X
//
// Resolves TG file_id → public HTTPS URL для download. Used by Claude Code
// чтобы видеть media в bug-репортах без TG token локально.
//
// Auth: X-Notify-Secret header (same secret).
//
// Response: { ok: true, url: "https://api.telegram.org/file/bot.../...", file_path: "photos/..." }

import { getFileUrl } from '../../scripts/bot/lib/tg-api.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'CLAUDE_NOTIFY_SECRET']);
const SECRET = getEnv('CLAUDE_NOTIFY_SECRET').trim();

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (req.headers['x-notify-secret'] !== SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  const fileId = (req.query?.file_id || '').toString().trim();
  if (!fileId) {
    res.status(400).json({ ok: false, error: 'file_id query param required' });
    return;
  }
  try {
    const url = await getFileUrl(fileId);
    res.status(200).json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
