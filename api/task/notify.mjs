// POST /api/task/notify
//
// Endpoint Claude Code (local /process-tg-tasks pipeline) calls to push
// progress / completion / blocker messages to both the assistant who
// submitted the review and the owner.
//
// Auth: shared secret in X-Notify-Secret header (env: CLAUDE_NOTIFY_SECRET).
//
// Body:
//   {
//     issue: <number>,        // GitHub issue number
//     stage: "in_progress" | "heartbeat" | "blocked" | "done" | "needs_fix",
//     preview_url?: string,   // for stage=done
//     reason?: string,        // for stage=blocked or stage=needs_fix
//     progress?: string       // for stage=heartbeat (e.g. "builder: 3/5")
//   }
//
// Side effects: sends 1 TG message to owner + 1 to assistant (if known).

import { getAssistantChatId } from '../../scripts/bot/lib/state.mjs';
import { sendMessage } from '../../scripts/bot/lib/tg-api.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'TG_OWNER_CHAT_ID', 'CLAUDE_NOTIFY_SECRET']);
const OWNER_ID = String(getEnv('TG_OWNER_CHAT_ID')).trim();
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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ ok: false, error: 'invalid_json' });
    return;
  }

  const { issue, stage, preview_url, reason, progress } = body;
  if (!issue || !stage) {
    res.status(400).json({ ok: false, error: 'missing issue or stage' });
    return;
  }

  const text = buildText({ issue, stage, preview_url, reason, progress });
  if (!text) {
    res.status(400).json({ ok: false, error: `unknown stage: ${stage}` });
    return;
  }

  const recipients = new Set();
  if (OWNER_ID) recipients.add(OWNER_ID);
  try {
    const assistantId = await getAssistantChatId(Number(issue));
    if (assistantId && String(assistantId) !== OWNER_ID) {
      recipients.add(String(assistantId));
    }
  } catch (e) {
    console.warn('[notify] getAssistantChatId failed:', e.message);
  }

  const results = await Promise.allSettled(
    [...recipients].map(chatId =>
      sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: stage !== 'done' })
    )
  );
  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - sent;
  if (failed) {
    for (const r of results) {
      if (r.status === 'rejected') console.warn('[notify] send failed:', r.reason?.message || r.reason);
    }
  }

  res.status(200).json({ ok: true, sent, failed, recipients: [...recipients] });
}

function buildText({ issue, stage, preview_url, reason, progress }) {
  const esc = escapeHtml;
  switch (stage) {
    case 'in_progress':
      return `🔧 <b>#${issue}</b> — замечания взяты в работу.`;
    case 'heartbeat':
      return `⏳ <b>#${issue}</b> в работе${progress ? `: ${esc(progress)}` : ''}.`;
    case 'blocked':
      return (
        `🚫 <b>#${issue}</b> застрял.\n\n` +
        `Причина: ${esc(reason || 'без объяснения')}\n\n` +
        `Нужна помощь — открой Claude Code и продолжи вручную.`
      );
    case 'done':
      return (
        `✅ <b>#${issue}</b> готов!` +
        (preview_url ? `\n\nPreview: ${esc(preview_url)}` : '')
      );
    case 'needs_fix':
      return (
        `⚠️ <b>#${issue}</b> — tester нашёл проблемы.\n\n` +
        esc(reason || 'См. отчёт в _data/{slug}/test/')
      );
    default:
      return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
