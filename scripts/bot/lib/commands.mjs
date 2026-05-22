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
         getRoleOverride, setRoleOverride, clearRoleOverride, getRoleOverrideTtl } from './state.mjs';
import { buildTaskListKeyboard, buildSectionKeyboard,
         buildOwnerPushKeyboard, buildPreviewKeyboard } from './keyboard.mjs';
import { SECTIONS, SECTION_BY_ID, LABELS, getEnv } from '../config.mjs';
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
    // No args — pull next item from queue.
    await pullNextFromQueue(ctx);
    return;
  }

  // Ad-hoc input — parse + create issue.
  const parsed = parseScoutInput(arg);
  if (parsed.kind === 'empty' || parsed.kind === 'unknown_url') {
    await ctx.reply(
      `Не понял input. Поддерживаю:\n` +
      `• 2GIS URL\n• Google/Yandex Maps URL\n• Instagram URL или @handle\n` +
      `• Свой сайт заведения (URL)\n• Просто название\n\n` +
      `Пример: /scout https://2gis.by/minsk/firm/70000001234567890`
    );
    return;
  }
  const requesterName = ctx.from?.username ? `@${ctx.from.username}` : `id:${ctx.from?.id}`;
  const issuePayload = buildScoutIssue({ parsed, requesterName, requesterRole: ctx.role });
  try {
    const created = await createIssue(issuePayload);
    await ctx.reply(
      `🔍 Заявка на скаут принята #${created.number}.\n\n` +
      `Запусти на ноуте \`/process-tg-tasks\` — skill сверит, что это, и предложит к approve.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('[scout] createIssue failed:', e.message);
    await ctx.reply(`❌ Не смог создать issue: ${e.message}`);
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
    await ctx.reply(
      `Очередь пустая или недоступна (${e.message}).\n\n` +
      `Запусти на ноуте \`node scripts/scrape-venues.mjs --commit\` — это сгенерит \`_data/scout_queue.json\`.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  if (!Array.isArray(queue) || queue.length === 0) {
    await ctx.reply('Очередь пуста. /scout refresh для пополнения.');
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

// M3b — Q27: scout review inbox.
export async function handleScoutReview(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может approve лиды. Ассистент — /scout {input} чтобы предложить.');
    return;
  }
  const tasks = await safeGetActiveTasks(LABELS.SCOUTED);
  if (tasks.length === 0) {
    await ctx.reply('Нет лидов на approve. Когда scout-агент поставит `scouted`, появятся здесь.');
    return;
  }
  await ctx.reply(`🔍 Лидов на approve: ${tasks.length}`);
  for (const t of tasks) {
    const name = t.venue_name || t.slug || `issue-${t.issue_number}`;
    const kb = new InlineKeyboard()
      .text('✅ Approve и начать', `scout_review:${t.issue_number}:approve`)
      .text('⏭ Skip', `scout_review:${t.issue_number}:skip`)
      .row()
      .text('👁 Открыть issue', `scout_review:${t.issue_number}:open`);
    await ctx.reply(`${name} · #${t.issue_number}\n${t.html_url}`, { reply_markup: kb });
  }
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
  const { issueNumber, rest } = parseLifecycleArg(ctx.match);
  if (!issueNumber) {
    await ctx.reply('Использование: /sold <issue_number> [optional notes]');
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
  const { issueNumber, rest } = parseLifecycleArg(ctx.match);
  if (!issueNumber) {
    await ctx.reply('Использование: /lost <issue_number> [optional reason]');
    return;
  }
  await markLost(ctx, issueNumber, rest || 'no reason given');
}

export async function handleGhosted(ctx) {
  if (ctx.role !== 'owner') {
    await ctx.reply('Только owner может отмечать ghosted.');
    return;
  }
  const arg = ctx.match?.trim();
  const issueNumber = Number((arg || '').replace(/^#/, ''));
  if (!Number.isFinite(issueNumber)) {
    await ctx.reply('Использование: /ghosted <issue_number>');
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
  if (!arg || !SECTION_BY_ID[arg]) {
    await ctx.reply('Использование: /skip <section_id>. Список секций — /current.');
    return;
  }
  await skipSection(task.issue_number, arg);
  await ctx.reply(`Секция ${arg} помечена как skipped.`);
}

export async function handleCancel(ctx) {
  await clearCurrentTask(ctx.from.id);
  await clearFeedbackPending(ctx.from.id);
  await ctx.reply('Текущая задача сброшена.');
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
  // Source: callback `approve:N` (already routed via handleCallback) or
  // command `/approve N`. When called from a command, ctx.match holds the arg.
  const arg = ctx.match?.trim();
  let issueNumber;
  if (arg) {
    issueNumber = Number(arg.replace(/^#/, ''));
    if (!Number.isFinite(issueNumber)) {
      await ctx.reply('Использование: /approve <issue_number>. Или тапни ✅ Approve в push-сообщении.');
      return;
    }
  } else {
    // No arg → use current task (less common path; usually owner taps button).
    const task = await getCurrentTask(ctx.from.id);
    if (!task) {
      await ctx.reply('Использование: /approve <issue_number>. Или тапни ✅ Approve в push-сообщении.');
      return;
    }
    issueNumber = task.issue_number;
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
  const sectionsWithPhotos = SECTIONS
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
  if (!SECTION_BY_ID[sectionId]) {
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
    await ctx.reply('Использование: /note &lt;твой текст&gt;\n\nПример: /note приоритет hero и menu, остальное по возможности', { parse_mode: 'HTML' });
    return;
  }
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
  if (!arg || !SECTION_BY_ID[arg]) {
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
  for (const s of SECTIONS) {
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
  await ctx.answerCallbackQuery();

  if (data.startsWith('sec:')) {
    const sectionId = data.slice(4);
    if (!SECTION_BY_ID[sectionId]) return;
    await setActiveSection(ctx.from.id, sectionId);
    const s = SECTION_BY_ID[sectionId];
    await ctx.reply(
      `${s.emoji} ${s.label}\nПришли ссылку / фото / видео для этой секции.\nМинимум: ${s.min_count}.`
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

  // M3b — Q27: scout_review actions. `scout_review:N:approve|skip|open`.
  if (data.startsWith('scout_review:')) {
    if (ctx.role !== 'owner') return;
    const [, nStr, action] = data.split(':');
    const issueNumber = Number(nStr);
    if (!Number.isFinite(issueNumber)) return;
    if (action === 'approve') {
      try {
        await setLabel(issueNumber, LABELS.NEEDS_VISUAL_REVIEW, LABELS.SCOUTED);
        await ctx.reply(
          `✅ #${issueNumber} approved → \`needs-visual-review\`. Появится в /list.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        await ctx.reply(`❌ setLabel failed: ${e.message}`);
      }
    } else if (action === 'skip') {
      await ctx.reply(`⏭ #${issueNumber} пропущен в обзоре.`);
    } else if (action === 'open') {
      // Just provide a clickable link — TG renders it.
      await ctx.reply(`https://github.com/Shebovich/business-sites/issues/${issueNumber}`);
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
      try {
        await setLabel(issueNumber, LABELS.PITCHED, LABELS.READY_FOR_PITCH);
        await ctx.reply(`✅ #${issueNumber} → \`pitched\`. Ждём ответа клиента — потом /sold или /lost.`,
          { parse_mode: 'Markdown' });
      } catch (e) {
        await ctx.reply(`❌ setLabel failed: ${e.message}`);
      }
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

  // Slug: body `slug:` line, but NOT pseudo-slugs that match label tokens.
  const RESERVED_SLUGS = new Set([
    'scouted', 'needs', 'ready', 'awaiting', 'built', 'building',
    'pitched', 'sold', 'lost', 'archived', 'rejected',
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
