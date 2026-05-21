// Command handlers for the visual-review TG bot.
// M1: /start, /help, /list are real. Other commands stub a friendly "M2 coming"
// reply so the bot doesn't appear broken before the rest of the milestones land.

import { getCurrentTask, setCurrentTask, setActiveSection, getActiveSection,
         skipSection, clearCurrentTask, getPhotos, getTextEdits, getSkipped } from './state.mjs';
import { buildTaskListKeyboard, buildSectionKeyboard } from './keyboard.mjs';
import { SECTIONS, SECTION_BY_ID, LABELS } from '../config.mjs';
import { persistUrlInput, persistTgUpload } from './photo-handler.mjs';
import { splitUrlAndCaption, parseTextEdit } from './text-parser.mjs';
// Note: `dispatchWorkflow` kept imported as a dormant fallback (Q18.1).
// If we revert from Claude Code executor to GH Actions, restore the call in
// runRebuild() step 3 — no other changes needed.
// eslint-disable-next-line no-unused-vars
import { listIssuesByLabel, putFile, dispatchWorkflow, commentOnIssue, setLabel } from './github-api.mjs';

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
  const isOwner = ctx.role === 'owner';
  const lines = [
    'Команды:',
    '/start — приветствие + статус',
    '/list — все активные задачи',
    '/current — текущая открытая задача с inline-клавиатурой',
    '/skip <section> — пропустить секцию',
    '/cancel — выйти из текущей задачи без сохранения',
  ];
  if (isOwner) {
    lines.push(
      '/done_all — финализировать → коммит input.json + label awaiting-claude-process (owner)',
      '/auto_photos — auto-curation fallback Q14/Q15 (owner)',
      '/owner_review — очередь задач от ассистентов (owner)',
    );
  } else {
    lines.push(
      '/submit — передать задачу owner на ревью',
    );
  }
  lines.push(
    '/help — это сообщение',
    '',
    'В контексте секции: пришли IG-ссылку / фото / видео / текстовую инструкцию.',
  );
  await ctx.reply(lines.join('\n'));
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
  await ctx.reply(
    `📋 #${task.issue_number} ${task.slug}\nPreview: ${task.preview_url || '(будет после первого деплоя)'}`,
    { reply_markup: kb }
  );
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
// Owner gets a push via the existing GitHub webhook → TG bridge when the
// label flips to `awaiting-owner-review`.
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
  try {
    await setLabel(task.issue_number, LABELS.AWAITING_OWNER_REVIEW, LABELS.NEEDS_VISUAL_REVIEW);
  } catch (e) {
    console.error('[submit] setLabel failed:', e.message);
    await ctx.reply(`❌ Не смог поменять лейбл: ${e.message}`);
    return;
  }
  try {
    const who = ctx.from?.username ? `@${ctx.from.username}` : `assistant ${ctx.from?.id}`;
    await commentOnIssue(task.issue_number, `${who} submitted for review (via TG bot).`);
  } catch (e) {
    console.warn('[submit] commentOnIssue failed:', e.message);
  }
  await ctx.reply('✅ Задача передана. Owner получит уведомление.');
}

// Shared dispatcher — collects state, commits input JSON, fires workflow.
async function runRebuild(ctx, { mode }) {
  const task = await getCurrentTask(ctx.from.id);
  if (!task) {
    await ctx.reply('Нет текущей задачи. Открой /list и выбери одну.');
    return;
  }

  const friendly = mode === 'auto' ? 'auto-curation (Q14/Q15)' : 'manual visual review';
  await ctx.reply(`Запускаю rebuild (${friendly}) для #${task.issue_number} \`${task.slug}\`...`, { parse_mode: 'Markdown' });

  // Aggregate state across all sections.
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

  const inputJson = {
    issue_number: task.issue_number,
    slug: task.slug,
    mode,                       // 'manual' | 'auto'
    timestamp: new Date().toISOString(),
    sections: sectionsOut,
    text_edits,
    skipped_sections,
  };

  const path = `_data/${task.slug}/visual_review_input.json`;
  const content = JSON.stringify(inputJson, null, 2);

  // Step 1: commit input.json to repo.
  try {
    await putFile({
      path,
      content,
      message: `chore(${task.slug}): visual review input from TG bot (#${task.issue_number})`,
    });
  } catch (e) {
    console.error('[done_all] putFile failed:', e.message);
    await ctx.reply(`❌ Не смог закоммитить input.json: ${e.message}`);
    return;
  }

  // Step 2: comment snapshot on issue (truncate huge payloads).
  try {
    const snippet = content.length > 8000 ? content.slice(0, 8000) + '\n…(truncated)' : content;
    await commentOnIssue(
      task.issue_number,
      `Visual review dispatched (mode: \`${mode}\`).\n\nInput:\n\`\`\`json\n${snippet}\n\`\`\``
    );
  } catch (e) {
    console.warn('[done_all] commentOnIssue failed:', e.message);
  }

  // Step 3 (M2.5 — Q18.1 pivot): mark issue as ready for Claude Code processing.
  // GitHub Actions workflow `visual-review.yml` remains as a dormant fallback
  // (`dispatchWorkflow` import preserved) — to revert, restore the dispatch
  // call here and remove the setLabel call below.
  try {
    // Source label may be either NEEDS_VISUAL_REVIEW (owner direct) or
    // AWAITING_OWNER_REVIEW (after assistant /submit). Try both.
    await setLabel(task.issue_number, LABELS.AWAITING_CLAUDE_PROCESS, LABELS.NEEDS_VISUAL_REVIEW);
    // Best-effort: also strip AWAITING_OWNER_REVIEW if present.
    try { await setLabel(task.issue_number, LABELS.AWAITING_CLAUDE_PROCESS, LABELS.AWAITING_OWNER_REVIEW); }
    catch { /* idempotent — label may already be removed */ }
  } catch (e) {
    console.error('[done_all] setLabel failed:', e.message);
    await ctx.reply(`❌ Не смог поменять лейбл: ${e.message}\n\nInput JSON закоммичен — можно поменять лейбл вручную.`);
    return;
  }

  // Step 4: clear active section but keep photo lists in case Claude Code
  // run fails and we want to re-trigger.
  await setActiveSection(ctx.from.id, '');

  await ctx.reply([
    `✅ Input закоммичен, label обновлён на \`awaiting-claude-process\`.`,
    ``,
    `Открой Claude Code на компе и напиши:`,
    `  /process-tg-tasks`,
    ``,
    `Claude применит изменения локально, задеплоит, поставит \`built\`.`,
  ].join('\n'), { parse_mode: 'Markdown' });
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
      preview_url: `https://${task.slug}.vercel.app`,
    });
    // Reset active section — user must pick a section button next.
    await setActiveSection(ctx.from.id, '');
    const kb = await buildSectionKeyboard(task.issue_number);
    await ctx.reply(
      `📋 ${task.venue_name} · #${task.issue_number}\nPreview: https://${task.slug}.vercel.app\nIssue: ${task.html_url}\n\nВыбери секцию:`,
      { reply_markup: kb }
    );
    return;
  }

  if (data === 'mode:texts')      { await ctx.reply(STUB_M2); return; }
  if (data === 'action:done_all') { await handleDoneAll(ctx); return; }
  if (data === 'action:cancel')   { await handleCancel(ctx); return; }
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
  const text = ctx.message?.text || '';
  const task = await getCurrentTask(ctx.from.id);
  const sectionId = await getActiveSection(ctx.from.id);

  // Try URL first.
  const { url, caption } = splitUrlAndCaption(text);
  if (url) {
    if (!task || !sectionId) {
      await ctx.reply('URL принят, но нет активной секции. /current → выбери секцию.');
      return;
    }
    const res = await persistUrlInput({
      issueNumber: task.issue_number,
      section: sectionId,
      url,
      caption,
    });
    if (res.ok) {
      await ctx.reply(`🔗 ${res.type} сохранён в секции ${sectionId}.`);
    } else {
      await ctx.reply(`URL не распознан (${res.reason}). Поддерживаются IG post/reel/highlights и прямые image/video URL.`);
    }
    return;
  }

  // Text-edit instruction?
  const edit = parseTextEdit(text);
  if (edit) {
    await ctx.reply(STUB_M2);
    return;
  }

  await ctx.reply('Не распознал. Пришли IG-ссылку, фото/видео или используй /help.');
}

// ---- Safety wrappers ----------------------------------------------------

// GitHub is the source of truth — Redis only caches in-flight user state
// (active section, uploaded photos per task). For the task list, always
// read fresh from GitHub Issues API so labels changed via gh CLI / webhooks
// outside the bot are picked up immediately.
async function safeGetActiveTasks(label = LABELS.NEEDS_VISUAL_REVIEW) {
  try {
    const issues = await listIssuesByLabel(label);
    return issues.map(i => {
      // Slug — machine name (e.g. "skif"). Looks for body field first, then title.
      const slugMatch = i.body?.match(/slug[:\s]+([a-z0-9-]+)/i)
        ?? i.title?.match(/\[([a-z0-9-]+)\]/i);
      // Venue name — strip "[label]" prefix and trailing "(description)".
      // Title pattern observed: "[scouted] Jerry (шот-бар, Хмельницкого)" → "Jerry"
      const venueName = i.title
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim();
      return {
        issue_number: i.number,
        title: i.title,
        venue_name: venueName || i.title,
        slug: slugMatch?.[1] || `issue-${i.number}`,
        html_url: i.html_url,
      };
    });
  } catch (e) {
    console.error('[bot] listIssuesByLabel failed:', e.message);
    return [];
  }
}
