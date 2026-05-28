// Intent router — assistant free-form UX layer (INTENT_ROUTER_PLAN.md).
// Owns:
//   - intake decision: free-form text/media from assistant → startOrAppendIntent or skip
//   - clarify mode: '__intent_clarify__:{uuid}' active section → append + re-fire CC
//   - cron poll: idle intents → create GH issue with intent-pending label
//   - realizeIntent: approved draft → real pipeline issue (scout-request/bug/prompt/edit-section/photo-upload)
//
// commands.mjs только импортирует thin shims (intakeAssistantText/Photo/Video,
// runIntentApprove/Edit/Reject) — business logic вся здесь.

import {
  startOrAppendIntent,
  appendIntentText,
  appendIntentMedia,
  getIntent,
  clearIntent,
  getOpenIntentForChat,
  listIdleIntents,
  getIntentDraft,
  clearIntentDraft,
  mapIntentIssueToUuid,
  getActiveSection,
  setActiveSection,
  getCurrentTask,
} from './state.mjs';
import { setLabel, createIssue, closeIssue, commentOnIssue } from './github-api.mjs';
import { sendMessage } from './tg-api.mjs';
import { LABELS, getEnv } from '../config.mjs';

const FEATURE_FLAG = 'INTENT_ROUTER_ENABLED';

// Returns true if intent router is enabled (default: false до прод rollout).
export function isIntentRouterEnabled() {
  return getEnv(FEATURE_FLAG) === 'true';
}

// ---- Intake (called from handleText/Photo/Video as last-resort branch) ----
//
// Returns { handled: bool, replyText?: string }.
//   handled=true → caller should return immediately после optional reply
//   handled=false → caller продолжает existing flow (e.g. «Открой задачу /list»)
//
// Caller MUST have already checked:
//   - bug/prompt session (those take priority)
//   - feedback pending
//   - cmdPending
//   - getCurrentTask (Q2 locked: current task wins)
//
// Logs structured `[intent uuid=… chat=… stage=…]` for observability (E3).

export async function intakeAssistantInput(ctx, { text = '', media = null } = {}) {
  if (!isIntentRouterEnabled()) return { handled: false };
  if (ctx.role !== 'assistant') return { handled: false };
  const chatId = ctx.from.id;

  // Clarify mode — assistant отвечает на CC's clarifying question.
  const section = await getActiveSection(chatId).catch(() => null);
  if (section && section.startsWith('__intent_clarify__:')) {
    return await handleClarifyReply(ctx, { section, text, media });
  }

  // Skip routing if assistant в active task (current task wins per Q2).
  const task = await getCurrentTask(chatId).catch(() => null);
  if (task) return { handled: false };

  // Slash commands — fall through to existing dispatcher.
  if (text.startsWith('/')) return { handled: false };

  // Normal intake — append to open intent OR start new.
  const wasOpen = await getOpenIntentForChat(chatId);
  const uuid = await startOrAppendIntent(chatId, { text, media });
  console.log(`[intent uuid=${uuid} chat=${chatId} stage=intake mode=${wasOpen ? 'append' : 'new'}]`);

  const intent = await getIntent(uuid);
  const mediaCount = intent?.media?.length || 0;
  const textLen = intent?.text?.length || 0;
  const reply = wasOpen
    ? `📥 Добавил к черновику (${mediaCount} медиа, ${textLen} символов). Пиши ещё или просто жди — через ~1 минуту отправлю Pavel'у.`
    : `📥 Принял (${mediaCount} медиа, ${textLen} символов). Пиши ещё или жди — через ~1 минуту отправлю Pavel'у на одобрение.`;
  return { handled: true, replyText: reply };
}

async function handleClarifyReply(ctx, { section, text, media }) {
  const uuid = section.slice('__intent_clarify__:'.length);
  const chatId = ctx.from.id;
  console.log(`[intent uuid=${uuid} chat=${chatId} stage=clarify-reply]`);

  // Append answer to existing intent payload.
  if (text) await appendIntentText(uuid, text);
  if (media) await appendIntentMedia(uuid, media);

  // Clear sentinel так чтобы следующее сообщение не залипало в clarify mode.
  await setActiveSection(chatId, '');

  // Find intent issue + comment + flip label intent-drafted → intent-pending
  // (force CC re-router pickup).
  const issue = await findIntentIssueByUuid(uuid);
  if (issue) {
    try {
      await commentOnIssue(issue.number, `Assistant clarification:\n\n${text || '(media only)'}`);
      await setLabel(issue.number, LABELS.INTENT_PENDING, LABELS.INTENT_DRAFTED);
    } catch (e) {
      console.warn(`[intent uuid=${uuid}] re-fire failed:`, e.message);
    }
  }

  return { handled: true, replyText: '📥 Принял ответ — переотправляю Pavel\'у.' };
}

// ---- Cron poll (called from /api/intent/poll.mjs every minute) -----------
//
// Two jobs per tick:
//   1. Materialize intents idle ≥30s into GH issues с intent-pending label.
//   2. Auto-expire intent-drafted issues older than 24h (Q6 locked).

export async function runCronPoll({ idleSeconds = 30 } = {}) {
  const materialized = [];
  const expired = [];

  const idle = await listIdleIntents({ idleSeconds });
  for (const intent of idle) {
    try {
      materialized.push(await materializeIntent(intent));
    } catch (e) {
      console.error(`[intent uuid=${intent.uuid}] materialize failed:`, e.message);
      materialized.push({ uuid: intent.uuid, ok: false, error: e.message });
    }
  }

  try {
    const exp = await expireStaleDrafts();
    expired.push(...exp);
  } catch (e) {
    console.error('[intent] expireStaleDrafts failed:', e.message);
  }

  // Return both for /api/intent/poll JSON response (backward-compatible —
  // callers reading .filter(r => r.ok) still see materialize results first).
  return [...materialized, ...expired.map(e => ({ ...e, kind: 'expired' }))];
}

// Find intent-drafted issues with age >= 24h, comment + close + notify assistant.
async function expireStaleDrafts() {
  const { listIssuesByLabel } = await import('./github-api.mjs');
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const drafted = await listIssuesByLabel(LABELS.INTENT_DRAFTED).catch(() => []);
  const results = [];
  for (const issue of drafted) {
    const createdMs = Date.parse(issue.created_at || 0);
    if (!createdMs || createdMs > cutoffMs) continue;

    try {
      await commentOnIssue(issue.number, '⌛ Intent expired (24h без owner action). Если ещё актуально — попроси ассистента переотправить.');
    } catch (e) { console.warn(`[intent #${issue.number}] expire-comment failed:`, e.message); }

    try {
      await setLabel(issue.number, LABELS.INTENT_EXPIRED, LABELS.INTENT_DRAFTED);
    } catch (e) { console.warn(`[intent #${issue.number}] expire-label failed:`, e.message); }

    try {
      await closeIssue(issue.number, { stateReason: 'not_planned' });
    } catch (e) { console.warn(`[intent #${issue.number}] expire-close failed:`, e.message); }

    // Notify assistant if chat_id извлекается из body.
    const m = (issue.body || '').match(/^from_chat:\s*(\d+)/m);
    if (m) {
      try {
        await sendMessage(m[1], `⌛ Твоя заявка #${issue.number} просрочена (24h без ответа Pavel'a). Если ещё нужно — отправь заново.`);
      } catch (e) { console.warn(`[intent #${issue.number}] expire-notify failed:`, e.message); }
    }

    const uuidMatch = (issue.body || '').match(/^uuid:\s*([a-f0-9]+)/m);
    if (uuidMatch) await clearIntentDraft(uuidMatch[1]);

    console.log(`[intent #${issue.number} stage=expired]`);
    results.push({ issue: issue.number, ok: true });
  }
  return results;
}

async function materializeIntent(intent) {
  const { uuid, chat_id, text, media, started_at } = intent;
  const preview = (text || '').slice(0, 40).replace(/\n/g, ' ') || '(media-only)';
  const mediaLines = (media || []).map(m => {
    const url = `${getBotPublicBase()}/api/bug/media?file_id=${encodeURIComponent(m.file_id)}`;
    return `- ${m.type}: ${url}${m.caption ? ` (caption: ${m.caption})` : ''}`;
  });

  const body = [
    '<!-- intent-router-v1 -->',
    `uuid: ${uuid}`,
    `from_chat: ${chat_id}`,
    `started_at: ${started_at}`,
    `media_count: ${media?.length || 0}`,
    '<!-- /intent-router-v1 -->',
    '',
    '## Raw text',
    '',
    text || '_(media-only)_',
    '',
  ];
  if (mediaLines.length) {
    body.push('## Media');
    body.push('');
    body.push(...mediaLines);
    body.push('');
  }
  body.push('---');
  body.push('');
  body.push('CC intent-router agent will classify this and POST a draft.');
  body.push('Owner approves via TG inline keyboard (label flips to `intent-drafted`).');

  const issue = await createIssue({
    title: `[intent] ${preview}`,
    body: body.join('\n'),
    labels: [LABELS.INTENT_PENDING],
  });

  await mapIntentIssueToUuid(issue.number, uuid);

  // Persist issue_number back into intent payload so clarify-reply lookup works.
  // (Cheap: small JSON re-write via existing setter.)
  const refreshed = await getIntent(uuid);
  if (refreshed) {
    refreshed.issue_number = issue.number;
    const { redis } = await import('./state.mjs');
    await redis.set(`assistant-intent:${uuid}`, JSON.stringify(refreshed), { ex: 30 * 60 });
  }

  // Notify assistant: «принял (#N), жду Pavel'a».
  try {
    await sendMessage(
      chat_id,
      `📥 Заявка принята: #${issue.number}\n\n` +
      `Сейчас Pavel получит уведомление с draft'ом — после approve я создам реальную задачу.`,
    );
  } catch (e) {
    console.warn(`[intent uuid=${uuid}] notify assistant failed:`, e.message);
  }

  // Clear Redis intent + debounce; draft endpoint will create new state.
  await clearIntent(uuid);

  console.log(`[intent uuid=${uuid} chat=${chat_id} stage=materialized issue=${issue.number}]`);
  return { uuid, ok: true, issue: issue.number };
}

function getBotPublicBase() {
  // Used to build media URLs in intent issue body. VERCEL_URL set automatically.
  const explicit = getEnv('BOT_PUBLIC_BASE');
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = getEnv('VERCEL_URL');
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return 'https://business-sites-bot.vercel.app';
}

// ---- Realize approved draft (called from callback intent_approve) --------
//
// Returns { ok, realized_issue?, error? }.

export async function realizeIntent(uuid) {
  const draft = await getIntentDraft(uuid);
  if (!draft) return { ok: false, error: 'draft not found (expired?)' };

  const intentIssue = await findIntentIssueByUuid(uuid);
  if (!intentIssue) return { ok: false, error: 'intent issue not resolved' };

  const realized = await createRealizedIssue(draft, intentIssue);

  // Set assistant_chat_id для realized issue → bot-notify automatically targets
  // initiator first (per locked feedback_progress_to_initiator 2026-05-27 #80).
  // From_chat parsed from intent issue body metadata.
  const fromChatMatch = (intentIssue.body || '').match(/^from_chat:\s*(\d+)/m);
  if (fromChatMatch && fromChatMatch[1] !== '0') {
    try {
      const { setAssistantChatId } = await import('./state.mjs');
      await setAssistantChatId(realized.number, fromChatMatch[1]);
    } catch (e) {
      console.warn(`[intent uuid=${uuid}] setAssistantChatId failed:`, e.message);
    }
  }

  await closeIntentIssueAfterRealize(intentIssue, realized.number);
  await clearIntentDraft(uuid);

  console.log(`[intent uuid=${uuid} stage=realized realized_issue=${realized.number} initiator=${fromChatMatch?.[1] || 'none'}]`);
  return { ok: true, realized_issue: realized.number, title: realized.title };
}

async function findIntentIssueByUuid(uuid) {
  // Re-use stored mapping. If missing, scan label.
  const { listIssuesByLabel } = await import('./github-api.mjs');
  const issues = await listIssuesByLabel(LABELS.INTENT_DRAFTED).catch(() => []);
  for (const i of issues) {
    if ((i.body || '').includes(`uuid: ${uuid}`)) return i;
  }
  // Fallback also check intent-pending (might race with re-fire).
  const pending = await listIssuesByLabel(LABELS.INTENT_PENDING).catch(() => []);
  for (const i of pending) {
    if ((i.body || '').includes(`uuid: ${uuid}`)) return i;
  }
  return null;
}

async function createRealizedIssue(draft, intentIssue) {
  const { intent, slug, target_section, summary, raw_payload, target_label } = draft;
  const mediaBlock = formatMediaForPayload(raw_payload?.media_file_ids || raw_payload?.media || []);

  let title;
  let body;

  switch (intent) {
    case 'scout-request': {
      title = `[scout-request] ${raw_payload?.venue_hint || summary}`;
      body = [
        `**Source:** intent router from #${intentIssue.number}`,
        `**Venue hint:** ${raw_payload?.venue_hint || '(see summary)'}`,
        raw_payload?.source ? `**Source detail:** ${raw_payload.source}` : null,
        raw_payload?.city ? `**City:** ${raw_payload.city}` : null,
        '',
        '## Summary',
        '',
        summary,
        '',
        '---',
        `_Realized from intent #${intentIssue.number} (approved by owner via TG)._`,
      ].filter(Boolean).join('\n');
      break;
    }
    case 'bug': {
      title = `[bug] ${truncate(summary, 60)}`;
      body = [
        slug ? `**Slug:** ${slug}` : null,
        '',
        '## Description',
        '',
        raw_payload?.description || summary,
        mediaBlock,
        '',
        '---',
        `_Realized from intent #${intentIssue.number} (approved by owner via TG)._`,
      ].filter(Boolean).join('\n');
      break;
    }
    case 'prompt': {
      title = `[prompt] ${truncate(summary, 60)}`;
      body = [
        slug ? `**Slug:** ${slug}` : null,
        '',
        '## Prompt',
        '',
        raw_payload?.description || summary,
        mediaBlock,
        '',
        '---',
        `_Realized from intent #${intentIssue.number} (approved by owner via TG)._`,
      ].filter(Boolean).join('\n');
      break;
    }
    case 'edit-section':
    case 'photo-upload': {
      title = `[${intent}] ${slug} → ${target_section} · ${truncate(summary, 40)}`;
      // Per-section sources block — IG/direct URLs assistant mapped к секциям.
      // Без этого CC теряет URLs (bug 2026-05-28 #93). Сохраняем raw_payload.sections.
      let sectionsBlock = '';
      if (raw_payload?.sections && typeof raw_payload.sections === 'object') {
        const lines = ['', '## Section sources', ''];
        for (const [sec, urls] of Object.entries(raw_payload.sections)) {
          const list = Array.isArray(urls) ? urls : [urls];
          lines.push(`**${sec}:**`);
          for (const u of list) lines.push(`- ${u}`);
        }
        sectionsBlock = lines.join('\n');
      }
      body = [
        `**Slug:** ${slug}`,
        `**Section:** ${target_section}`,
        raw_payload?.source_type ? `**Source type:** ${raw_payload.source_type}` : null,
        '',
        '## Instructions',
        '',
        raw_payload?.instructions || summary || '_(see media/sources)_',
        sectionsBlock,
        mediaBlock,
        '',
        '## Note for CC',
        '',
        `Update \`_data/${slug}/visual_review_input.json\` to append into the listed sections — append, NOT replace (per Q3 locked). Download media via \`scripts/visual-review/download-refs.mjs\` (IG/direct URLs above OR file_ids).`,
        '',
        '---',
        `_Realized from intent #${intentIssue.number} (approved by owner via TG)._`,
      ].filter(Boolean).join('\n');
      break;
    }
    default:
      throw new Error(`unknown intent type: ${intent}`);
  }

  return await createIssue({
    title,
    body,
    labels: [target_label],
  });
}

function formatMediaForPayload(items) {
  if (!items || !items.length) return '';
  const base = getBotPublicBase();
  const lines = ['', '## Media', ''];
  for (const m of items) {
    const fileId = typeof m === 'string' ? m : m.file_id;
    const type = typeof m === 'string' ? 'unknown' : (m.type || 'unknown');
    lines.push(`- ${type}: ${base}/api/bug/media?file_id=${encodeURIComponent(fileId)}`);
  }
  return lines.join('\n');
}

async function closeIntentIssueAfterRealize(intentIssue, realizedNumber) {
  try {
    await commentOnIssue(intentIssue.number, `✅ Realized → #${realizedNumber} (approved by owner)`);
  } catch (e) {
    console.warn('[intent] comment failed:', e.message);
  }
  try {
    await closeIssue(intentIssue.number, { stateReason: 'completed' });
  } catch (e) {
    console.warn('[intent] close failed:', e.message);
  }
}

// ---- Edit & reject flows (called from callbacks) -------------------------

export async function startIntentEdit(uuid) {
  const draft = await getIntentDraft(uuid);
  if (!draft) return { ok: false, error: 'draft not found' };
  const intent = await findIntentIssueByUuid(uuid);
  if (!intent) return { ok: false, error: 'intent issue not resolved' };

  // Owner sentinel — next text from owner appended via clarify path.
  // We use same '__intent_clarify__' sentinel so handleText reuses re-fire logic.
  const ownerId = getEnv('TG_OWNER_CHAT_ID');
  if (ownerId) await setActiveSection(ownerId, `__intent_clarify__:${uuid}`);

  const questions = (draft.missing_fields || []).slice(0, 2);
  const text = questions.length
    ? `Какие правки в draft #${intent.number}?\n\nПодсказка по недостающим полям:\n${questions.map(q => `• ${q}`).join('\n')}\n\nПросто напиши уточнение — отправлю CC на пере-классификацию.`
    : `Какие правки в draft #${intent.number}? Напиши уточнение, отправлю CC на пере-классификацию.`;

  return { ok: true, question: text };
}

export async function rejectIntent(uuid, reason = '') {
  const intent = await findIntentIssueByUuid(uuid);
  if (!intent) return { ok: false, error: 'intent issue not resolved' };

  try {
    await commentOnIssue(intent.number, `❌ Rejected by owner${reason ? `: ${reason}` : ''}`);
  } catch (e) { console.warn('[intent] reject comment failed:', e.message); }
  try {
    await setLabel(intent.number, LABELS.WONT_DO, LABELS.INTENT_DRAFTED);
  } catch (e) { console.warn('[intent] reject label failed:', e.message); }
  try {
    await closeIssue(intent.number, { stateReason: 'not_planned' });
  } catch (e) { console.warn('[intent] reject close failed:', e.message); }

  await clearIntentDraft(uuid);

  // Notify assistant if we can reconstruct chat_id from intent body.
  const m = (intent.body || '').match(/^from_chat:\s*(\d+)/m);
  if (m) {
    try {
      await sendMessage(
        m[1],
        `❌ Pavel отклонил твою заявку #${intent.number}${reason ? `.\n\nПричина: ${reason}` : '.'}`,
      );
    } catch (e) { console.warn('[intent] reject notify failed:', e.message); }
  }

  return { ok: true };
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
