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
import * as Attn from '../../scripts/bot/lib/attention.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'TG_OWNER_CHAT_ID', 'CLAUDE_NOTIFY_SECRET']);
const OWNER_ID = String(getEnv('TG_OWNER_CHAT_ID')).trim();
const SECRET = getEnv('CLAUDE_NOTIFY_SECRET').trim();

export default async function handler(req, res) {
  const url = req.url || '';
  const provided = req.headers['x-notify-secret'];
  const authed = provided && provided === SECRET;
  const isCron = !!req.headers['x-vercel-cron'];

  // === Ф5.5 Owner Attention Queue ===
  // Дайджест (cron утро/вечер ИЛИ ручной триггер CC): разбудить отложенные → скан аномалий → сводка owner'у.
  if (url.includes('attn=digest')) {
    if (!authed && !isCron) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    try {
      await Attn.wakeSnoozed();
      const scan = await Attn.scanAnomalies();
      const items = await Attn.listOpen(50);
      const c = await Attn.counts();
      const hourMinsk = (new Date().getUTCHours() + 3) % 24;
      const period = hourMinsk < 14 ? 'утро' : 'вечер';
      await sendMessage(OWNER_ID, Attn.digestText(items, c, period), { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: Attn.digestKeyboard() });
      res.status(200).json({ ok: true, scanned: scan.created, open: items.length }); return;
    } catch (e) { console.error('[attn digest]', e); res.status(500).json({ ok: false, error: e.message }); return; }
  }
  // Добавить элемент (CC): urgent → сразу owner'у с кнопками; обычное → копится в очередь.
  if (url.includes('attn=add')) {
    if (req.method !== 'POST' || !authed) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    try {
      const item = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const r = await Attn.addItem(item);
      if (r.deduped) { res.status(200).json({ ok: true, deduped: true }); return; }
      // Сразу пушим owner'у: срочное + всё, что требует ЕГО решения (рекомендации ассистентов,
      // эскалации, запросы доступа). Только инфо/аномалии копятся в сводку, чтоб не спамить (#152).
      const pushNow = r.rec && (r.rec.priority === 'urgent' || ['recommendation', 'escalation', 'access', 'prototype'].includes(r.rec.type));
      if (pushNow) {
        const head = r.rec.priority === 'urgent' ? '🔔 <b>Срочно</b>' : '📥 <b>На твоё решение</b>';
        await sendMessage(OWNER_ID, `${head}\n\n${Attn.itemText(r.rec)}`, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: Attn.itemKeyboard(r.rec) });
        if (r.rec.voice_file_id) { try { const { tgApi } = await import('../../scripts/bot/lib/tg-api.mjs'); await tgApi('sendVoice', { chat_id: OWNER_ID, voice: r.rec.voice_file_id, caption: '🎤 оригинал от ассистента' }); } catch (e) { console.warn('[attn voice]', e.message); } }
      }
      res.status(200).json({ ok: true, id: r.id }); return;
    } catch (e) { console.error('[attn add]', e); res.status(500).json({ ok: false, error: e.message }); return; }
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!authed) {
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
        (reason ? `\n\n${esc(reason)}` : '') +
        (preview_url ? `\n\n🔗 ${esc(preview_url)}` : '')
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
