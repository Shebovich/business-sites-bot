// POST /api/claude/question
//
// Claude Code → bot → owner TG. Отправляет inline keyboard с опциями.
// Owner tap'ает → callback claude_ans:{sessionId}:{key} → bot stores answer.
// Claude Code polls /api/claude/answer пока не получит.
//
// Auth: X-Notify-Secret (тот же CLAUDE_NOTIFY_SECRET что у /api/task/notify).
//
// Body:
//   {
//     sessionId: "uuid-or-string",
//     question: "Что делаем?",
//     context?: "optional details",
//     options: [{ label: "Yes", key: "yes", description?: "..." }, ...]
//   }
//
// Response: { ok: true, sentTo: chatId } или { ok: false, error }.

import { setClaudeQuestion } from '../../scripts/bot/lib/state.mjs';
import { tgApi } from '../../scripts/bot/lib/tg-api.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'TG_OWNER_CHAT_ID', 'CLAUDE_NOTIFY_SECRET']);
const OWNER_ID = String(getEnv('TG_OWNER_CHAT_ID')).trim();
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
  const { sessionId, question, options, context } = body;
  if (!sessionId || !question || !Array.isArray(options) || options.length === 0) {
    res.status(400).json({ ok: false, error: 'sessionId + question + options[] required' });
    return;
  }
  if (options.length > 8) {
    res.status(400).json({ ok: false, error: 'max 8 options per question' });
    return;
  }
  for (const o of options) {
    if (!o.label || !o.key) {
      res.status(400).json({ ok: false, error: 'each option needs label + key' });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(o.key)) {
      res.status(400).json({ ok: false, error: `bad key "${o.key}" — must be [a-zA-Z0-9_-]{1,40}` });
      return;
    }
  }

  // Persist question (so /answer endpoint можно cross-reference).
  await setClaudeQuestion(sessionId, { question, options, context });

  // Build inline keyboard — one button per option, one per row (read-friendly).
  const inline_keyboard = options.map(o => [{
    text: o.label,
    callback_data: `claude_ans:${sessionId}:${o.key}`,
  }]);

  const lines = [`🤖 <b>Claude Code спрашивает:</b>`, '', escapeHtml(question)];
  if (context) lines.push('', `<i>${escapeHtml(context)}</i>`);
  if (options.some(o => o.description)) {
    lines.push('');
    for (const o of options) {
      if (o.description) lines.push(`• <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description)}`);
    }
  }

  try {
    await tgApi('sendMessage', {
      chat_id: OWNER_ID,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: `tg send failed: ${e.message}` });
    return;
  }

  res.status(200).json({ ok: true, sentTo: OWNER_ID, sessionId });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
