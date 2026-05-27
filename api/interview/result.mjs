// GET /api/interview/result?sessionId=X
//
// CC polls each ~5s после /start. Returns current state:
//   { ok, status: 'in_progress' | 'completed' | 'expired',
//     answered: <count>, total: <count>,
//     responses: { key: value, ... },
//     started_at, completed_at }

import { getInterviewSession, getInterviewAnswers } from '../../scripts/bot/lib/state.mjs';
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

  const sessionId = req.query?.sessionId || new URL(req.url, 'http://x').searchParams.get('sessionId');
  if (!sessionId) {
    res.status(400).json({ ok: false, error: 'sessionId required' });
    return;
  }

  const session = await getInterviewSession(sessionId);
  const answers = await getInterviewAnswers(sessionId);

  if (!session && !answers) {
    res.status(200).json({ ok: true, status: 'expired', responses: {}, answered: 0, total: 0 });
    return;
  }

  const total = session?.questions?.length || 0;
  const answered = Object.keys(answers?.responses || {}).length;
  const status = answers?.completed_at ? 'completed' : 'in_progress';

  res.status(200).json({
    ok: true,
    status,
    answered,
    total,
    responses: answers?.responses || {},
    started_at: answers?.started_at || null,
    completed_at: answers?.completed_at || null,
  });
}
