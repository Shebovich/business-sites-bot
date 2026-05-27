// Interview endpoint — combined start (POST) + result (GET) для Vercel
// Hobby 12-function limit. См. INTENT_ROUTER_PLAN.md "Hobby limits".
//
// POST /api/interview/start (or /api/interview):
//   body: { sessionId, target_chat_id, questions[{key,prompt,hint?}], intro? }
//   → creates session, sends Q1 via TG sendMessage
//
// GET /api/interview/result?sessionId=X (or /api/interview?sessionId=X):
//   → { ok, status: in_progress|completed|expired, answered, total, responses, started_at, completed_at }
//
// Auth: X-Notify-Secret (CLAUDE_NOTIFY_SECRET).

import {
  startInterviewSession,
  getInterviewSession,
  getInterviewAnswers,
} from '../../scripts/bot/lib/state.mjs';
import { tgApi } from '../../scripts/bot/lib/tg-api.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'CLAUDE_NOTIFY_SECRET']);
const SECRET = getEnv('CLAUDE_NOTIFY_SECRET').trim();

export default async function handler(req, res) {
  if (req.headers['x-notify-secret'] !== SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  if (req.method === 'POST') return handleStart(req, res);
  if (req.method === 'GET') return handleResult(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

async function handleStart(req, res) {
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }

  const { sessionId, target_chat_id, questions, intro } = body;
  if (!sessionId || !target_chat_id || !Array.isArray(questions) || !questions.length) {
    res.status(400).json({ ok: false, error: 'sessionId + target_chat_id + questions[] required' });
    return;
  }
  for (const q of questions) {
    if (!q.key || !q.prompt) {
      res.status(400).json({ ok: false, error: 'each question needs key + prompt' });
      return;
    }
  }

  await startInterviewSession(sessionId, { questions, targetChatId: target_chat_id });

  const q1 = questions[0];
  const lines = [];
  if (intro) lines.push(intro, '');
  lines.push(`📝 <b>Интервью</b> (1 из ${questions.length})`);
  lines.push('');
  lines.push(`<b>${esc(q1.prompt)}</b>`);
  if (q1.hint) lines.push('', `<i>${esc(q1.hint)}</i>`);
  lines.push('', '<i>Ответь свободным текстом одним сообщением. Чтобы прервать — /cancel_interview.</i>');

  try {
    await tgApi('sendMessage', {
      chat_id: String(target_chat_id),
      text: lines.join('\n'),
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('[interview/start] TG send failed:', e.message);
    res.status(500).json({ ok: false, error: `tg send failed: ${e.message}` });
    return;
  }

  res.status(200).json({ ok: true, sessionId, total_questions: questions.length });
}

async function handleResult(req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');
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

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
