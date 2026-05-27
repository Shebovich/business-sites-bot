// Claude QnA — combined question (POST) + answer (GET) для Vercel
// Hobby 12-function limit. URL preserved via rewrites:
//   /api/claude/question → here (POST handles inline-keyboard ask)
//   /api/claude/answer  → here (GET handles answer poll)
//
// Auth: X-Notify-Secret (CLAUDE_NOTIFY_SECRET).

import { setClaudeQuestion, getClaudeAnswer } from '../../scripts/bot/lib/state.mjs';
import { tgApi } from '../../scripts/bot/lib/tg-api.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'TG_OWNER_CHAT_ID', 'CLAUDE_NOTIFY_SECRET']);
const OWNER_ID = String(getEnv('TG_OWNER_CHAT_ID')).trim();
const SECRET = getEnv('CLAUDE_NOTIFY_SECRET').trim();

export default async function handler(req, res) {
  if (req.headers['x-notify-secret'] !== SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  if (req.method === 'POST') return handleQuestion(req, res);
  if (req.method === 'GET') return handleAnswer(req, res);
  res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

async function handleQuestion(req, res) {
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { res.status(400).json({ ok: false, error: 'invalid_json' }); return; }

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

  await setClaudeQuestion(sessionId, { question, options, context });

  const inline_keyboard = options.map(o => [{
    text: o.label,
    callback_data: `claude_ans:${sessionId}:${o.key}`,
  }]);

  const lines = [`🤖 <b>Claude Code спрашивает:</b>`, '', esc(question)];
  if (context) lines.push('', `<i>${esc(context)}</i>`);
  if (options.some(o => o.description)) {
    lines.push('');
    for (const o of options) {
      if (o.description) lines.push(`• <b>${esc(o.label)}</b> — ${esc(o.description)}`);
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

async function handleAnswer(req, res) {
  const url = new URL(req.url, 'http://x');
  const sessionId = (req.query?.sessionId || url.searchParams.get('sessionId') || '').toString();
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

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
