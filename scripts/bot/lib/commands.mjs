// Command handlers for the visual-review TG bot.
// M1: /start, /help, /list are real. Other commands stub a friendly "M2 coming"
// reply so the bot doesn't appear broken before the rest of the milestones land.

import { getCurrentTask, setCurrentTask, setActiveSection, getActiveSection,
         skipSection, clearCurrentTask, getPhotos, getTextEdits, getSkipped,
         clearTaskState, getRound, incRound, getLastSubmitHash, setLastSubmitHash,
         getAssistantChatId, setAssistantChatId,
         getFeedbackPending, setFeedbackPending, clearFeedbackPending,
         removePhotoAt, unskipSection,
         addNote, getNotes, removeNoteAt, clearNotes,
         getRoleOverride, setRoleOverride, clearRoleOverride, getRoleOverrideTtl,
         isApprovedAssistant, addApprovedAssistant,
         getPendingAccess, clearPendingAccess,
         setCommandPending, getCommandPending, clearCommandPending,
         getTaskAssignee, setTaskAssignee, clearTaskAssignee,
         getTaskBlocker, setTaskBlocker, clearTaskBlocker,
         getActiveTask, setActiveTask, clearActiveTask,
         touchTask, setPitchInfo, getPitchInfo,
         getBugSession, startBugSession, appendBugText, appendBugMedia,
         clearBugSession,
         getClaudeQuestion, setClaudeAnswer, getClaudeAnswer } from './state.mjs';
import { buildTaskListKeyboard, buildSectionKeyboard,
         buildOwnerPushKeyboard, buildPreviewKeyboard } from './keyboard.mjs';
import { LABELS, GITHUB_REPO, getEnv } from '../config.mjs';
import { getSections, getSectionById } from './sections.mjs';
import { persistUrlInput, persistTgUpload } from './photo-handler.mjs';
import { splitUrlAndCaption, parseTextEdit } from './text-parser.mjs';
import { collectSubmitState, hashSubmitState, buildOwnerPush,
         buildGalleryBatches } from './review.mjs';
import { sendMessage, sendMediaGroup } from './tg-api.mjs';
import { renderHelp, renderTopicHelp } from './help.mjs';
import { renderPlaybook } from './playbook.mjs';
import { parseScoutInput, buildScoutIssue } from './scout-parser.mjs';
import { InlineKeyboard } from 'grammy';
// Note: `dispatchWorkflow` kept imported as a dormant fallback (Q18.1).
// If we revert from Claude Code executor to GH Actions, restore the call in
// runRebuild() step 3 — no other changes needed.
// eslint-disable-next-line no-unused-vars
import { listIssuesByLabel, putFile, dispatchWorkflow, commentOnIssue, setLabel,
         getIssue, closeIssue, createIssue } from './github-api.mjs';

const STUB_M2 = 'Эта команда появится в M2. Сейчас доступны: /start /help /list.';

// ---- M1 real handlers ----------------------------------------------------

export async function handleStart(ctx) {
  const tasks = await safeGetActiveTasks();
  const lines = [
    '👋 Бот визуального ревью готов.',
    '',
    `Активных задач: ${tasks.length}`,
  ];
  if (tasks.length > 0) {
    lines.push('', 'Список — /list, текущая — /current.');
  } else {
    lines.push('', 'Когда issue получит лейбл `needs-visual-review`, я пришлю уведомление.');
  }
  lines.push('', 'Все команды — /help.');
  await ctx.reply(lines.join('\n'));
}

export async function handleHelp(ctx) {
  // Q32: role-aware + categorical + optional topic detail.
  // HTML mode (Markdown v1 breaks on bare `_` in command names).
  const arg = ctx.match?.trim();
  if (arg) {
    const detail = renderTopicHelp(arg);
    if (detail) {
      await ctx.reply(detail, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`Не знаю команды <code>${escapeHtml(arg)}</code>. /help — общий список.`,
        { parse_mode: 'HTML' });
    }
    return;
  }
  await ctx.reply(renderHelp(ctx.role), { parse_mode: 'HTML' });
}

// M3c — Q29: debug command. Always responds even if env is broken.
export async function handleWhoami(ctx) {
  const id = ctx.from?.id;
  const username = ctx.from?.username ? `@${ctx.from.username}` : '(no username)';
  const role = ctx.role || 'unknown';
  const realRole = ctx.realRole;
  let overrideLine = '';
  if (realRole && realRole !== role) {
    const ttl = await getRoleOverrideTtl(String(id)).catch(() => null);
    const ttlNote = (ttl && ttl > 0) ? ` (ещё ${Math.ceil(ttl / 60)} мин)` : '';
    overrideLine = `\nReal role: ${realRole} <i>(override active${ttlNote} — /role reset)</i>`;
  }
  await ctx.reply(
    `Ты: ${escapeHtml(username)}\nchat_id: <code>${id}</code>\nРоль: ${role}${overrideLine}`,
    { parse_mode: 'HTML' }
  );
}

// Owner-only debug: temporarily downgrade effective role so the same chat
// can test assistant/unknown flows without juggling TG accounts. TTL'd in
// Redis (30 min) so a forgotten override silently expires.
//
// Usage:
//   /role              — show current state
//   /role assistant    — act as assistant
//   /role unknown      — act as unknown (triggers onboarding flow)
//   /role owner | reset — clear override
export async function handleRole(ctx) {
  // Only the real owner may toggle this. ctx.realRole is set by middleware;
  // ctx.role may already be overridden so we can't trust it for auth.
  if (ctx.realRole !== 'owner') {
    await ctx.reply('Эта команда только для owner.');
    return;
  }
  const arg = (ctx.match || '').trim().toLowerCase();
  const fromId = String(ctx.from?.id ?? '');

  if (!arg) {
    const current = await getRoleOverride(fromId);
    const ttl = current ? await getRoleOverrideTtl(fromId).catch(() => null) : null;
    if (!current) {
      await ctx.reply(
        'Override не установлен — ты owner.\n\n' +
        'Доступные команды:\n' +
        '<code>/role assistant</code> — тестировать как assistant\n' +
        '<code>/role unknown</code> — тестировать onboarding-flow\n' +
        '<code>/role reset</code> — снять override досрочно',
        { parse_mode: 'HTML' }
      );
    } else {
      const ttlNote = (ttl && ttl > 0) ? ` (истечёт через ${Math.ceil(ttl / 60)} мин)` : '';
      await ctx.reply(
        `Override: <code>${current}</code>${ttlNote}\n\n` +
        '<code>/role reset</code> — снять досрочно',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  if (arg === 'reset' || arg === 'owner') {
    await clearRoleOverride(fromId);
    await ctx.reply('✅ Override снят. Ты снова owner.');
    return;
  }

  if (arg !== 'assistant' && arg !== 'unknown') {
    await ctx.reply(
      'Неизвестный аргумент. Доступно: <code>assistant</code>, <code>unknown</code>, <code>reset</code>.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await setRoleOverride(fromId, arg);
  const desc = arg === 'assistant'
    ? 'теперь ведёшь себя как ассистент. /help и /playbook покажут assistant-команды. Owner-only хендлеры должны отказать.'
    : 'теперь ведёшь себя как unknown. Любое сообщение → onboarding-ответ. Сними /role reset когда закончишь.';
  await ctx.reply(
    `✅ Override: <code>${arg}</code> (30 мин)\n\n${desc}`,
    { parse_mode: 'HTML' }
  );
}

// M3c — Q33: role-aware playbook.
export async function handlePlaybook(ctx) {
  await ctx.reply(renderPlaybook(ctx.role), { parse_mode: 'HTML' });
}

// Minimal HTML escape for user-controlled strings interpolated into HTML-mode
// messages. Only needed for `<`/`>`/`&`/`"` — TG HTML parser is otherwise
// lenient (unlike MarkdownV2 which requires escaping a dozen chars).
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- /bug — report a bot/system issue with media -----------------------
//
// Flow:
//   /bug [text]       — open session (text optional, can be added later)
//   <any photo/video> — appended к session media (up to 10 per TG limit)
//   <any text>        — appended к session description
//   /done             — submit: create GH issue with label `bug-pending`
//                       (assistant) or `bug` (owner direct). Push owner if assistant.
//   /cancel           — drop session
//
// Owner /bug_review → list pending → tap card → detail view with media gallery
//                     → [✅ Confirm] (→ label `bug`) | [❌ Reject] (→ wont-fix + close + push)

export async function handleBug(ctx) {
  if (ctx.role === 'unknown') return; // middleware already handled
  const chatId = String(ctx.from?.id);
  const arg = (ctx.match || '').trim();

  const existing = await getBugSession(chatId);
  if (existing) {
    // Re-issuing /bug resets the session — pre-existing draft state is dropped.
    // Owner UX safeguard: tell user.
    await ctx.reply(
      `⚠️ У тебя уже есть начатый bug-репорт. Сброшу старую сессию (медиа: ${existing.media?.length || 0}).\n\n` +
      `Опиши новую проблему. Прикрепи фото/видео если есть. /done — отправить, /cancel — отменить.`
    );
  }
  await startBugSession(chatId, arg);
  await ctx.reply(
    arg
      ? `🐛 Bug-репорт начат с текстом: "${truncatePreview(arg, 80)}".\n\n` +
        `Прикрепи фото/видео (опционально, до 10 шт) — **caption у медиа тоже идёт в описание**. Шли ещё текст чтобы дополнить.\n\n` +
        `/done — отправить. /cancel — отменить.`
      : `🐛 Опиши проблему — текстом, фото/видео, или фото+подписью (caption тоже сохраняется).\n\nПриму всё что пришлёшь (до 10 медиа).\n\nКогда готов — /done. Отменить — /cancel.`
  );
}

export async function handleDone(ctx) {
  const chatId = String(ctx.from?.id);
  const session = await getBugSession(chatId);
  if (!session) {
    await ctx.reply('Нет начатого bug-репорта. /bug чтобы начать.');
    return;
  }
  if (!session.description && (!session.media || session.media.length === 0)) {
    await ctx.reply('Сессия пустая — нечего отправлять. Опиши проблему или приложи медиа, потом /done.');
    return;
  }
  const reporter = ctx.from?.username ? `@${ctx.from.username}` : `id:${ctx.from?.id}`;
  const isOwner = ctx.role === 'owner';
  const label = isOwner ? LABELS.BUG : LABELS.BUG_PENDING;
  const title = `[bug] ${truncatePreview(session.description || '(no description, media-only)', 60)}`;

  const mediaLines = (session.media || []).map((m, i) =>
    `- ${i + 1}. ${m.type === 'video' ? '🎥 video' : '📷 photo'} · file_id: \`${m.file_id}\`` +
    (m.caption ? ` · caption: "${truncatePreview(m.caption, 60)}"` : '')
  );

  const body = [
    `Reported by ${reporter} (${ctx.role}) via TG bot.`,
    '',
    '## Description',
    session.description || '(no text — media-only report)',
    '',
    mediaLines.length ? `## Media (${mediaLines.length})` : '',
    ...mediaLines,
    '',
    `<!-- bot-bug-v1 -->`,
    `reporter_chat_id: ${chatId}`,
    `started_at: ${session.started_at}`,
    `submitted_at: ${new Date().toISOString()}`,
    `<!-- /bot-bug-v1 -->`,
  ].filter(Boolean).join('\n');

  let created;
  try {
    created = await createIssue({ title, body, labels: [label] });
  } catch (e) {
    await ctx.reply(`❌ Не смог создать bug issue: ${e.message}`);
    return;
  }
  // Bind reporter to issue for future DM (reject/confirm push back).
  try { await setAssistantChatId(created.number, chatId); }
  catch (e) { console.warn('[bug] setAssistantChatId failed:', e.message); }

  await clearBugSession(chatId);

  if (isOwner) {
    await ctx.reply(
      `✅ Bug #${created.number} сохранён сразу как \`bug\` (owner direct).\n${created.html_url}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Assistant flow — push owner for review.
  await ctx.reply(
    `✅ Bug #${created.number} отправлен owner'у на review.\n${created.html_url}\n\n` +
    `Получишь push когда решит — confirm or reject.`
  );
  const ownerId = getEnv('TG_OWNER_CHAT_ID');
  if (ownerId && String(ownerId) !== chatId) {
    try {
      await sendMessage(ownerId,
        `🐛 Новый bug-репорт #${created.number} от ${reporter}.\n\n` +
        `${truncatePreview(session.description || '(no text — media-only)', 200)}\n\n` +
        `Media: ${session.media?.length || 0} шт.\n\n` +
        `/bug_review чтобы посмотреть + approve/reject.`
      );
    } catch (e) {
      console.warn('[bug] owner push failed:', e.message);
    }
  }
}

export async function handleBugReview(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может review bugs.');
    return;
  }
  const pending = await safeGetActiveTasks(LABELS.BUG_PENDING);
  const active = await safeGetActiveTasks(LABELS.BUG);
  if (pending.length === 0 && active.length === 0) {
    await ctx.reply('Нет bug-репортов. Когда ассистент пришлёт /bug — увидишь здесь.');
    return;
  }
  const kb = new InlineKeyboard();
  for (const t of pending) {
    kb.text(`🐛 pending · #${t.issue_number} · ${truncatePreview(t.venue_name || t.title || '', 50)}`,
      `bug_view:${t.issue_number}`).row();
  }
  for (const t of active) {
    kb.text(`🔧 active · #${t.issue_number} · ${truncatePreview(t.venue_name || t.title || '', 50)}`,
      `bug_view:${t.issue_number}`).row();
  }
  const summary = [
    `🐛 Bug-репортов: ${pending.length + active.length}`,
    `   pending review: ${pending.length}`,
    `   confirmed active: ${active.length}`,
    '',
    'Tap карточку — увидишь описание, медиа, кнопки confirm/reject.',
  ].join('\n');
  await ctx.reply(summary, { reply_markup: kb });
}

export async function processBugRejectInput(ctx, reason, issueNumber) {
  if (ctx.role !== 'owner') return;
  if (!Number.isFinite(issueNumber)) {
    await ctx.reply('⚠️ Не нашёл номер bug — попробуй /bug_review заново.');
    return;
  }
  const cleanReason = (reason || '').trim() || 'причина не указана';
  const ownerName = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || 'owner');
  const today = new Date().toISOString().slice(0, 10);

  let commentOk = false;
  try {
    await commentOnIssue(issueNumber,
      `❌ **Rejected by ${ownerName} on ${today}.**\n\n${cleanReason}`);
    commentOk = true;
  } catch (e) { console.warn('[bug_reject] comment failed:', e.message); }

  // Determine current label (bug-pending or bug — both valid for reject path).
  let currentLabel = null;
  try {
    const issue = await getIssue(issueNumber);
    const labels = (issue.labels || []).map(l => l.name);
    if (labels.includes(LABELS.BUG_PENDING)) currentLabel = LABELS.BUG_PENDING;
    else if (labels.includes(LABELS.BUG)) currentLabel = LABELS.BUG;
  } catch (e) { console.warn('[bug_reject] getIssue failed:', e.message); }

  try { await setLabel(issueNumber, LABELS.WONT_FIX, currentLabel); }
  catch (e) { console.warn('[bug_reject] setLabel failed:', e.message); }

  try { await closeIssue(issueNumber, { stateReason: 'not_planned' }); }
  catch (e) { console.warn('[bug_reject] closeIssue failed:', e.message); }

  let pushStatus = 'no_chat_id';
  try {
    const reporterId = await getAssistantChatId(issueNumber);
    if (reporterId && String(reporterId) !== String(ctx.from?.id)) {
      await sendMessage(reporterId,
        `❌ Твой bug-репорт #${issueNumber} отклонён owner'ом.\n\nПричина: ${cleanReason}`);
      pushStatus = 'sent';
    } else if (reporterId) {
      pushStatus = 'self';
    }
  } catch (e) {
    console.warn('[bug_reject] reporter push failed:', e.message);
    pushStatus = 'failed';
  }

  const pushLine = pushStatus === 'sent' ? '📨 DM reporter\'у отправлен.'
    : pushStatus === 'self' ? '(reporter = owner, без DM)'
    : pushStatus === 'no_chat_id' ? '⚠️ DM не отправлен (reporter не найден).'
    : '⚠️ DM упал — см. vercel logs.';

  await ctx.reply(
    `#${issueNumber} → wont-fix + closed.\n` +
    (commentOk ? '📝 Комментарий добавлен.' : '⚠️ Комментарий не записан.') + '\n' + pushLine
  );
}

// M3b — Q25/Q26/Q26.5: scout from bot.
// /scout                — pull next from queue (deferred to Claude Code skill;
//                         bot just nudges)
// /scout <input>        — universal: 2GIS/Google/Yandex/IG/handle/name/own-site URL.
//                         Creates shell issue with `awaiting-scout` label.
// /scout queue          — read _data/scout_queue.json from GitHub (top 5).
// /scout refresh        — leave a marker comment; actual scrape happens locally.
export async function handleScout(ctx) {
  const arg = (ctx.match || '').trim();

  if (arg === 'queue') {
    await replyScoutQueue(ctx);
    return;
  }
  if (arg === 'refresh') {
    await ctx.reply(
      `🔁 Refresh — запусти на ноуте:\n\n` +
      `  node scripts/scrape-venues.mjs --commit\n\n` +
      `После коммита \`_data/scout_queue.json\` обновится, /scout будет тянуть свежие лиды.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!arg) {
    // No args — prompt the user for input. Their next free-form text goes
    // through handleText, which sees cmd-pending and routes here.
    await setCommandPending(String(ctx.from?.id), 'scout');
    await ctx.reply(
      `🔍 Что разведываем? Пришли следующим сообщением:\n\n` +
      `• 2GIS URL (https://2gis.by/...)\n` +
      `• Google или Yandex Maps URL\n` +
      `• Instagram URL или @handle\n` +
      `• URL сайта заведения (если уже есть)\n` +
      `• Просто название\n\n` +
      `Или /cancel чтобы отменить.`
    );
    return;
  }

  await processScoutInput(ctx, arg);
}

// Shared scout input handler — used by both /scout <input> (arg-mode) and
// the conversational follow-up after /scout (no args → prompt → text).
export async function processScoutInput(ctx, input) {
  const parsed = parseScoutInput(input);
  if (parsed.kind === 'empty' || parsed.kind === 'unknown_url') {
    await ctx.reply(
      `Не понял input. Поддерживаю:\n` +
      `• 2GIS URL\n• Google/Yandex Maps URL\n• Instagram URL или @handle\n` +
      `• Свой сайт заведения (URL)\n• Просто название\n\n` +
      `Попробуй /scout ещё раз.`
    );
    return;
  }
  const requesterName = ctx.from?.username ? `@${ctx.from.username}` : `id:${ctx.from?.id}`;
  const issuePayload = buildScoutIssue({ parsed, requesterName, requesterRole: ctx.role });
  let created;
  try {
    created = await createIssue(issuePayload);
  } catch (e) {
    console.error('[scout] createIssue failed:', e.message);
    await ctx.reply(`❌ Не смог создать issue: ${e.message}`);
    return;
  }

  // Bind the issue to the requester so future notifications (scout_reject,
  // approve, etc.) can DM them back. Без этого reject-причина пишется в
  // issue, но ассистент её не видит.
  try {
    await setAssistantChatId(created.number, ctx.from?.id);
  } catch (e) {
    console.warn('[scout] setAssistantChatId failed:', e.message);
  }

  // Direct push owner. Github-webhook не реагирует на `awaiting-scout`
  // (он триггерится только когда Claude Code skill поднимет label до
  // `scouted`). Без этого пинга owner не знает что ассистент предложил
  // лид, пока сам не запустит /process-tg-tasks. Пушим только если
  // requester — НЕ owner (не дублировать самому себе).
  if (ctx.role !== 'owner') {
    const ownerId = getEnv('TG_OWNER_CHAT_ID');
    if (ownerId && String(ownerId) !== String(ctx.from?.id)) {
      const kindHint = parsed.kind === '2gis' ? '2GIS'
        : parsed.kind === 'instagram' ? 'IG'
        : parsed.kind === 'existing_website' ? 'site'
        : parsed.kind === 'name' ? 'name'
        : parsed.kind;
      const text = `🔍 Новая заявка на скаут #${created.number} от ${requesterName} (${kindHint}).\n\n` +
                   `${created.html_url}\n\n` +
                   `Запусти /process-tg-tasks на Mac — skill разведает + поставит \`scouted\`, ` +
                   `после чего сможешь /scout_review approve/reject.`;
      try {
        await sendMessage(ownerId, text);
      } catch (e) {
        console.warn('[scout] owner push failed:', e.message);
      }
    }
  }

  // Ask for optional context note. Без этого Claude Code skill часто не
  // понимает что именно ассистент имел в виду (например: «у бизнеса есть
  // ресторан и гостиница — предлагаю сайт для гостиницы»). Owner-init
  // scout этот flow пропускает — owner сам себе контекст не пишет.
  if (ctx.role === 'owner') {
    await ctx.reply(
      `🔍 Заявка на скаут принята #${created.number}.\n\n` +
      `Запусти на ноуте \`/process-tg-tasks\` — skill сверит, что это.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await setCommandPending(String(ctx.from?.id), 'scout_comment', { issueNumber: created.number });
  await ctx.reply(
    `🔍 Заявка #${created.number} принята.\n\n` +
    `💬 Хочешь приписать примечание — что именно за заведение, почему этот лид, ` +
    `на что обратить внимание (например: «у бизнеса есть и ресторан и отель — ` +
    `предлагаю сделать для отеля»). Пришли одним сообщением.\n\n` +
    `Или /cancel — отправить без комментария.`
  );
}

// Phase 1.1 hotfix — добавляет комментарий ассистента к scout заявке +
// follow-up push owner'у. Триггерится через cmd-pending после
// processScoutInput когда requester — assistant.
export async function processScoutCommentInput(ctx, text, issueNumber) {
  if (!Number.isFinite(issueNumber)) {
    await ctx.reply('⚠️ Не нашёл номер заявки. /scout заново.');
    return;
  }
  const note = (text || '').trim();
  if (!note) {
    await ctx.reply('Пустой текст — пропустил. Заявка ушла без примечания.');
    return;
  }
  const requesterName = ctx.from?.username ? `@${ctx.from.username}` : `id:${ctx.from?.id}`;
  try {
    await commentOnIssue(issueNumber, `📝 **Note from ${requesterName}:**\n\n${note}`);
  } catch (e) {
    console.warn('[scout_comment] commentOnIssue failed:', e.message);
  }
  await ctx.reply(`📝 Примечание добавлено в #${issueNumber}.`);

  const ownerId = getEnv('TG_OWNER_CHAT_ID');
  if (ownerId && String(ownerId) !== String(ctx.from?.id)) {
    try {
      await sendMessage(ownerId,
        `📝 ${requesterName} дополнил заявку #${issueNumber}:\n\n${note}`
      );
    } catch (e) {
      console.warn('[scout_comment] owner follow-up push failed:', e.message);
    }
  }
}

async function pullNextFromQueue(ctx) {
  // The queue file is shipped via scripts/scrape-venues.mjs commits. Bot reads
  // it through the public raw URL — no auth needed for public repos.
  const url = `https://raw.githubusercontent.com/Shebovich/business-sites/main/_data/scout_queue.json`;
  let queue;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    queue = await res.json();
  } catch (e) {
    // Two failure modes share this fallback: queue file doesn't exist (404)
    // or fetch errored. Either way the user wants something actionable, not
    // a stack trace — surface the ad-hoc propose-a-lead path first.
    await ctx.reply(
      `📭 Очередь пуста или ещё не сгенерирована.\n\n` +
      `<b>Предложить лид руками:</b>\n` +
      `<code>/scout https://2gis.by/...</code>\n` +
      `<code>/scout @ig_handle</code>\n` +
      `<code>/scout Название заведения</code>\n\n` +
      `<i>Если хочешь пополнить очередь массово, запусти на ноуте:</i>\n` +
      `<code>node scripts/scrape-venues.mjs --commit</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (!Array.isArray(queue) || queue.length === 0) {
    await ctx.reply(
      `📭 Очередь пуста.\n\n` +
      `<b>Предложить лид руками:</b>\n` +
      `<code>/scout https://2gis.by/...</code>\n` +
      `<code>/scout @ig_handle</code>\n` +
      `<code>/scout Название заведения</code>\n\n` +
      `<i>Или пополни очередь:</i> <code>/scout refresh</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  const next = queue[0];
  const kb = new InlineKeyboard()
    .text('✅ Да, скаутим', `scout_queue:take:${encodeURIComponent(next.id || next.name || '')}`)
    .text('⏭ Следующий', `scout_queue:skip:0`);
  await ctx.reply(
    `Следующий лид:\n• ${next.name || '(no name)'}\n• ⭐ ${next.rating ?? '—'} (${next.review_count ?? '—'} отзывов)\n` +
    `• ${next.address || '(no address)'}\n• 2GIS: ${next.url || '(no url)'}\n\nЗапустить scout?`,
    { reply_markup: kb }
  );
}

async function replyScoutQueue(ctx) {
  const url = `https://raw.githubusercontent.com/Shebovich/business-sites/main/_data/scout_queue.json`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const queue = await res.json();
    if (!Array.isArray(queue) || queue.length === 0) {
      await ctx.reply('Очередь пуста. /scout refresh для пополнения.');
      return;
    }
    const top5 = queue.slice(0, 5);
    const lines = [`Топ ${top5.length} в очереди:`];
    top5.forEach((v, i) => {
      lines.push(`${i + 1}. ${v.name || '(no name)'} · ⭐ ${v.rating ?? '—'}`);
    });
    await ctx.reply(lines.join('\n'));
  } catch (e) {
    await ctx.reply(`Очередь недоступна (${e.message}). /scout refresh — пополнить.`);
  }
}

// Scout review inbox. Показывает ОБА состояния:
//   📝 awaiting-scout — raw заявка от ассистента, ещё не resolved Claude Code
//   ✅ scouted        — Claude Code skill уже разведал, чек-лист готов
// Owner может approve/reject любую напрямую из бота.
// Approve переводит → `approved` (researcher агент подхватит из /process-tg-tasks).
export async function handleScoutReview(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может approve лиды. Ассистент — /scout {input} чтобы предложить.');
    return;
  }
  const [awaiting, scouted] = await Promise.all([
    safeGetActiveTasks(LABELS.AWAITING_SCOUT),
    safeGetActiveTasks(LABELS.SCOUTED),
  ]);
  // De-dup на случай если issue несёт оба лейбла одновременно.
  const seen = new Set();
  const tagged = [];
  for (const t of awaiting) {
    if (seen.has(t.issue_number)) continue;
    seen.add(t.issue_number);
    tagged.push({ ...t, _status: 'awaiting' });
  }
  for (const t of scouted) {
    if (seen.has(t.issue_number)) continue;
    seen.add(t.issue_number);
    tagged.push({ ...t, _status: 'scouted' });
  }
  if (tagged.length === 0) {
    await ctx.reply('Нет лидов на review.\n\n• awaiting-scout — ассистент предложил, ждёт resolve\n• scouted — Claude Code разведал, ждёт approve');
    return;
  }
  // Один reply с inline keyboard — по строке per scout. Tap → детальный
  // view с действиями (зеркалит /list flow).
  const kb = new InlineKeyboard();
  for (const t of tagged) {
    const name = t.venue_name || t.slug || t.title || `issue-${t.issue_number}`;
    const icon = t._status === 'awaiting' ? '📝' : '✅';
    kb.text(`${icon} ${name} · #${t.issue_number}`, `scout_view:${t.issue_number}`).row();
  }
  const awaitingCount = tagged.filter(t => t._status === 'awaiting').length;
  const scoutedCount = tagged.length - awaitingCount;
  const summary = [
    `🔍 Лидов на review: ${tagged.length}`,
    `   📝 raw (от ассистента): ${awaitingCount}`,
    `   ✅ resolved (Claude Code): ${scoutedCount}`,
    '',
    'Тапни на лид — увижу подробности + кнопки approve / reject.',
  ].join('\n');
  await ctx.reply(summary, { reply_markup: kb });
}

// Phase 1.1 — explicit reject path для /scout_review. Owner кнопкой `❌ Reject`
// триггерит prompt причины (через cmd-pending), потом handleText вызывает эту
// функцию: коммент в issue + label `wont-do` + close + push assignee. Если в
// issue body есть Bot-metadata с assistant_chat_id — пингуем его.
export async function processScoutRejectInput(ctx, reason, issueNumber) {
  if (ctx.role !== 'owner') return;
  if (!Number.isFinite(issueNumber)) {
    await ctx.reply('⚠️ Не нашёл issue number в pending state — попробуй /scout_review заново.');
    return;
  }
  const cleanReason = (reason || '').trim() || 'причина не указана';
  const ownerName = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || 'owner');
  const today = new Date().toISOString().slice(0, 10);
  const commentBody = `❌ **Rejected by ${ownerName} on ${today}.**\n\n${cleanReason}`;

  let commentOk = false;
  try {
    await commentOnIssue(issueNumber, commentBody);
    commentOk = true;
  } catch (e) {
    console.warn('[scout_reject] commentOnIssue failed:', e.message);
  }
  // Determine current scout label to remove — issue may be in awaiting-scout
  // (raw, не разведан) или scouted (Claude Code разведал). Reject работает в обоих.
  let currentLabel = null;
  try {
    const issue = await getIssue(issueNumber);
    const labels = (issue.labels || []).map(l => l.name);
    if (labels.includes(LABELS.SCOUTED)) currentLabel = LABELS.SCOUTED;
    else if (labels.includes(LABELS.AWAITING_SCOUT)) currentLabel = LABELS.AWAITING_SCOUT;
  } catch (e) {
    console.warn('[scout_reject] getIssue failed:', e.message);
  }
  try {
    await setLabel(issueNumber, LABELS.WONT_DO, currentLabel);
  } catch (e) {
    console.warn('[scout_reject] setLabel failed:', e.message);
  }
  try {
    await closeIssue(issueNumber, { stateReason: 'not_planned' });
  } catch (e) {
    console.warn('[scout_reject] closeIssue failed:', e.message);
  }
  let pushStatus = 'skipped'; // 'sent' | 'no_chat_id' | 'failed' | 'skipped'
  let assistantId = null;
  try {
    assistantId = await getAssistantChatId(issueNumber);
    if (assistantId) {
      await sendMessage(assistantId,
        `❌ Твой scout #${issueNumber} отклонён owner'ом.\n\n` +
        `Причина: ${cleanReason}\n\n` +
        `Следующий лид — /scout {URL или название}.`
      );
      pushStatus = 'sent';
    } else {
      pushStatus = 'no_chat_id';
    }
  } catch (e) {
    console.warn('[scout_reject] assistant push failed:', e.message);
    pushStatus = 'failed';
  }

  const pushLine = pushStatus === 'sent'
    ? `📨 DM ассистенту отправлен.`
    : pushStatus === 'no_chat_id'
    ? `⚠️ DM ассистенту НЕ отправлен — assistantChatId не записан в Redis (заявка создана до 2026-05-23 fix). Сообщи ассистенту вручную про reject.`
    : `⚠️ DM ассистенту НЕ отправлен (push упал — см. vercel logs).`;

  await ctx.reply(
    `#${issueNumber} → wont-do + closed.\n` +
    (commentOk ? `📝 Комментарий в issue добавлен.` : `⚠️ Комментарий не записан (см. логи).`) + '\n' +
    pushLine
  );
}

// ---- Phase 1.2: task ownership state machine ----------------------------
// Single source of truth для "кто владеет задачей". Owner может взять
// что угодно и игнорировать WIP-limit. Ассистент держит ровно одну
// активную задачу; чтобы сменить — /block /abandon /submit текущую.

async function claimTaskOrFail(chatId, issueNumber, role) {
  const existingAssignee = await getTaskAssignee(issueNumber);
  if (existingAssignee && existingAssignee !== chatId && role !== 'owner') {
    return {
      ok: false,
      msg: `🔒 #${issueNumber} уже взята другим (chat \`${existingAssignee}\`).\n\n` +
           `Если думаешь, что это ошибка — owner может /reassign.`,
    };
  }
  const blocker = await getTaskBlocker(issueNumber);
  if (blocker && existingAssignee !== chatId && role !== 'owner') {
    return {
      ok: false,
      msg: `🚧 #${issueNumber} заблокирована: ${blocker.reason || '(без причины)'}\n\n` +
           `Кто блокировал — chat \`${blocker.set_by}\`. /unblock когда снимут.`,
    };
  }
  if (role !== 'owner') {
    const currentActive = await getActiveTask(chatId);
    if (currentActive && currentActive !== issueNumber) {
      return {
        ok: false,
        msg: `⚠️ У тебя уже активная задача #${currentActive}.\n\n` +
             `Сначала заверши через /submit, поставь на паузу /block ${currentActive} <причина>, ` +
             `или отпусти /abandon ${currentActive} <причина>.`,
      };
    }
  }
  await setTaskAssignee(issueNumber, chatId);
  if (role !== 'owner') {
    await setActiveTask(chatId, issueNumber);
  }
  await touchTask(issueNumber);
  return { ok: true };
}

// /block N <reason> — pause active task, keep assignee but free WIP-slot.
export async function handleBlock(ctx) {
  const { issueNumber, rest } = parseLifecycleArg(ctx.match);
  if (!issueNumber) {
    await ctx.reply(
      'Использование: /block <N> <причина>\n\n' +
      'Пример: /block 19 жду фото меню от клиента',
    );
    return;
  }
  if (!rest) {
    await ctx.reply('Нужна причина блокировки — почему задача стоит.\n\n/block 19 <причина>');
    return;
  }
  const chatId = String(ctx.from?.id);
  const assignee = await getTaskAssignee(issueNumber);
  if (assignee && assignee !== chatId && ctx.role !== 'owner') {
    await ctx.reply(`#${issueNumber} не твоя — assignee \`${assignee}\`. Только он или owner может /block.`,
      { parse_mode: 'Markdown' });
    return;
  }
  await setTaskBlocker(issueNumber, { reason: rest, setBy: chatId });
  const currentActive = await getActiveTask(chatId);
  if (currentActive === issueNumber) {
    await clearActiveTask(chatId);
  }
  const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || chatId);
  try {
    await commentOnIssue(issueNumber, `🚧 **Blocked by ${who}.** ${rest}`);
  } catch (e) { console.warn('[block] commentOnIssue failed:', e.message); }
  await ctx.reply(
    `🚧 #${issueNumber} заблокирована. WIP-слот свободен — можешь брать другую через /list.\n\n` +
    `Снять — /unblock ${issueNumber}.`
  );
}

// /unblock N — clear blocker + re-claim WIP-slot (if assignee).
export async function handleUnblock(ctx) {
  const { issueNumber } = parseLifecycleArg(ctx.match);
  if (!issueNumber) {
    await ctx.reply('Использование: /unblock <N>. Пример: /unblock 19');
    return;
  }
  const chatId = String(ctx.from?.id);
  const assignee = await getTaskAssignee(issueNumber);
  if (assignee && assignee !== chatId && ctx.role !== 'owner') {
    await ctx.reply(`#${issueNumber} не твоя — assignee \`${assignee}\`.`, { parse_mode: 'Markdown' });
    return;
  }
  const blocker = await getTaskBlocker(issueNumber);
  if (!blocker) {
    await ctx.reply(`#${issueNumber} не была заблокирована.`);
    return;
  }
  // Re-claim WIP only if assistant and slot free; owner not subject to WIP rule.
  if (ctx.role !== 'owner' && assignee === chatId) {
    const currentActive = await getActiveTask(chatId);
    if (currentActive && currentActive !== issueNumber) {
      await ctx.reply(
        `Снял блокер с #${issueNumber}, но у тебя уже активна #${currentActive}.\n` +
        `Сначала /block или /abandon её, потом /unblock ${issueNumber} ещё раз.`
      );
      // Don't claim WIP — but blocker is already cleared. Caller can re-trigger.
      await clearTaskBlocker(issueNumber);
      return;
    }
    await setActiveTask(chatId, issueNumber);
  }
  await clearTaskBlocker(issueNumber);
  const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || chatId);
  try {
    await commentOnIssue(issueNumber, `✅ **Unblocked by ${who}.**`);
  } catch (e) { console.warn('[unblock] commentOnIssue failed:', e.message); }
  await ctx.reply(`✅ #${issueNumber} разблокирована. /current → продолжить.`);
}

// /abandon N <reason> — release task entirely (clear assignee + blocker + my active_task).
export async function handleAbandon(ctx) {
  const { issueNumber, rest } = parseLifecycleArg(ctx.match);
  if (!issueNumber) {
    await ctx.reply(
      'Использование: /abandon <N> <причина>\n\n' +
      'Пример: /abandon 19 не моя зона — пусть кто-то другой возьмёт',
    );
    return;
  }
  if (!rest) {
    await ctx.reply('Нужна причина abandon (чтобы owner понимал почему отпустил).\n\n/abandon 19 <причина>');
    return;
  }
  const chatId = String(ctx.from?.id);
  const assignee = await getTaskAssignee(issueNumber);
  if (assignee && assignee !== chatId && ctx.role !== 'owner') {
    await ctx.reply(`#${issueNumber} не твоя — assignee \`${assignee}\`.`, { parse_mode: 'Markdown' });
    return;
  }
  await clearTaskAssignee(issueNumber);
  await clearTaskBlocker(issueNumber);
  if (assignee) {
    const theirActive = await getActiveTask(assignee);
    if (theirActive === issueNumber) {
      await clearActiveTask(assignee);
    }
  }
  const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || chatId);
  try {
    await commentOnIssue(issueNumber, `↩️ **Abandoned by ${who}.** ${rest}`);
  } catch (e) { console.warn('[abandon] commentOnIssue failed:', e.message); }
  await ctx.reply(`↩️ #${issueNumber} отпущена — теперь её может взять любой.`);
}

// /reassign N <chatId> — owner-only transfer. Username→id resolution не делаем
// (TG не позволяет надёжно получить chatId по username без предварительного
// /start). Owner копирует chatId из /whoami у нужного ассистента.
export async function handleReassign(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может /reassign. Ассистент — /abandon, потом другой возьмёт.');
    return;
  }
  const arg = (ctx.match || '').trim();
  const m = arg.match(/^#?(\d+)\s+(\d+)\s*$/);
  if (!m) {
    await ctx.reply(
      'Использование: /reassign <N> <chatId>\n\n' +
      'Пример: /reassign 19 123456789\n\n' +
      'chatId нового ассистента — /whoami у него в чате.'
    );
    return;
  }
  const issueNumber = Number(m[1]);
  const newAssignee = m[2];
  const oldAssignee = await getTaskAssignee(issueNumber);
  if (oldAssignee) {
    const theirActive = await getActiveTask(oldAssignee);
    if (theirActive === issueNumber) {
      await clearActiveTask(oldAssignee);
    }
  }
  await setTaskAssignee(issueNumber, newAssignee);
  await clearTaskBlocker(issueNumber);
  try {
    await commentOnIssue(issueNumber,
      `🔁 **Reassigned by owner.** ${oldAssignee ? `\`${oldAssignee}\` → ` : ''}\`${newAssignee}\``
    );
  } catch (e) { console.warn('[reassign] commentOnIssue failed:', e.message); }
  try {
    await sendMessage(newAssignee,
      `📥 Owner назначил тебе задачу #${issueNumber}. Открой /list → выбери её.`
    );
  } catch (e) { console.warn('[reassign] notify new assignee failed:', e.message); }
  if (oldAssignee && oldAssignee !== newAssignee) {
    try {
      await sendMessage(oldAssignee,
        `🔁 #${issueNumber} передана другому ассистенту owner'ом.`
      );
    } catch (e) { console.warn('[reassign] notify old assignee failed:', e.message); }
  }
  await ctx.reply(`🔁 #${issueNumber}: assignee ${oldAssignee || '(никого)'} → \`${newAssignee}\`.`,
    { parse_mode: 'Markdown' });
}

export async function handleList(ctx) {
  const needsReview = await safeGetActiveTasks(LABELS.NEEDS_VISUAL_REVIEW);
  // Only owner sees the `awaiting-owner-review` queue inline with /list;
  // assistants don't need to act on submissions waiting for owner.
  const awaitingOwner = ctx.role === 'owner'
    ? await safeGetActiveTasks(LABELS.AWAITING_OWNER_REVIEW)
    : [];

  // De-dup: an issue could theoretically carry both labels mid-transition.
  const seen = new Set();
  const tagged = [];
  for (const t of needsReview) {
    if (seen.has(t.issue_number)) continue;
    seen.add(t.issue_number);
    tagged.push({ ...t, _icon: '📋' });
  }
  for (const t of awaitingOwner) {
    if (seen.has(t.issue_number)) continue;
    seen.add(t.issue_number);
    tagged.push({ ...t, _icon: '🔵' });
  }

  if (tagged.length === 0) {
    await ctx.reply('Нет активных задач. Жду лейбла `needs-visual-review`.');
    return;
  }
  const kb = buildTaskListKeyboard(tagged);
  await ctx.reply(`Активных задач: ${tagged.length}`, { reply_markup: kb });
}

// M3c — Q30: batch pitch review. Lists ready-for-pitch issues with per-issue
// action buttons. Owner taps [✅ Pitched] / [🔄 Revise] / [⏭ Skip].
// Phase 1.4 — /stats: pipeline conversion analytics для owner. Считает по
// labels через GitHub API (источник правды), pitchInfo из Redis для канала.
export async function handleStats(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner видит /stats.');
    return;
  }
  await ctx.reply('📊 Считаю…');

  // Live pipeline (open) — все стадии до pitched.
  const openLabels = [
    [LABELS.SCOUTED,                 '🆕 scouted'],
    ['approved',                     '✅ approved'],
    ['researched',                   '🔬 researched'],
    ['design-pending',               '🎨 design-pending'],
    ['design-approved',              '✏️ design-approved'],
    ['building',                     '🏗 building'],
    [LABELS.BUILT,                   '🧱 built'],
    [LABELS.NEEDS_VISUAL_REVIEW,     '📋 needs-visual-review'],
    [LABELS.AWAITING_CLAUDE_PROCESS, '🤖 awaiting-claude-process'],
    [LABELS.AWAITING_OWNER_REVIEW,   '🔵 awaiting-owner-review'],
    [LABELS.READY_FOR_PITCH,         '🎉 ready-for-pitch'],
    [LABELS.PITCHED,                 '📤 pitched'],
  ];

  const openCounts = {};
  for (const [label, _] of openLabels) {
    try {
      const list = await listIssuesByLabel(label);
      openCounts[label] = list.length;
    } catch (e) {
      openCounts[label] = `err:${e.message.slice(0, 30)}`;
    }
  }

  // Closed outcomes — pull sold/lost/ghosted/wont-do.
  const closedLabels = [
    [LABELS.SOLD,    '💰 sold'],
    [LABELS.LOST,    '❌ lost'],
    ['ghosted',      '👻 ghosted'],
    [LABELS.WONT_DO, '🚫 wont-do'],
  ];
  const closedCounts = {};
  const closedIssues = {};
  for (const [label, _] of closedLabels) {
    try {
      const list = await listIssuesByLabel(label, { state: 'closed' });
      closedCounts[label] = list.length;
      closedIssues[label] = list;
    } catch (e) {
      closedCounts[label] = `err:${e.message.slice(0, 30)}`;
      closedIssues[label] = [];
    }
  }

  const sold = Number(closedCounts[LABELS.SOLD]) || 0;
  const lost = Number(closedCounts[LABELS.LOST]) || 0;
  const ghosted = Number(closedCounts['ghosted']) || 0;
  const totalResolved = sold + lost + ghosted;
  const conv = totalResolved > 0 ? Math.round((sold / totalResolved) * 100) : null;

  // Avg time pitched→closed для проданных. Берём issues с label=sold,
  // если в Redis есть pitchInfo — считаем дельту от него; иначе используем
  // closed_at - created_at как грубую прокси (ниже точности).
  const soldIssues = closedIssues[LABELS.SOLD] || [];
  let avgDaysToClose = null;
  if (soldIssues.length) {
    const deltas = [];
    for (const i of soldIssues) {
      const pitch = await getPitchInfo(i.number).catch(() => null);
      const start = pitch?.at ? new Date(pitch.at).getTime() : new Date(i.created_at).getTime();
      const end = new Date(i.closed_at || Date.now()).getTime();
      const days = (end - start) / 86_400_000;
      if (Number.isFinite(days) && days >= 0) deltas.push(days);
    }
    if (deltas.length) {
      avgDaysToClose = Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10;
    }
  }

  // Per-channel breakdown — собираем для всех resolved (sold/lost/ghosted).
  const channelStats = {};
  for (const status of [LABELS.SOLD, LABELS.LOST, 'ghosted']) {
    for (const i of (closedIssues[status] || [])) {
      const pitch = await getPitchInfo(i.number).catch(() => null);
      const ch = pitch?.channel || 'unknown';
      if (!channelStats[ch]) channelStats[ch] = { sold: 0, lost: 0, ghosted: 0 };
      const k = status === LABELS.SOLD ? 'sold' : (status === LABELS.LOST ? 'lost' : 'ghosted');
      channelStats[ch][k] += 1;
    }
  }

  // Render.
  const lines = ['📊 **Pipeline stats**', ''];
  lines.push('*Активные:*');
  for (const [label, display] of openLabels) {
    const c = openCounts[label];
    if (c === 0 || c === '0') continue;
    lines.push(`  ${display}: ${c}`);
  }
  lines.push('');
  lines.push('*Закрытые (всё время):*');
  for (const [label, display] of closedLabels) {
    lines.push(`  ${display}: ${closedCounts[label]}`);
  }
  lines.push('');
  lines.push('*Conversion:*');
  lines.push(`  sold / (sold+lost+ghosted) = ${conv === null ? '—' : conv + '%'}  (n=${totalResolved})`);
  if (avgDaysToClose !== null) {
    lines.push(`  avg days pitched→sold: ${avgDaysToClose}`);
  }
  if (Object.keys(channelStats).length) {
    lines.push('');
    lines.push('*По каналам:*');
    for (const [ch, s] of Object.entries(channelStats)) {
      const total = s.sold + s.lost + s.ghosted;
      const cConv = total ? Math.round((s.sold / total) * 100) + '%' : '—';
      lines.push(`  ${ch}: ${s.sold}/${total} sold (${cConv}), lost ${s.lost}, ghosted ${s.ghosted}`);
    }
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

export async function handlePitchReview(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner ревьюит готовые сайты.');
    return;
  }
  const tasks = await safeGetActiveTasks(LABELS.READY_FOR_PITCH);
  if (tasks.length === 0) {
    await ctx.reply('Нет готовых сайтов на pitch. Когда builder поставит `ready-for-pitch`, увидишь здесь.');
    return;
  }
  await ctx.reply(`🎉 Готово к pitch: ${tasks.length}`);
  for (const t of tasks) {
    const name = t.venue_name || t.slug || `issue-${t.issue_number}`;
    const previewUrl = `https://${t.slug}.vercel.app`;
    const kb = new InlineKeyboard()
      .text('✅ Pitched', `pitch:${t.issue_number}:pitched`)
      .text('🔄 Revise', `pitch:${t.issue_number}:revise`)
      .text('⏭ Skip', `pitch:${t.issue_number}:skip`);
    await ctx.reply(
      `📋 ${name} · #${t.issue_number}\n${previewUrl}\nIssue: ${t.html_url}`,
      { reply_markup: kb }
    );
  }
}

// M3c — Q31: lifecycle commands.
//   /sold N [notes]   — pitched → sold
//   /lost N [reason]  — pitched → lost, close issue
//   /ghosted N        — alias for /lost N "ghosted, no response"

export async function handleSold(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может отмечать sold.');
    return;
  }
  const raw = (ctx.match || '').trim();
  if (!raw) {
    await setCommandPending(String(ctx.from?.id), 'sold');
    await ctx.reply(
      '💰 Какой issue # продан? Пришли следующим сообщением:\n\n' +
      'Только номер: <code>19</code>\n' +
      'Номер + заметка: <code>19 предоплата 50%</code>\n\n' +
      'Или /cancel чтобы отменить.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  await processSoldInput(ctx, raw);
}

export async function processSoldInput(ctx, raw) {
  const { issueNumber, rest } = parseLifecycleArg(raw);
  if (!issueNumber) {
    await ctx.reply('Не понял номер issue. Пример: <code>19</code> или <code>19 предоплата 50%</code>',
      { parse_mode: 'HTML' });
    return;
  }
  try {
    await setLabel(issueNumber, LABELS.SOLD, LABELS.PITCHED);
  } catch (e) {
    await ctx.reply(`❌ setLabel failed: ${e.message}`);
    return;
  }
  const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'owner';
  const today = new Date().toISOString().slice(0, 10);
  try {
    await commentOnIssue(issueNumber,
      `**Sold by ${ownerName} on ${today}.**${rest ? `\n\n${rest}` : ''}`
    );
  } catch (e) {
    console.warn('[sold] commentOnIssue failed:', e.message);
  }
  try {
    const assistantId = await getAssistantChatId(issueNumber);
    if (assistantId) {
      await sendMessage(assistantId, `💰 #${issueNumber} продан. Спасибо!`);
    }
  } catch (e) {
    console.warn('[sold] assistant push failed:', e.message);
  }
  await ctx.reply(
    `🎉 #${issueNumber} → \`sold\`.\n\nНе забудь: подключить домен клиента вместо vercel namespace, выставить счёт.`,
    { parse_mode: 'Markdown' }
  );
}

export async function handleLost(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может отмечать lost.');
    return;
  }
  const raw = (ctx.match || '').trim();
  if (!raw) {
    await setCommandPending(String(ctx.from?.id), 'lost');
    await ctx.reply(
      '❌ Какой issue # не сложился? Пришли следующим сообщением:\n\n' +
      'Только номер: <code>19</code>\n' +
      'Номер + причина: <code>19 дорого, выбрали конкурента</code>\n\n' +
      'Или /cancel чтобы отменить.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  await processLostInput(ctx, raw);
}

export async function processLostInput(ctx, raw) {
  const { issueNumber, rest } = parseLifecycleArg(raw);
  if (!issueNumber) {
    await ctx.reply('Не понял номер issue. Пример: <code>19</code> или <code>19 дорого</code>',
      { parse_mode: 'HTML' });
    return;
  }
  await markLost(ctx, issueNumber, rest || 'no reason given');
}

export async function handleGhosted(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может отмечать ghosted.');
    return;
  }
  const raw = (ctx.match || '').trim();
  if (!raw) {
    await setCommandPending(String(ctx.from?.id), 'ghosted');
    await ctx.reply(
      '👻 Какой issue # ghosted? Пришли номер следующим сообщением.\n\n' +
      'Пример: <code>19</code>\n\nИли /cancel.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  await processGhostedInput(ctx, raw);
}

export async function processGhostedInput(ctx, raw) {
  const issueNumber = Number(raw.replace(/^#/, ''));
  if (!Number.isFinite(issueNumber)) {
    await ctx.reply('Не понял номер. Просто число, например <code>19</code>.',
      { parse_mode: 'HTML' });
    return;
  }
  await markLost(ctx, issueNumber, 'ghosted — no response');
}

async function markLost(ctx, issueNumber, reason) {
  try {
    await setLabel(issueNumber, LABELS.LOST, LABELS.PITCHED);
  } catch (e) {
    await ctx.reply(`❌ setLabel failed: ${e.message}`);
    return;
  }
  const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'owner';
  const today = new Date().toISOString().slice(0, 10);
  try {
    await commentOnIssue(issueNumber,
      `**Lost on ${today}** (by ${ownerName}).\n\nReason: ${reason}`
    );
  } catch (e) {
    console.warn('[lost] commentOnIssue failed:', e.message);
  }
  // Close the issue — lost stays for history but doesn't clutter active queues.
  try {
    await closeIssue(issueNumber);
  } catch (e) {
    console.warn('[lost] closeIssue failed:', e.message);
  }
  try {
    const assistantId = await getAssistantChatId(issueNumber);
    if (assistantId) {
      await sendMessage(assistantId, `❌ #${issueNumber} не сложилось. Спасибо за работу.`);
    }
  } catch (e) {
    console.warn('[lost] assistant push failed:', e.message);
  }
  await ctx.reply(`#${issueNumber} → \`lost\` (issue closed).`, { parse_mode: 'Markdown' });
}

function parseLifecycleArg(match) {
  const arg = (match || '').trim();
  if (!arg) return { issueNumber: null, rest: '' };
  const m = arg.match(/^#?(\d+)\s*(.*)$/);
  if (!m) return { issueNumber: null, rest: '' };
  return { issueNumber: Number(m[1]), rest: m[2].trim() };
}

// Owner-only queue of assistant submissions waiting for review.
export async function handleOwnerReview(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может смотреть очередь ревью.');
    return;
  }
  const tasks = await safeGetActiveTasks(LABELS.AWAITING_OWNER_REVIEW);
  if (tasks.length === 0) {
    await ctx.reply('Нет задач на ревью. Когда ассистент сделает /submit, они появятся здесь.');
    return;
  }
  const tagged = tasks.map(t => ({ ...t, _icon: '🔵' }));
  const kb = buildTaskListKeyboard(tagged);
  await ctx.reply(`На ревью: ${tasks.length}`, { reply_markup: kb });
}

// ---- M2 stubs (kept thin so the bot stays responsive) -------------------

export async function handleCurrent(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) {
    await ctx.reply('Нет текущей задачи. Открой /list и выбери одну.');
    return;
  }
  const kb = await buildSectionKeyboard(task.issue_number);
  const lines = [
    `📋 #${task.issue_number} ${task.venue_name || task.slug}`,
    `🔗 Посмотреть результат: ${task.preview_url || '(будет после первого деплоя)'}`,
  ];
  if (task.instagram) {
    const handle = task.instagram.replace(/^@/, '');
    lines.push(`📸 Instagram: ${task.instagram} (https://instagram.com/${handle})`);
  }
  await ctx.reply(lines.join('\n'), { reply_markup: kb });
}

export async function handleSkip(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const arg = ctx.match?.trim();
  if (!arg || !getSectionById(arg)) {
    await ctx.reply('Использование: /skip <section_id>. Список секций — /current.');
    return;
  }
  await skipSection(task.issue_number, arg);
  await ctx.reply(`Секция ${arg} помечена как skipped.`);
}

export async function handleCancel(ctx) {
  const hadBug = !!(await getBugSession(ctx.from.id).catch(() => null));
  await clearCurrentTask(ctx.from.id);
  await clearFeedbackPending(ctx.from.id);
  await clearCommandPending(ctx.from.id);
  await clearBugSession(ctx.from.id);
  await ctx.reply(`Сброшено${hadBug ? ' (включая bug-сессию)' : ''}.`);
}

// ---- M2.5: /done_all (owner) + /auto_photos (owner) + /submit (assistant) ----

export async function handleDoneAll(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может финализировать. Используй /submit чтобы передать задачу на ревью.');
    return;
  }
  await runRebuild(ctx, { mode: 'manual' });
}

export async function handleAutoPhotos(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может финализировать. Используй /submit чтобы передать задачу на ревью.');
    return;
  }
  await runRebuild(ctx, { mode: 'auto' });
}

// Assistant flow: marks current task as ready for owner review.
// M3a: also pushes the full content snapshot to owner with action buttons,
// and rejects no-op resubmits via SHA-1 content hash (Q24).
export async function handleSubmit(ctx) {
  if (ctx.role !== 'assistant') {
    await ctx.reply('Команда /submit — только для ассистентов. Owner финализирует через /done_all.');
    return;
  }
  const task = await getCurrentTask(ctx.from.id);
  if (!task) {
    await ctx.reply('Нет текущей задачи. Открой /list и выбери одну.');
    return;
  }

  // Q24: hash check. Identical content vs last submit → reject so assistant
  // doesn't accidentally re-trigger after feedback without changing anything.
  const state = await collectSubmitState(task.issue_number);
  const hash = hashSubmitState(state);
  const lastHash = await getLastSubmitHash(task.issue_number);
  const round = await getRound(task.issue_number);
  if (lastHash && lastHash === hash) {
    await ctx.reply(
      `⚠️ Состояние задачи не поменялось с предыдущего /submit.\n\n` +
      `Если получил замечания от owner'а — внеси правки (отправь новое фото / удали /rm / поправь текст), потом снова /submit.`
    );
    return;
  }

  // Remember which assistant owns this submission so feedback push can find
  // them later. Overwrites prior value if a different assistant takes over.
  await setAssistantChatId(task.issue_number, ctx.from.id);

  // Q20: roll label forward. Round counter increments now so the owner push
  // shows the correct number.
  try {
    await setLabel(task.issue_number, LABELS.AWAITING_OWNER_REVIEW, LABELS.NEEDS_VISUAL_REVIEW);
  } catch (e) {
    console.error('[submit] setLabel failed:', e.message);
    await ctx.reply(`❌ Не смог поменять лейбл: ${e.message}`);
    return;
  }
  const newRound = await incRound(task.issue_number);
  await setLastSubmitHash(task.issue_number, hash);

  try {
    const who = ctx.from?.username ? `@${ctx.from.username}` : `assistant ${ctx.from?.id}`;
    await commentOnIssue(
      task.issue_number,
      `${who} submitted for review (round ${newRound}, via TG bot).`
    );
  } catch (e) {
    console.warn('[submit] commentOnIssue failed:', e.message);
  }

  // Q19: push owner the full content snapshot + action buttons.
  await sendOwnerPush(task, ctx, state, newRound);

  await ctx.reply(`✅ Задача передана (раунд ${newRound}). Owner получит уведомление.`);
}

// Q19 push. Falls back silently if TG_OWNER_CHAT_ID isn't configured — bot
// remains usable in solo mode but owner won't see assistant submissions.
async function sendOwnerPush(task, ctx, state, round) {
  const ownerId = getEnv('TG_OWNER_CHAT_ID');
  if (!ownerId) {
    console.warn('[submit] TG_OWNER_CHAT_ID not set — skipping owner push');
    return;
  }
  const who = ctx.from?.username ? `@${ctx.from.username}` : `Ассистент ${ctx.from?.id}`;
  const body = buildOwnerPush({ task, who, round, state });
  const kb = buildOwnerPushKeyboard(task.issue_number);
  try {
    await sendMessage(ownerId, body, { reply_markup: kb });
  } catch (e) {
    console.error('[submit] sendOwnerPush failed:', e.message);
  }
}

// M3a — Q23: owner /approve. Same finalise path as /done_all but explicitly
// scoped to a task that's currently `awaiting-owner-review`. Can be called
// via inline button (`approve:N`) or `/approve N` text command.
export async function handleApprove(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может одобрять задачи. Ассистент — /submit.');
    return;
  }
  const arg = (ctx.match || '').trim();
  if (arg) {
    await processApproveInput(ctx, arg);
    return;
  }
  // No arg — fall back to current task if it exists; otherwise prompt.
  const task = await getCurrentTask(ctx.from.id);
  if (task) {
    await runApprove(ctx, task.issue_number);
    return;
  }
  await setCommandPending(String(ctx.from?.id), 'approve');
  await ctx.reply(
    '✅ Какой issue # одобряем? Пришли номер следующим сообщением.\n\n' +
    'Пример: <code>19</code>\n\nИли /cancel.',
    { parse_mode: 'HTML' }
  );
}

export async function processApproveInput(ctx, raw) {
  const issueNumber = Number(raw.replace(/^#/, ''));
  if (!Number.isFinite(issueNumber)) {
    await ctx.reply('Не понял номер. Просто число, например <code>19</code>.',
      { parse_mode: 'HTML' });
    return;
  }
  await runApprove(ctx, issueNumber);
}

// Shared between /approve command and `approve:N` callback.
// Returns { ok, slug, dispatched } so /approve_all can summarise.
async function runApprove(ctx, issueNumber, { silent = false } = {}) {
  let issue;
  try {
    issue = await getIssue(issueNumber);
  } catch (e) {
    if (!silent) await ctx.reply(`❌ Не нашёл issue #${issueNumber}: ${e.message}`);
    return { ok: false, error: e.message };
  }
  const slug = extractSlugFromIssue(issue);
  const task = {
    issue_number: issueNumber,
    slug,
    venue_name: extractVenueName(issue.title),
    html_url: issue.html_url,
  };

  if (!silent) {
    await ctx.reply(`Принимаю #${issueNumber} <code>${slug}</code>. Коммичу input.json...`,
      { parse_mode: 'HTML' });
  }
  const ok = await commitInputAndFlipLabel({
    task,
    mode: 'manual',
    ctx,
    fromLabel: LABELS.AWAITING_OWNER_REVIEW,
    silent,
  });
  if (!ok) return { ok: false, slug };

  // Q22b: wipe Redis state immediately — repo input.json is source of truth.
  try {
    const removed = await clearTaskState(issueNumber);
    console.log(`[approve] cleared ${removed} Redis keys for task ${issueNumber}`);
  } catch (e) {
    console.warn('[approve] clearTaskState failed:', e.message);
  }

  // Push back to assistant if known.
  try {
    const assistantId = await getAssistantChatId(issueNumber);
    if (assistantId) {
      const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'Pavel';
      await sendMessage(assistantId,
        `✅ ${ownerName} одобрил ${task.venue_name || slug} #${issueNumber}. Спасибо!`
      );
    }
  } catch (e) {
    console.warn('[approve] assistant push failed:', e.message);
  }

  try {
    const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'owner';
    const round = await getRound(issueNumber);
    await commentOnIssue(issueNumber,
      `**Approved by ${ownerName} (round ${round || 1}). Dispatching GH Actions rebuild.**`
    );
  } catch (e) {
    console.warn('[approve] commentOnIssue failed:', e.message);
  }

  // Auto-dispatch GitHub Actions visual-review workflow — no laptop needed.
  let dispatched = false;
  try {
    await dispatchWorkflow({
      workflow: 'visual-review.yml',
      inputs: { issue_number: String(issueNumber), slug },
    });
    dispatched = true;
  } catch (e) {
    console.error('[approve] dispatchWorkflow failed:', e.message);
    if (!silent) {
      await ctx.reply(
        `⚠️ Approved, но не смог запустить GH Actions workflow: ${e.message}\n\n` +
        `Fallback: запусти на ноуте <code>/process-tg-tasks</code>.`,
        { parse_mode: 'HTML' }
      );
    }
  }

  if (!silent) {
    if (dispatched) {
      await ctx.reply(
        `✅ Принято. GH Actions запущен — следи за прогрессом:\n` +
        `https://github.com/Shebovich/business-sites/actions/workflows/visual-review.yml\n\n` +
        `Когда сборка пройдёт, придёт push «#${issueNumber} обновлено» (label <code>built</code>).`,
        { parse_mode: 'HTML' }
      );
    }
  }
  return { ok: true, slug, dispatched };
}

// /approve_all — batch approve every awaiting-owner-review submit + dispatch
// workflows. After this command, GH Actions does the rebuild + deploy + label
// update for every task autonomously. Claude Code на ноуте не нужен.
export async function handleApproveAll(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может делать batch-approve.');
    return;
  }
  const tasks = await safeGetActiveTasks(LABELS.AWAITING_OWNER_REVIEW);
  if (tasks.length === 0) {
    await ctx.reply('Нет submit\'ов на approve. /list если хочешь посмотреть всё, что в работе.');
    return;
  }
  await ctx.reply(`🚀 Batch approve: ${tasks.length} задач. Прохожусь по очереди...`);

  const results = [];
  for (const t of tasks) {
    const res = await runApprove(ctx, t.issue_number, { silent: true });
    results.push({ task: t, ...res });
  }

  const ok = results.filter(r => r.ok && r.dispatched);
  const partial = results.filter(r => r.ok && !r.dispatched);
  const failed = results.filter(r => !r.ok);

  const lines = [`✅ Batch approve завершён.\n`];
  if (ok.length > 0) {
    lines.push(`<b>Отправлено в GH Actions (${ok.length}):</b>`);
    for (const r of ok) lines.push(`• #${r.task.issue_number} ${r.task.venue_name || r.slug}`);
    lines.push('');
  }
  if (partial.length > 0) {
    lines.push(`<b>⚠️ Approved, но workflow не запустился (${partial.length}):</b>`);
    for (const r of partial) lines.push(`• #${r.task.issue_number} ${r.task.venue_name || r.slug} — запусти /process-tg-tasks на ноуте`);
    lines.push('');
  }
  if (failed.length > 0) {
    lines.push(`<b>❌ Не получилось (${failed.length}):</b>`);
    for (const r of failed) lines.push(`• #${r.task.issue_number}: ${r.error || 'unknown error'}`);
    lines.push('');
  }
  if (ok.length > 0) {
    lines.push(`Прогресс: https://github.com/Shebovich/business-sites/actions/workflows/visual-review.yml`);
    lines.push(`Когда задача собрана — придёт push «обновлено».`);
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// M3a — Q24.5: read-only summary of the current task. Same content as the
// owner push but sent to the caller. Useful for assistants to verify what
// they've submitted before /submit.
export async function handlePreview(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) {
    await ctx.reply('Нет текущей задачи. /list для выбора.');
    return;
  }
  const state = await collectSubmitState(task.issue_number);
  const round = await getRound(task.issue_number);
  const who = ctx.from?.username ? `@${ctx.from.username}` : `Ассистент ${ctx.from?.id}`;
  const body = buildOwnerPush({ task, who, round: round || 1, state });
  // Per-section gallery shortcuts for sections that have at least one item.
  const sectionsWithPhotos = getSections()
    .map(s => s.id)
    .filter(id => (state.sections[id] || []).length > 0);
  const kb = sectionsWithPhotos.length > 0
    ? buildPreviewKeyboard(task.issue_number, sectionsWithPhotos)
    : undefined;
  await ctx.reply(body, kb ? { reply_markup: kb } : {});
}

// M3a — Q24.5: /rm <section> <N> — remove Nth photo from a section.
export async function handleRm(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const arg = (ctx.match || '').trim();
  const parts = arg.split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply('Использование: /rm <section_id> <N>. N — номер фото из /preview (1-based).');
    return;
  }
  const [sectionId, nStr] = parts;
  if (!getSectionById(sectionId)) {
    await ctx.reply(`Секция \`${sectionId}\` не найдена. Список — /current.`, { parse_mode: 'Markdown' });
    return;
  }
  const n = Number(nStr);
  if (!Number.isInteger(n) || n < 1) {
    await ctx.reply('N должно быть положительным целым (1, 2, 3...).');
    return;
  }
  const removed = await removePhotoAt(task.issue_number, sectionId, n);
  if (!removed) {
    await ctx.reply(`В секции \`${sectionId}\` нет элемента №${n}. Открой /preview.`, { parse_mode: 'Markdown' });
    return;
  }
  const remaining = await getPhotos(task.issue_number, sectionId);
  await ctx.reply(`🗑 Удалено из ${sectionId}. Осталось: ${remaining.length}.`);
}

// M3.1: /note <текст> — добавить заметку к задаче (не привязана к секции).
// Полезно когда хочешь оставить общий комментарий, не выбирая конкретную секцию.
// Если активна секция — заметка привяжется к ней.
export async function handleNote(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const text = (ctx.match || '').trim();
  if (!text) {
    await setCommandPending(String(ctx.from?.id), 'note');
    await ctx.reply(
      '📝 Напиши текст заметки следующим сообщением.\n\n' +
      'Пример: «приоритет hero и menu, остальное по возможности».\n\n' +
      'Или /cancel чтобы отменить.'
    );
    return;
  }
  await processNoteInput(ctx, text);
}

export async function processNoteInput(ctx, text) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const sectionId = await getActiveSection(ctx.from.id);
  await addNote(task.issue_number, sectionId || null, text);
  const where = sectionId ? `к секции ${sectionId}` : 'к задаче (общая)';
  await ctx.reply(`📝 Заметка добавлена ${where}: «${truncatePreview(text)}»`);
}

// M3.1: /notes — показать все заметки текущей задачи (нумерованным списком).
export async function handleNotes(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const notes = await getNotes(task.issue_number);
  if (notes.length === 0) {
    await ctx.reply('Заметок пока нет. Пиши прямо в чат — всё, что без URL, попадёт в заметки.');
    return;
  }
  const lines = [`📝 Заметки задачи #${task.issue_number} (${notes.length}):`, ''];
  notes.forEach((n, i) => {
    const where = n.section || 'общая';
    lines.push(`<b>${i + 1}.</b> [${where}] ${escapeHtml(n.text)}`);
  });
  lines.push('', 'Удалить: /rm_note &lt;N&gt;\nОчистить все: /clear_notes');
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// M3.1: /rm_note <N> — удалить заметку по индексу из /notes (1-based).
export async function handleRmNote(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const arg = (ctx.match || '').trim();
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) {
    await ctx.reply('Использование: /rm_note <N>. N — номер из /notes (1-based).');
    return;
  }
  const removed = await removeNoteAt(task.issue_number, n);
  if (!removed) {
    await ctx.reply(`Заметки №${n} нет. /notes покажет актуальные.`);
    return;
  }
  await ctx.reply(`🗑 Удалена заметка №${n}: «${truncatePreview(removed.text)}»`);
}

// M3.1: /clear_notes — снести все заметки задачи (фото/тексты не трогает).
export async function handleClearNotes(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  await clearNotes(task.issue_number);
  await ctx.reply('🗑 Все заметки задачи удалены.');
}

// M3a — Q24.5: /unskip <section> — отмена /skip.
export async function handleUnskip(ctx) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) { await ctx.reply('Нет текущей задачи. /list для выбора.'); return; }
  const arg = ctx.match?.trim();
  if (!arg || !getSectionById(arg)) {
    await ctx.reply('Использование: /unskip <section_id>. Список секций — /current.');
    return;
  }
  await unskipSection(task.issue_number, arg);
  await ctx.reply(`↩️ Секция ${arg} снова в работе.`);
}

// Shared dispatcher — collects state, commits input JSON, flips label.
// Used by /done_all (owner solo) and /auto_photos. /approve has its own
// wrapper since it operates on a non-current task and adds Redis cleanup.
async function runRebuild(ctx, { mode }) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) {
    await ctx.reply('Нет текущей задачи. Открой /list и выбери одну.');
    return;
  }

  const friendly = mode === 'auto' ? 'auto-curation (Q14/Q15)' : 'manual visual review';
  await ctx.reply(`Запускаю rebuild (${friendly}) для #${task.issue_number} \`${task.slug}\`...`, { parse_mode: 'Markdown' });

  const ok = await commitInputAndFlipLabel({
    task,
    mode,
    ctx,
    fromLabel: LABELS.NEEDS_VISUAL_REVIEW,
  });
  if (!ok) return;

  // Keep photo lists in case workflow fails — same as before.
  await setActiveSection(ctx.from.id, '');

  // Auto-dispatch GH Actions — Claude Code на ноуте не нужен.
  let dispatched = false;
  try {
    await dispatchWorkflow({
      workflow: 'visual-review.yml',
      inputs: { issue_number: String(task.issue_number), slug: task.slug },
    });
    dispatched = true;
  } catch (e) {
    console.error('[done_all] dispatchWorkflow failed:', e.message);
  }

  if (dispatched) {
    await ctx.reply(
      `✅ Input закоммичен, GH Actions запущен.\n\n` +
      `Прогресс: https://github.com/Shebovich/business-sites/actions/workflows/visual-review.yml\n\n` +
      `Когда сборка пройдёт, придёт push «обновлено» (label <code>built</code>).`,
      { parse_mode: 'HTML' }
    );
  } else {
    await ctx.reply(
      `✅ Input закоммичен, label <code>awaiting-claude-process</code> поставлен, но workflow не запустился.\n\n` +
      `Fallback: открой Claude Code на ноуте и напиши <code>/process-tg-tasks</code>.`,
      { parse_mode: 'HTML' }
    );
  }
}

// Build input.json from Redis state, commit it to the repo, flip the label
// to AWAITING_CLAUDE_PROCESS. Returns true on success, false on failure.
// In `silent` mode error replies are suppressed (caller does its own summary).
async function commitInputAndFlipLabel({ task, mode, ctx, fromLabel, silent = false }) {
  const sectionsOut = {};
  for (const s of getSections()) {
    const files = await getPhotos(task.issue_number, s.id);
    sectionsOut[s.id] = {
      files: files.map(f => ({
        ref: refFromPhoto(f),
        caption: f.caption || '',
        type: f.type,
      })),
      instructions: [],
    };
  }
  const textEditsList = await getTextEdits(task.issue_number);
  const text_edits = {};
  for (const e of textEditsList) {
    if (e.field) text_edits[e.field] = e.new_value;
  }
  const skipped_sections = await getSkipped(task.issue_number);
  const notes = await getNotes(task.issue_number);

  // Attach section-scoped notes as `instructions` on each section so
  // apply-fix.mjs and the Claude Code skill see them inline with the photos.
  for (const note of notes) {
    if (note.section && sectionsOut[note.section]) {
      sectionsOut[note.section].instructions.push(note.text);
    }
  }
  // Task-wide notes (no section) preserved separately.
  const general_notes = notes.filter(n => !n.section).map(n => n.text);

  const inputJson = {
    issue_number: task.issue_number,
    slug: task.slug,
    mode,
    timestamp: new Date().toISOString(),
    sections: sectionsOut,
    text_edits,
    skipped_sections,
    general_notes,
  };

  const path = `_data/${task.slug}/visual_review_input.json`;
  const content = JSON.stringify(inputJson, null, 2);

  try {
    await putFile({
      path,
      content,
      message: `chore(${task.slug}): visual review input from TG bot (#${task.issue_number})`,
    });
  } catch (e) {
    console.error('[rebuild] putFile failed:', e.message);
    if (!silent) await ctx.reply(`❌ Не смог закоммитить input.json: ${e.message}`);
    return false;
  }

  try {
    const snippet = content.length > 8000 ? content.slice(0, 8000) + '\n…(truncated)' : content;
    await commentOnIssue(
      task.issue_number,
      `Visual review dispatched (mode: \`${mode}\`).\n\nInput:\n\`\`\`json\n${snippet}\n\`\`\``
    );
  } catch (e) {
    console.warn('[rebuild] commentOnIssue failed:', e.message);
  }

  try {
    await setLabel(task.issue_number, LABELS.AWAITING_CLAUDE_PROCESS, fromLabel);
    // Also strip the other transient label if it's still present.
    const otherLabel = fromLabel === LABELS.NEEDS_VISUAL_REVIEW
      ? LABELS.AWAITING_OWNER_REVIEW
      : LABELS.NEEDS_VISUAL_REVIEW;
    try { await setLabel(task.issue_number, LABELS.AWAITING_CLAUDE_PROCESS, otherLabel); }
    catch { /* idempotent */ }
  } catch (e) {
    console.error('[rebuild] setLabel failed:', e.message);
    if (!silent) {
      await ctx.reply(`❌ Не смог поменять лейбл: ${e.message}\n\nInput JSON закоммичен — можно поменять лейбл вручную.`);
    }
    return false;
  }
  return true;
}

function extractSlugFromIssue(issue) {
  const fromBody = issue.body?.match(/slug[:\s]+([a-z0-9-]+)/i);
  if (fromBody) return fromBody[1];
  const fromTitle = issue.title?.match(/\[([a-z0-9-]+)\]/i);
  if (fromTitle) return fromTitle[1];
  return `issue-${issue.number}`;
}

function extractVenueName(title) {
  return (title || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

// Maps a photo entry from Redis to a `<scheme>:<value>` ref understood by
// scripts/visual-review/download-refs.mjs.
function refFromPhoto(p) {
  if (p.source === 'tg_upload') return `tg:${p.file_id}`;
  if (p.source === 'url' && p.url) {
    if (p.type === 'direct_image' || p.type === 'direct_video') return `direct:${p.url}`;
    return `ig:${p.url}`;
  }
  return `unknown:${JSON.stringify(p).slice(0, 100)}`;
}

// ---- Non-command handlers (callbacks, photos, text) ---------------------

export async function handleCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  // Best-effort ack — TG требует ответ в 15s, но если id протух / mock /
  // network flake — handler НЕ должен из-за этого падать (state changes
  // важнее, чем button spinner).
  ctx.answerCallbackQuery().catch(e => {
    if (e?.message && !e.message.includes('query is too old')) {
      console.warn('[callback] answerCallbackQuery failed:', e.message);
    }
  });

  // Owner-only: approve/reject pending access request from an unknown chat.
  // Callback data shape: `access:approve:<chatId>` / `access:reject:<chatId>`.
  if (data.startsWith('access:')) {
    if (ctx.role !== 'owner') return;
    const [, action, chatIdStr] = data.split(':');
    if (!chatIdStr) return;
    const chatId = chatIdStr;
    const pending = await getPendingAccess(chatId);
    const isAlready = await isApprovedAssistant(chatId);
    if (action === 'approve') {
      if (!isAlready) await addApprovedAssistant(chatId);
      await clearPendingAccess(chatId);
      await sendMessage(chatId,
        '✅ Доступ предоставлен. Ты теперь ассистент.\n\n' +
        '/help — твои команды. /playbook — типовые сценарии.'
      ).catch((e) => console.warn('[access] notify approve failed:', e.message));
      await ctx.editMessageText(
        (ctx.callbackQuery.message?.text || ctx.callbackQuery.message?.caption || '') +
        `\n\n✅ Approved.`
      ).catch(() => {});
    } else if (action === 'reject') {
      await clearPendingAccess(chatId);
      await sendMessage(chatId,
        '❌ В доступе отказано.\n\n' +
        'Если думаешь, что это ошибка — напиши Pavel напрямую.'
      ).catch((e) => console.warn('[access] notify reject failed:', e.message));
      await ctx.editMessageText(
        (ctx.callbackQuery.message?.text || ctx.callbackQuery.message?.caption || '') +
        `\n\n❌ Rejected.`
      ).catch(() => {});
    }
    return;
  }

  if (data.startsWith('sec:')) {
    const sectionId = data.slice(4);
    const s = getSectionById(sectionId);
    if (!s) return;
    await setActiveSection(ctx.from.id, sectionId);
    await ctx.reply(
      `${s.emoji} ${s.label}\nПришли ссылку / фото / видео для этой секции (опционально — можно вообще без неё).`
    );
    return;
  }

  if (data.startsWith('task:')) {
    const issueNumber = Number(data.slice(5));
    // Check both queues — owner may tap an issue that's already
    // `awaiting-owner-review` (submitted by assistant) and not in the
    // default `needs-visual-review` list.
    const [needsReview, awaitingOwner] = await Promise.all([
      safeGetActiveTasks(LABELS.NEEDS_VISUAL_REVIEW),
      ctx.role === 'owner' ? safeGetActiveTasks(LABELS.AWAITING_OWNER_REVIEW) : Promise.resolve([]),
    ]);
    const task = [...needsReview, ...awaitingOwner].find(t => t.issue_number === issueNumber);
    if (!task) {
      await ctx.reply(`Задача #${issueNumber} не найдена в активных. Попробуй /list.`);
      return;
    }
    // Phase 1.2 — auto-claim ownership + WIP enforcement. Owner exempt.
    const claim = await claimTaskOrFail(String(ctx.from.id), task.issue_number, ctx.role);
    if (!claim.ok) {
      await ctx.reply(claim.msg, { parse_mode: 'Markdown' });
      return;
    }
    // Save as current task for this user.
    await setCurrentTask(ctx.from.id, {
      issue_number: task.issue_number,
      slug: task.slug,
      venue_name: task.venue_name,
      html_url: task.html_url,
      preview_url: task.preview_url,
      instagram: task.instagram,
    });
    // Reset active section — user must pick a section button next.
    await setActiveSection(ctx.from.id, '');
    const kb = await buildSectionKeyboard(task.issue_number);
    const lines = [
      `📋 ${task.venue_name} · #${task.issue_number}`,
      `🔗 Посмотреть результат: ${task.preview_url}`,
    ];
    if (task.instagram) {
      const handle = task.instagram.replace(/^@/, '');
      lines.push(`📸 Instagram: ${task.instagram} (https://instagram.com/${handle})`);
    }
    lines.push(`📋 Issue: ${task.html_url}`);
    lines.push('', 'Выбери секцию для загрузки фото/видео:');
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
    return;
  }

  if (data === 'mode:texts')      { await ctx.reply(STUB_M2); return; }
  if (data === 'action:done_all') { await handleDoneAll(ctx); return; }  // legacy
  if (data === 'action:cancel')   { await handleCancel(ctx); return; }

  // ✅ Готово — route by role: assistant /submit's, owner /done_all'ит solo.
  if (data === 'action:submit') {
    if (ctx.role === 'assistant') {
      await handleSubmit(ctx);
    } else {
      await handleDoneAll(ctx);
    }
    return;
  }

  // M3a — Q19/Q23: owner taps ✅ Approve in the submit push.
  if (data.startsWith('approve:')) {
    if (ctx.role !== 'owner') {
      await ctx.reply('Только owner может одобрять задачи.');
      return;
    }
    const issueNumber = Number(data.slice(8));
    if (!Number.isFinite(issueNumber)) return;
    await runApprove(ctx, issueNumber);
    return;
  }

  // M3a — Q20: owner taps 💬 Замечания. Set state, ask for the comment.
  if (data.startsWith('feedback:')) {
    if (ctx.role !== 'owner') {
      await ctx.reply('Только owner может оставлять замечания.');
      return;
    }
    const issueNumber = Number(data.slice(9));
    if (!Number.isFinite(issueNumber)) return;
    await setFeedbackPending(ctx.from.id, issueNumber);
    await ctx.reply(
      `📝 Напиши замечания одним сообщением — отправлю ассистенту и сохраню в issue #${issueNumber}.\n\n` +
      `Отмена — /cancel.`
    );
    return;
  }

  // claude_ans:{sessionId}:{key} — owner отвечает на вопрос от Claude Code.
  if (data.startsWith('claude_ans:')) {
    if (ctx.role !== 'owner') return;
    // Format: claude_ans:<sessionId>:<key> — sessionId может содержать `-` но не `:`.
    const rest = data.slice('claude_ans:'.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon < 1) return;
    const sessionId = rest.slice(0, lastColon);
    const key = rest.slice(lastColon + 1);
    const existing = await getClaudeAnswer(sessionId).catch(() => null);
    if (existing) {
      await ctx.reply(`⚠️ Уже отвечено ранее: "${existing.key}". Новый ответ "${key}" проигнорирован.`);
      return;
    }
    const q = await getClaudeQuestion(sessionId).catch(() => null);
    await setClaudeAnswer(sessionId, key, String(ctx.from?.id));
    const qText = q?.question ? truncatePreview(q.question, 100) : '(вопрос не найден в кэше)';
    await ctx.reply(
      `✅ Ответ "${key}" сохранён.\n\nClaude Code получит при следующем polling.\n\nВопрос был: "${qText}"`
    );
    return;
  }

  // bug_view:N — детальный view одного bug-репорта с media gallery.
  if (data.startsWith('bug_view:')) {
    if (ctx.role !== 'owner') return;
    const issueNumber = Number(data.slice('bug_view:'.length));
    if (!Number.isFinite(issueNumber)) return;
    let issue;
    try { issue = await getIssue(issueNumber); }
    catch (e) { await ctx.reply(`❌ Не удалось получить #${issueNumber}: ${e.message}`); return; }
    const labels = (issue.labels || []).map(l => l.name);
    const isPending = labels.includes(LABELS.BUG_PENDING);
    const isActive = labels.includes(LABELS.BUG);
    const statusLine = isPending ? '🐛 pending — ждёт review'
      : isActive ? '🔧 active — в backlog'
      : `⚠️ status: ${labels.join(', ') || 'нет'}`;
    // Parse body — extract description + file_ids.
    const body = (issue.body || '');
    const reporter = body.match(/Reported by\s+(\S+)/)?.[1] || 'unknown';
    const descMatch = body.match(/## Description\s*\n([\s\S]*?)(\n##|\n<!--|$)/);
    const description = descMatch ? descMatch[1].trim() : '(no description)';
    const fileIds = [...body.matchAll(/file_id:\s*`([^`]+)`/g)].map(m => m[1]);
    const types = [...body.matchAll(/- \d+\.\s*([📷🎥])/g)].map(m => m[1] === '🎥' ? 'video' : 'photo');

    // Send media gallery first (if any) — sendMediaGroup для 2+, sendPhoto/sendVideo для 1.
    if (fileIds.length > 0) {
      try {
        if (fileIds.length === 1) {
          const method = types[0] === 'video' ? 'replyWithVideo' : 'replyWithPhoto';
          await ctx[method](fileIds[0]);
        } else {
          const media = fileIds.map((fid, i) => ({
            type: types[i] || 'photo',
            media: fid,
          }));
          await ctx.replyWithMediaGroup(media);
        }
      } catch (e) {
        await ctx.reply(`⚠️ Не удалось загрузить media: ${e.message}`);
      }
    }

    const lines = [
      `🐛 Bug #${issueNumber} · ${statusLine}`,
      `Reporter: ${reporter}`,
      `${issue.html_url}`,
      '',
      truncatePreview(description, 800),
    ];
    const actionKb = new InlineKeyboard()
      .text('✅ Confirm', `bug_review:${issueNumber}:confirm`)
      .text('❌ Reject', `bug_review:${issueNumber}:reject`)
      .row()
      .text('🔙 К списку', `bug_review:${issueNumber}:back`);
    await ctx.reply(lines.join('\n'), { reply_markup: actionKb });
    return;
  }

  // bug_review:N:confirm|reject|back — owner action on bug.
  if (data.startsWith('bug_review:')) {
    if (ctx.role !== 'owner') return;
    const [, nStr, action] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    if (action === 'confirm') {
      try {
        // pending → bug (active). Owner direct /bug уже имеет bug — idempotent.
        await setLabel(issueNumber, LABELS.BUG, LABELS.BUG_PENDING);
        const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'owner';
        await commentOnIssue(issueNumber, `✅ **Confirmed by ${ownerName}** — added to active backlog.`)
          .catch(e => console.warn('[bug_confirm] comment failed:', e.message));
        await ctx.reply(`✅ #${issueNumber} → \`bug\` (active backlog).`, { parse_mode: 'Markdown' });
        // Push reporter — symmetric.
        const reporterId = await getAssistantChatId(issueNumber).catch(() => null);
        if (reporterId && String(reporterId) !== String(ctx.from?.id)) {
          await sendMessage(reporterId,
            `✅ Твой bug-репорт #${issueNumber} confirmed owner'ом — в backlog. Спасибо!`
          ).catch(e => console.warn('[bug_confirm] push failed:', e.message));
        }
      } catch (e) {
        await ctx.reply(`❌ confirm failed: ${e.message}`);
      }
    } else if (action === 'reject') {
      await setCommandPending(String(ctx.from?.id), 'bug_reject', { issueNumber });
      await ctx.reply(
        `❌ #${issueNumber}: напиши причину reject одной строкой — отправлю reporter'у + закрою wont-fix.\n\n` +
        `Отмена — /cancel.`
      );
    } else if (action === 'back') {
      await handleBugReview(ctx);
    }
    return;
  }

  // scout_view:N — детальный view одного лида (вызывается из inline keyboard
  // в /scout_review summary). Показывает title + status + body excerpt + кнопки.
  if (data.startsWith('scout_view:')) {
    if (ctx.role !== 'owner') return;
    const issueNumber = Number(data.slice('scout_view:'.length));
    if (!Number.isFinite(issueNumber)) return;
    let issue;
    try {
      issue = await getIssue(issueNumber);
    } catch (e) {
      await ctx.reply(`❌ Не удалось получить #${issueNumber}: ${e.message}`);
      return;
    }
    const labels = (issue.labels || []).map(l => l.name);
    const isAwaiting = labels.includes(LABELS.AWAITING_SCOUT);
    const isScouted = labels.includes(LABELS.SCOUTED);
    const statusLine = isAwaiting
      ? '📝 raw — ассистент предложил, не разведан'
      : isScouted
      ? '✅ resolved — Claude Code разведал, есть чек-лист'
      : `⚠️ статус: ${labels.join(', ') || 'нет'}`;
    // Body excerpt — first ~400 chars без metadata blocks.
    const body = (issue.body || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    const excerpt = body.length > 500 ? body.slice(0, 500) + '…' : body;
    const lines = [
      `${issue.title}`,
      `#${issueNumber} · ${statusLine}`,
      issue.html_url,
      '',
      excerpt || '(нет описания)',
    ];
    const actionKb = new InlineKeyboard()
      .text('✅ Approve', `scout_review:${issueNumber}:approve`)
      .text('❌ Reject', `scout_review:${issueNumber}:reject`)
      .row()
      .text('⏭ Skip', `scout_review:${issueNumber}:skip`)
      .text('🔙 К списку', `scout_review:${issueNumber}:back`);
    await ctx.reply(lines.join('\n'), { reply_markup: actionKb });
    return;
  }

  // Scout review actions. `scout_review:N:approve|reject|skip|open|back`.
  // Works on issues с label `awaiting-scout` ИЛИ `scouted` — approve переводит
  // → `approved`, researcher агент подхватит при /process-tg-tasks.
  if (data.startsWith('scout_review:')) {
    if (ctx.role !== 'owner') return;
    const [, nStr, action] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    if (action === 'approve') {
      // Determine current scout label to remove (awaiting-scout или scouted).
      let currentLabel = null;
      try {
        const issue = await getIssue(issueNumber);
        const labels = (issue.labels || []).map(l => l.name);
        if (labels.includes(LABELS.SCOUTED)) currentLabel = LABELS.SCOUTED;
        else if (labels.includes(LABELS.AWAITING_SCOUT)) currentLabel = LABELS.AWAITING_SCOUT;
      } catch (e) {
        console.warn('[scout_review approve] getIssue failed:', e.message);
      }
      try {
        await setLabel(issueNumber, LABELS.APPROVED, currentLabel);
        const fromHint = currentLabel === LABELS.AWAITING_SCOUT
          ? ' (raw → researcher разберётся в /process-tg-tasks)'
          : '';
        await ctx.reply(
          `✅ #${issueNumber} → \`approved\`${fromHint}.\n\n` +
          `Запусти на Mac \`/process-tg-tasks\` — researcher подхватит и пойдёт по Flow X.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        await ctx.reply(`❌ setLabel failed: ${e.message}`);
        return;
      }
      // Symmetric with reject: push assignee if it wasn't owner-init.
      let approvePushStatus = 'skipped';
      try {
        const assistantId = await getAssistantChatId(issueNumber);
        if (!assistantId) {
          approvePushStatus = 'no_chat_id';
        } else if (String(assistantId) === String(ctx.from?.id)) {
          approvePushStatus = 'skipped'; // owner-init, не пингуем самого себя
        } else {
          await commentOnIssue(issueNumber, `✅ **Approved by owner** — passed to researcher pipeline.`)
            .catch(e => console.warn('[scout_approve] commentOnIssue failed:', e.message));
          await sendMessage(assistantId,
            `✅ Твой лид #${issueNumber} апрувнут owner'ом!\n\n` +
            `Уходит в researcher → design-director → builder. ` +
            `Когда сайт соберётся, увидишь в /list для visual review.`
          );
          approvePushStatus = 'sent';
        }
      } catch (e) {
        console.warn('[scout_approve] assignee push failed:', e.message);
        approvePushStatus = 'failed';
      }
      if (approvePushStatus === 'no_chat_id') {
        await ctx.reply(`⚠️ DM ассистенту НЕ отправлен — assistantChatId не записан в Redis (заявка до 2026-05-23 fix). Сообщи вручную.`);
      } else if (approvePushStatus === 'failed') {
        await ctx.reply(`⚠️ DM ассистенту НЕ отправлен (push упал — см. vercel logs).`);
      } else if (approvePushStatus === 'sent') {
        await ctx.reply(`📨 DM ассистенту отправлен.`);
      }
    } else if (action === 'reject') {
      // Phase 1.1 — explicit reject. Ask for reason, dispatch via cmd-pending
      // so handleText picks it up next message. extras carries issueNumber.
      await setCommandPending(String(ctx.from?.id), 'scout_reject', { issueNumber });
      await ctx.reply(
        `❌ #${issueNumber}: напиши одной строкой причину reject — отправлю в issue + сообщу ассистенту.\n\n` +
        `Отмена — /cancel.`
      );
    } else if (action === 'skip') {
      await ctx.reply(`⏭ #${issueNumber} пропущен в обзоре.`);
    } else if (action === 'open') {
      // Just provide a clickable link — TG renders it.
      await ctx.reply(`https://github.com/Shebovich/business-sites/issues/${issueNumber}`);
    } else if (action === 'back') {
      // Re-render the list (как заново /scout_review).
      await handleScoutReview(ctx);
    }
    return;
  }

  // M3b — /scout queue picker. `scout_queue:take:<id>` / `scout_queue:skip:<idx>`.
  if (data.startsWith('scout_queue:')) {
    const [, action, payload] = data.split(':');
    if (action === 'take') {
      const decoded = decodeURIComponent(payload || '');
      await ctx.reply(
        `🔍 Запусти на ноуте:\n\n` +
        `  node scripts/scrape-venues.mjs --pick "${decoded}"\n\n` +
        `Или просто \`/process-tg-tasks\` — skill подтянет первый из \`_data/scout_queue.json\`.`,
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'skip') {
      await ctx.reply('⏭ Пропустили. Запусти /scout ещё раз — покажу следующий.');
    }
    return;
  }

  // M3c — Q30: pitch_review batch action. `pitch:N:pitched|revise|skip`.
  if (data.startsWith('pitch:')) {
    if (ctx.role !== 'owner') return;
    const [, nStr, action] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    if (action === 'pitched') {
      // Phase 1.3 — ask channel inline keyboard. Label transition happens
      // in pitch_channel handler once channel chosen (avoids half-state if
      // owner taps Pitched and walks away).
      const kb = new InlineKeyboard()
        .text('📸 IG', `pitch_channel:${issueNumber}:ig`)
        .text('💬 Viber', `pitch_channel:${issueNumber}:viber`)
        .text('📱 WA', `pitch_channel:${issueNumber}:wa`)
        .row()
        .text('✈️ TG', `pitch_channel:${issueNumber}:tg`)
        .text('✉️ Email', `pitch_channel:${issueNumber}:email`)
        .text('📞 Звонок', `pitch_channel:${issueNumber}:call`)
        .row()
        .text('🤷 Other', `pitch_channel:${issueNumber}:other`)
        .text('❌ Отмена', `pitch_channel:${issueNumber}:cancel`);
      await ctx.reply(`📤 #${issueNumber}: где запитчил клиенту?`, { reply_markup: kb });
    } else if (action === 'revise') {
      try {
        await setLabel(issueNumber, LABELS.NEEDS_VISUAL_REVIEW, LABELS.READY_FOR_PITCH);
        await ctx.reply(`🔄 #${issueNumber} → \`needs-visual-review\`. Сбрось Redis вручную если нужно.`,
          { parse_mode: 'Markdown' });
      } catch (e) {
        await ctx.reply(`❌ setLabel failed: ${e.message}`);
      }
    } else if (action === 'skip') {
      await ctx.reply(`⏭ #${issueNumber} пропущен в этом обзоре.`);
    }
    return;
  }

  // Phase 1.3 — pitch channel pick. `pitch_channel:N:ig|viber|wa|tg|email|call|other|cancel`.
  if (data.startsWith('pitch_channel:')) {
    if (ctx.role !== 'owner') return;
    const [, nStr, channel] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    if (channel === 'cancel') {
      await ctx.reply(`Отменено — #${issueNumber} остаётся \`ready-for-pitch\`.`,
        { parse_mode: 'Markdown' });
      return;
    }
    const labelMap = {
      ig: 'Instagram DM', viber: 'Viber', wa: 'WhatsApp',
      tg: 'Telegram', email: 'Email', call: 'Звонок', other: 'Other',
    };
    const channelLabel = labelMap[channel] || channel;
    try {
      await setPitchInfo(issueNumber, { channel });
      await setLabel(issueNumber, LABELS.PITCHED, LABELS.READY_FOR_PITCH);
      await commentOnIssue(issueNumber,
        `📤 **Pitched via ${channelLabel}** at ${new Date().toISOString().slice(0, 10)}.`
      ).catch(e => console.warn('[pitch_channel] commentOnIssue failed:', e.message));
      await ctx.reply(
        `✅ #${issueNumber} → \`pitched\` (${channelLabel}).\n\n` +
        `Напомню через 3/7/14 дней. После 21d — предложу пометить как \`ghosted\`.\n` +
        `Когда ответят — /sold или /lost.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      await ctx.reply(`❌ pitch update failed: ${e.message}`);
    }
    return;
  }

  // Phase 3.4 — owner picks A/B variant из design-director moodboard.
  // `design_pick:N:A|B|preview`. Preview шлёт contact-sheet.png из репо.
  // A/B — коммент в issue + label design-pending → design-approved,
  // process-tg-tasks skill подхватит и triggers builder Mode skeleton.
  if (data.startsWith('design_pick:')) {
    if (ctx.role !== 'owner') return;
    const [, nStr, action] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    if (action === 'preview') {
      // Try to send moodboard contact-sheet from main repo raw.
      // Bot не знает slug заранее — берём из issue body (slug: ...).
      const issue = await getIssue(issueNumber).catch(() => null);
      const slugMatch = issue?.body?.match(/^\s*slug:\s*([a-z0-9-]+)/im);
      const slug = slugMatch?.[1];
      if (!slug) {
        await ctx.reply(`⚠️ Не нашёл slug в #${issueNumber} body. Открой issue: ${issue?.html_url || '?'}`);
        return;
      }
      const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/_data/${slug}/moodboard/contact-sheet.png`;
      await ctx.replyWithPhoto(url, {
        caption: `🖼 Moodboard #${issueNumber} (${slug}). Выбери A или B из дизайн-брифа.`,
      }).catch(async (e) => {
        await ctx.reply(`⚠️ Moodboard не доступен (${e.message}). URL: ${url}`);
      });
      return;
    }
    if (action !== 'A' && action !== 'B') return;
    const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'owner';
    try {
      await commentOnIssue(issueNumber,
        `🎨 **Variant ${action} picked by ${ownerName}.**\n\n` +
        `Builder Mode skeleton возьмёт chosen variant из design_brief.md ` +
        `(secondary variant аннулируется).`
      );
      await setLabel(issueNumber, LABELS.DESIGN_APPROVED, LABELS.DESIGN_PENDING);
      await ctx.reply(
        `✅ #${issueNumber}: вариант ${action} → \`design-approved\`. ` +
        `Builder Mode skeleton сейчас подхватит.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      await ctx.reply(`❌ design_pick failed: ${e.message}`);
    }
    return;
  }

  // Phase 3.5 — done_review:N:approve|revise. Parallel-authority: и owner и
  // assignee могут tap. Approve → ready-for-pitch, revise → needs-visual-review.
  if (data.startsWith('done_review:')) {
    const [, nStr, action] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    // Allow if owner, assignee, or person registered как assistant для issue.
    const chatId = String(ctx.from?.id);
    const assignee = await getTaskAssignee(issueNumber).catch(() => null);
    const igAssignee = await getAssistantChatId(issueNumber).catch(() => null);
    const authorized = ctx.role === 'owner' || assignee === chatId || igAssignee === chatId;
    if (!authorized) {
      await ctx.reply('Эту задачу могут закрыть только owner или assignee.');
      return;
    }
    const who = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || chatId);
    if (action === 'approve') {
      try {
        await setLabel(issueNumber, LABELS.READY_FOR_PITCH, LABELS.BUILT);
        await commentOnIssue(issueNumber,
          `✅ **Approved as done by ${who}** — moved to \`ready-for-pitch\`.`
        ).catch(() => {});
        await ctx.reply(
          `🎉 #${issueNumber} → \`ready-for-pitch\`. /pitch_review когда готов запитчить.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        await ctx.reply(`❌ done_review approve failed: ${e.message}`);
      }
    } else if (action === 'revise') {
      try {
        await setLabel(issueNumber, LABELS.NEEDS_VISUAL_REVIEW, LABELS.BUILT);
        await commentOnIssue(issueNumber,
          `🔄 **Sent back for revision by ${who}** — back to \`needs-visual-review\`.`
        ).catch(() => {});
        await ctx.reply(
          `🔄 #${issueNumber} → \`needs-visual-review\`. /list → выбери задачу и добавь правки.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        await ctx.reply(`❌ done_review revise failed: ${e.message}`);
      }
    }
    return;
  }

  // M3a — Q22: lazy gallery. `gallery:N` = whole task; `gallery:N:section` = scoped.
  if (data.startsWith('gallery:')) {
    const rest = data.slice(8);
    const [nStr, sectionId] = rest.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    await runGallery(ctx, issueNumber, sectionId || null);
    return;
  }
}

// Q22: pull photos from Redis, send as TG sendMediaGroup batches. If
// `sectionFilter` is set, scope to just that section (used by /preview).
async function runGallery(ctx, issueNumber, sectionFilter) {
  const state = await collectSubmitState(issueNumber);
  const scoped = sectionFilter
    ? { sections: { [sectionFilter]: state.sections[sectionFilter] || [] }, textEdits: [], skipped: [] }
    : state;
  const { batches, placeholders } = buildGalleryBatches(scoped);
  if (batches.length === 0 && placeholders.length === 0) {
    await ctx.reply(sectionFilter
      ? `В секции \`${sectionFilter}\` пока ничего нет.`
      : `Для #${issueNumber} пока ничего не загружено.`,
      { parse_mode: 'Markdown' });
    return;
  }
  for (const batch of batches) {
    try {
      // Use grammy's ctx methods rather than raw tgApi — grammy handles
      // TG quirks (param encoding, retry-after) more gracefully and was
      // observed to succeed where raw fetch returned 404 for sendPhoto.
      if (batch.length === 1) {
        const item = batch[0];
        if (item.type === 'video') {
          await ctx.replyWithVideo(item.media, { caption: item.caption });
        } else {
          await ctx.replyWithPhoto(item.media, { caption: item.caption });
        }
      } else {
        await ctx.replyWithMediaGroup(batch);
      }
    } catch (e) {
      console.warn('[gallery] media send failed:', e.message);
      console.warn('[gallery] batch payload:', JSON.stringify(batch));
      console.warn('[gallery] chat.id:', ctx.chat?.id, 'type:', ctx.chat?.type);
      await ctx.reply(`⚠️ Не смог отправить часть медиа: ${e.message}`);
    }
  }
  if (placeholders.length > 0) {
    const lines = ['🔗 Ссылки (TG не может превьюшнуть, ждут rebuild):'];
    lines.push(...placeholders.map(p => `• ${p}`));
    await ctx.reply(lines.join('\n'));
  }
}

// Q20: owner sent feedback text after tapping [💬 Замечания].
// Posts as GitHub issue comment (audit trail), pushes to assistant, rolls
// label back to `needs-visual-review` so the task reappears in assistant's /list.
async function runFeedback(ctx, issueNumber, text) {
  await clearFeedbackPending(ctx.from.id);
  if (!text || text.trim().length < 3) {
    await ctx.reply('Замечание слишком короткое. Отправь повторно — /preview сначала.');
    return;
  }

  const round = await getRound(issueNumber);
  const ownerName = ctx.from?.username ? `@${ctx.from.username}` : 'owner';

  try {
    await commentOnIssue(issueNumber,
      `**Owner feedback (round ${round || 1}) from ${ownerName}:**\n\n${text}`
    );
  } catch (e) {
    console.warn('[feedback] commentOnIssue failed:', e.message);
  }

  try {
    await setLabel(issueNumber, LABELS.NEEDS_VISUAL_REVIEW, LABELS.AWAITING_OWNER_REVIEW);
  } catch (e) {
    console.error('[feedback] setLabel rollback failed:', e.message);
    await ctx.reply(`⚠️ Не смог откатить лейбл: ${e.message}. Коммент оставлен, передай ассистенту вручную.`);
    return;
  }

  try {
    const assistantId = await getAssistantChatId(issueNumber);
    if (assistantId) {
      await sendMessage(assistantId,
        `💬 ${ownerName} оставил замечания по #${issueNumber} (раунд ${round || 1}):\n\n${text}\n\n` +
        `Внеси правки и снова /submit. Issue: ` +
        `https://github.com/Shebovich/business-sites/issues/${issueNumber}`
      );
    } else {
      console.warn(`[feedback] no assistant_chat_id for issue ${issueNumber}`);
    }
  } catch (e) {
    console.warn('[feedback] assistant push failed:', e.message);
  }

  await ctx.reply(`✅ Замечания отправлены ассистенту, лейбл откатил на \`needs-visual-review\`.`,
    { parse_mode: 'Markdown' });
}

export async function handlePhoto(ctx) {
  // /bug session priority — appending media to bug draft instead of section upload.
  const bugSession = await getBugSession(ctx.from.id).catch(() => null);
  if (bugSession) {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const caption = (ctx.message.caption || '').trim();
    const ok = await appendBugMedia(ctx.from.id, {
      type: 'photo',
      file_id: largest.file_id,
      caption,
    });
    if (ok) {
      const count = (bugSession.media?.length || 0) + 1;
      const captionLine = caption
        ? `\n📝 Caption принят как описание: "${truncatePreview(caption, 80)}"`
        : '';
      await ctx.reply(`🐛 Фото добавлено в bug-репорт (${count}/10).${captionLine}\n\n/done — отправить.`);
    } else {
      await ctx.reply(`⚠️ Лимит 10 медиа. /done — отправить, /cancel — начать заново.`);
    }
    return;
  }

  const task = await getCurrentTask(ctx.from.id);
  const sectionId = await getActiveSection(ctx.from.id);
  if (!task || !sectionId) {
    await ctx.reply('Сначала открой задачу (/current) и выбери секцию.');
    return;
  }
  // Largest photo size = last element.
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  await persistTgUpload({
    issueNumber: task.issue_number,
    section: sectionId,
    fileId: largest.file_id,
    kind: 'photo',
    caption: ctx.message.caption || '',
  });
  await ctx.reply(`📷 Фото добавлено в секцию ${sectionId}.`);
}

export async function handleVideo(ctx) {
  // /bug session priority.
  const bugSession = await getBugSession(ctx.from.id).catch(() => null);
  if (bugSession) {
    const caption = (ctx.message.caption || '').trim();
    const ok = await appendBugMedia(ctx.from.id, {
      type: 'video',
      file_id: ctx.message.video.file_id,
      caption,
    });
    if (ok) {
      const count = (bugSession.media?.length || 0) + 1;
      const captionLine = caption
        ? `\n📝 Caption принят как описание: "${truncatePreview(caption, 80)}"`
        : '';
      await ctx.reply(`🐛 Видео добавлено в bug-репорт (${count}/10).${captionLine}\n\n/done — отправить.`);
    } else {
      await ctx.reply(`⚠️ Лимит 10 медиа. /done — отправить, /cancel — начать заново.`);
    }
    return;
  }

  const task = await getCurrentTask(ctx.from.id);
  const sectionId = await getActiveSection(ctx.from.id);
  if (!task || !sectionId) {
    await ctx.reply('Сначала открой задачу (/current) и выбери секцию.');
    return;
  }
  await persistTgUpload({
    issueNumber: task.issue_number,
    section: sectionId,
    fileId: ctx.message.video.file_id,
    kind: 'video',
    caption: ctx.message.caption || '',
  });
  await ctx.reply(`🎬 Видео добавлено в секцию ${sectionId}.`);
}

export async function handleText(ctx) {
  const text = (ctx.message?.text || '').trim();
  if (!text) return;

  // Conversational flow: if a previous /command set a pending input
  // request, route this text as input for that command. Cleared after
  // dispatch so the next text falls through to normal routing.
  const pending = await getCommandPending(ctx.from.id).catch(() => null);
  if (pending) {
    await clearCommandPending(ctx.from.id);
    switch (pending.command) {
      case 'scout':    await processScoutInput(ctx, text);   return;
      case 'note':     await processNoteInput(ctx, text);    return;
      case 'sold':     await processSoldInput(ctx, text);    return;
      case 'lost':     await processLostInput(ctx, text);    return;
      case 'ghosted':  await processGhostedInput(ctx, text); return;
      case 'approve':  await processApproveInput(ctx, text); return;
      case 'scout_reject':
        await processScoutRejectInput(ctx, text, Number(pending.extras?.issueNumber));
        return;
      case 'scout_comment':
        await processScoutCommentInput(ctx, text, Number(pending.extras?.issueNumber));
        return;
      case 'bug_reject':
        await processBugRejectInput(ctx, text, Number(pending.extras?.issueNumber));
        return;
      default: break; // unknown pending → fall through
    }
  }

  // /bug session priority — appending text to bug draft instead of normal routing.
  const bugSession = await getBugSession(ctx.from.id).catch(() => null);
  if (bugSession) {
    await appendBugText(ctx.from.id, text);
    await ctx.reply(
      `🐛 Добавил текст к bug-репорту. Сейчас: ${bugSession.media?.length || 0} медиа, описание ` +
      `${(bugSession.description?.length || 0) + text.length} символов.\n\n/done — отправить. /cancel — отменить.`
    );
    return;
  }

  // M3a — Q20: owner is responding to a [💬 Замечания] prompt. Takes
  // precedence over normal routing.
  if (ctx.role === 'owner') {
    const pendingIssue = await getFeedbackPending(ctx.from.id);
    if (pendingIssue) {
      await runFeedback(ctx, Number(pendingIssue), text);
      return;
    }
  }

  const task = await getCurrentTask(ctx.from.id);
  const sectionId = await getActiveSection(ctx.from.id);

  if (!task) {
    await ctx.reply('Открой задачу через /list — тогда я сохраню текст как заметку.');
    return;
  }

  // URL + caption: save the URL as photo input AND the caption as a note so
  // assistant's intent isn't lost ("вот фото меню, поставь его 1-м").
  const { url, caption } = splitUrlAndCaption(text);
  if (url) {
    if (!sectionId) {
      // URL без секции — сохраняем весь текст как общую заметку, не теряем.
      await addNote(task.issue_number, null, text);
      await ctx.reply(
        `📝 Заметка сохранена без привязки к секции.\n\n` +
        `Чтобы привязать к секции — /current → тапни секцию → пришли URL ещё раз.`
      );
      return;
    }
    const res = await persistUrlInput({
      issueNumber: task.issue_number,
      section: sectionId,
      url,
      caption,
    });
    if (res.ok) {
      const replyParts = [`🔗 ${res.type} сохранён в секции ${sectionId}.`];
      if (caption && caption.length >= 3) {
        await addNote(task.issue_number, sectionId, caption);
        replyParts.push(`📝 Инструкция: «${truncatePreview(caption)}»`);
      }
      await ctx.reply(replyParts.join('\n'));
    } else {
      // URL не распознался — но текст ценный, сохраняем как заметку целиком.
      await addNote(task.issue_number, sectionId, text);
      await ctx.reply(
        `📝 URL формат непривычный, сохранил весь текст как заметку к ${sectionId}.\n\n` +
        `Поддерживаются автоматически: IG post/reel/highlights, прямые image/video URL.`
      );
    }
    return;
  }

  // Free-form text → note. Save to current section if one is active,
  // otherwise as task-wide note.
  await addNote(task.issue_number, sectionId || null, text);
  const where = sectionId ? `к секции ${sectionId}` : 'к задаче (общая)';
  await ctx.reply(`📝 Заметка добавлена ${where}: «${truncatePreview(text)}»`);
}

function truncatePreview(s, limit = 100) {
  if (!s) return '';
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}

// ---- Safety wrappers ----------------------------------------------------

// GitHub is the source of truth — Redis only caches in-flight user state
// (active section, uploaded photos per task). For the task list, always
// read fresh from GitHub Issues API so labels changed via gh CLI / webhooks
// outside the bot are picked up immediately.
async function safeGetActiveTasks(label = LABELS.NEEDS_VISUAL_REVIEW) {
  try {
    const issues = await listIssuesByLabel(label);
    return issues.map(parseTaskFromIssue);
  } catch (e) {
    console.error('[bot] listIssuesByLabel failed:', e.message);
    return [];
  }
}

// Issue → task object. Extracts slug, venue_name, preview_url, instagram from
// the bot-metadata block (preferred) and falls back to title/body parsing for
// legacy issues.
//
// Bot metadata block format (prepended by scripts/bot/backfill-issue-meta.mjs):
//   <!-- bot-metadata-v1 -->
//   slug: skif
//   preview: https://skif.vercel.app
//   instagram: @skifcafe  (https://instagram.com/skifcafe)
//   <!-- /bot-metadata-v1 -->
function parseTaskFromIssue(i) {
  const body = i.body || '';

  // Slug: body `slug:` line, but NOT pseudo-slugs that match label tokens
  // OR placeholder markers like `scout-request`/`bug`.
  const RESERVED_SLUGS = new Set([
    'scouted', 'scout', 'scout-request',
    'needs', 'needs-fix', 'needs-visual-review',
    'ready', 'ready-for-pitch',
    'awaiting', 'awaiting-scout', 'awaiting-claude-process', 'awaiting-owner-review',
    'building', 'built',
    'design-pending', 'design-approved', 'design-ready',
    'pitched', 'sold', 'lost', 'ghosted', 'wont-do',
    'bug', 'bug-pending', 'bug-fixed', 'wont-fix',
    'archived', 'rejected', 'bot-test',
  ]);
  let slug = null;
  const bodySlugMatch = body.match(/^\s*slug:\s*([a-z0-9-]+)/im);
  if (bodySlugMatch && !RESERVED_SLUGS.has(bodySlugMatch[1].toLowerCase())) {
    slug = bodySlugMatch[1];
  }
  if (!slug) {
    // Legacy fallback — `[<slug>]` prefix in title. Reject reserved tokens
    // so `[scouted] Skif` doesn't yield slug="scouted".
    const titleMatch = i.title?.match(/\[([a-z0-9-]+)\]/i);
    if (titleMatch && !RESERVED_SLUGS.has(titleMatch[1].toLowerCase())) {
      slug = titleMatch[1];
    }
  }
  if (!slug) {
    // IG handle fallback (e.g. `IG @mana_minsk` → `mana-minsk`).
    const igHandle = body.match(/IG (?:handle:\s*)?@?([a-z0-9_.]+)/i);
    if (igHandle) {
      slug = igHandle[1].toLowerCase().replace(/[_.]+/g, '-').replace(/^-|-$/g, '');
    }
  }
  if (!slug) slug = `issue-${i.number}`;

  // Preview URL: explicit `preview:` line OR default `https://{slug}.vercel.app`.
  const previewMatch = body.match(/^\s*preview:\s*(https?:\/\/\S+)/im);
  const preview_url = previewMatch ? previewMatch[1] : `https://${slug}.vercel.app`;

  // Instagram handle: `instagram:` line OR `**Instagram:**` markdown.
  let instagram = null;
  const igMatch = body.match(/^\s*instagram:\s*(@?[A-Za-z0-9_.]+)/im)
    || body.match(/\*\*Instagram:\*\*\s*(@?[A-Za-z0-9_.]+)/i);
  if (igMatch) instagram = igMatch[1].startsWith('@') ? igMatch[1] : `@${igMatch[1]}`;

  // Venue name — strip "[label]" prefix and trailing "(description)".
  const venueName = (i.title || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();

  return {
    issue_number: i.number,
    title: i.title,
    venue_name: venueName || i.title,
    slug,
    preview_url,
    instagram,
    html_url: i.html_url,
  };
}
