// POST /api/interview/start
//
// CC initiates an interactive QnA session via TG. Bot шлёт first вопрос
// в target_chat, потом handleText branch ловит ответы и продвигает.
//
// Auth: X-Notify-Secret.
// Body: {
//   sessionId: "uuid",
//   target_chat_id: "<id>",        // assistant или owner chat
//   questions: [
//     { key: "killer_feature", prompt: "Что главное в...?", hint?: "опционально" }
//   ],
//   intro?: "опциональное вступление перед Q1"
// }
//
// CC сторона потом polls GET /api/interview/result?sessionId=X каждые 5s.

import { startInterviewSession } from '../../scripts/bot/lib/state.mjs';
import { tgApi } from '../../scripts/bot/lib/tg-api.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'CLAUDE_NOTIFY_SECRET']);
const SECRET = getEnv('CLAUDE_NOTIFY_SECRET').trim();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (req.headers['x-notify-secret'] !== SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

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

  // Шлём intro + Q1 одним сообщением.
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

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
