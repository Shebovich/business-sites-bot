// GET /api/claude/answer?sessionId=X
//
// Claude Code polls этот endpoint пока owner не tap'нет в TG.
// Returns answer JSON или 404 если ещё не было.
//
// Auth: X-Notify-Secret header.

import { getClaudeAnswer } from '../../scripts/bot/lib/state.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['CLAUDE_NOTIFY_SECRET']);
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
  const sessionId = (req.query?.sessionId || '').toString();
  if (!sessionId) {
    res.status(400).json({ ok: false, error: 'sessionId required' });
    return;
  }
  const answer = await getClaudeAnswer(sessionId);
  if (!answer) {
    res.status(404).json({ ok: false, pending: true });
    return;
  }
  res.status(200).json({ ok: true, ...answer });
}
