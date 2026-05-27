// POST /api/intent/draft
//
// Claude Code intent-router agent → bot. Передаёт классифицированный draft
// либо clarifying question для ассистента. См. INTENT_ROUTER_PLAN.md.
//
// Auth: X-Notify-Secret (тот же CLAUDE_NOTIFY_SECRET).
//
// Body — два shape'a:
//
// 1. Normal draft (Pavel approves):
//   {
//     intent_issue: <number>,   // GH intent-pending issue
//     uuid: "<12-hex>",
//     draft: {
//       intent: "scout-request|bug|prompt|edit-section|photo-upload",
//       confidence: 0.0-1.0,
//       target_label: "...",
//       slug?: "...", target_section?: "...",
//       summary: "Одна строка для Pavel'a",
//       proposed_action: "Что бот сделает после approve",
//       raw_payload: { ... },
//       missing_fields?: ["..."]
//     }
//   }
//   Действие: setIntentDraft(uuid) → flip label intent-pending → intent-drafted
//            → TG inline keyboard к Pavel [✅ OK] [✏️ Правка] [❌ Reject]
//
// 2. Clarification (low confidence или ambiguous):
//   {
//     intent_issue: <number>,
//     uuid: "<12-hex>",
//     draft: { needs_clarification: true, question: "...", context_hint?: "..." }
//   }
//   Действие: НЕ flip label (остаётся intent-pending — CC retry после ответа)
//            → TG message ассистенту напрямую (минуя Pavel)
//            → setActiveSection(assistantChat, '__intent_clarify__:{uuid}')

import {
  getIntent,
  setIntentDraft,
  mapIntentIssueToUuid,
  setActiveSection,
} from '../../scripts/bot/lib/state.mjs';
import { setLabel } from '../../scripts/bot/lib/github-api.mjs';
import { tgApi } from '../../scripts/bot/lib/tg-api.mjs';
import { LABELS, assertEnv, getEnv } from '../../scripts/bot/config.mjs';

assertEnv(['TG_BOT_TOKEN', 'TG_OWNER_CHAT_ID', 'CLAUDE_NOTIFY_SECRET', 'GH_TOKEN']);
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

  const { intent_issue, uuid, draft } = body;
  if (!intent_issue || !uuid || !draft || typeof draft !== 'object') {
    res.status(400).json({ ok: false, error: 'intent_issue + uuid + draft required' });
    return;
  }

  // Persist reverse mapping (callback handlers получают issue number из button).
  await mapIntentIssueToUuid(intent_issue, uuid);

  // Clarification path: bypass Pavel, ask assistant directly.
  if (draft.needs_clarification === true) {
    return await handleClarification({ res, intent_issue, uuid, draft });
  }

  // Normal draft path: store + flip label + show inline keyboard к Pavel.
  return await handleNormalDraft({ res, intent_issue, uuid, draft });
}

async function handleNormalDraft({ res, intent_issue, uuid, draft }) {
  // Validate basic shape.
  const required = ['intent', 'target_label', 'summary', 'proposed_action'];
  for (const k of required) {
    if (!draft[k]) {
      res.status(400).json({ ok: false, error: `draft.${k} required for normal draft` });
      return;
    }
  }

  await setIntentDraft(uuid, draft);

  // Flip label (best-effort — не валим endpoint если GH down).
  try {
    await setLabel(intent_issue, LABELS.INTENT_DRAFTED, LABELS.INTENT_PENDING);
  } catch (e) {
    console.warn('[intent/draft] label flip failed:', e.message);
  }

  // Build inline keyboard для Pavel.
  const inline_keyboard = [
    [{ text: '✅ OK', callback_data: `intent_approve:${uuid}` }],
    [{ text: '✏️ Правка', callback_data: `intent_edit:${uuid}` }],
    [{ text: '❌ Reject', callback_data: `intent_reject:${uuid}` }],
  ];

  const confPct = Math.round((Number(draft.confidence) || 0) * 100);
  const lines = [
    `📥 <b>Новая заявка от ассистента</b> (#${intent_issue})`,
    '',
    `<b>Тип:</b> ${esc(draft.intent)} (${confPct}% уверенности)`,
  ];
  if (draft.slug) lines.push(`<b>Сайт:</b> ${esc(draft.slug)}`);
  if (draft.target_section) lines.push(`<b>Секция:</b> ${esc(draft.target_section)}`);
  lines.push('', esc(draft.summary), '', `<i>${esc(draft.proposed_action)}</i>`);

  // Voice-aware send: если у intent был голосовое сообщение → forward оригинал
  // c caption (Pavel слышит ассистента + видит draft + кнопки). Caption max
  // 1024 chars (TG limit), мы укладываемся (~250 char).
  const voiceFileId = draft?.raw_payload?.voice_file_id;
  const caption = lines.join('\n');

  try {
    if (voiceFileId) {
      await tgApi('sendVoice', {
        chat_id: OWNER_ID,
        voice: voiceFileId,
        caption: caption.length > 1024 ? caption.slice(0, 1020) + '…' : caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard },
      });
    } else {
      await tgApi('sendMessage', {
        chat_id: OWNER_ID,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard },
      });
    }
  } catch (e) {
    console.warn('[intent/draft] TG send to owner failed:', e.message);
    // Не валим — draft persisted, Pavel может посмотреть в issue
  }

  res.status(200).json({ ok: true, mode: 'draft', sent_to: OWNER_ID, voice_forwarded: !!voiceFileId });
}

async function handleClarification({ res, intent_issue, uuid, draft }) {
  if (!draft.question) {
    res.status(400).json({ ok: false, error: 'draft.question required for clarification' });
    return;
  }

  // Try Redis first; fallback к GH issue body if expired (TTL 30min vs slow CC).
  let targetChat = null;
  const intent = await getIntent(uuid);
  if (intent?.chat_id) {
    targetChat = intent.chat_id;
  } else {
    // Parse from_chat from issue body (set by materializeIntent при create).
    try {
      const { getIssue } = await import('../../scripts/bot/lib/github-api.mjs');
      const issue = await getIssue(intent_issue);
      const m = (issue?.body || '').match(/^from_chat:\s*(\d+)/m);
      if (m && m[1] !== '0') targetChat = m[1];
    } catch (e) {
      console.warn('[intent/draft clarify] body fallback failed:', e.message);
    }
  }
  if (!targetChat) {
    res.status(404).json({ ok: false, error: 'cannot resolve target chat (Redis expired + issue body missing from_chat)' });
    return;
  }

  // Persist clarify mode (next text from this chat appends to same intent).
  await setActiveSection(targetChat, `__intent_clarify__:${uuid}`);

  const lines = [
    `❓ <b>Уточнение по твоей заявке</b> (#${intent_issue})`,
    '',
    esc(draft.question),
  ];

  try {
    await tgApi('sendMessage', {
      chat_id: targetChat,
      text: lines.join('\n'),
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.warn('[intent/draft] TG send to assistant failed:', e.message);
  }

  res.status(200).json({ ok: true, mode: 'clarification', sent_to: targetChat });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
