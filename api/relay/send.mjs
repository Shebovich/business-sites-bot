// POST /api/relay/send
//
// Generic CC → any TG chat relay. Used when Claude Code needs to message a
// user (assistant, owner, or arbitrary chat) without going through the
// intent-router pipeline.
//
// Auth: X-Notify-Secret (CLAUDE_NOTIFY_SECRET).
//
// Body:
//   {
//     chat_id: "<id>",        // TG chat ID (string or number)
//     text: "...",            // message text (max 4096 chars)
//     parse_mode?: "HTML" | "Markdown" | null,
//     disable_web_page_preview?: bool
//   }
//
// Response: { ok: true, message_id?: <N> } or { ok: false, error }.

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

  const { chat_id, text, parse_mode, disable_web_page_preview } = body;
  if (!chat_id || !text) {
    res.status(400).json({ ok: false, error: 'chat_id + text required' });
    return;
  }

  try {
    const tgResp = await tgApi('sendMessage', {
      chat_id: String(chat_id),
      text: String(text),
      ...(parse_mode ? { parse_mode } : {}),
      ...(disable_web_page_preview !== undefined ? { disable_web_page_preview } : {}),
    });
    res.status(200).json({ ok: true, message_id: tgResp?.message_id });
  } catch (e) {
    console.error('[relay/send] TG send failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
}
