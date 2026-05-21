// Command handlers for the visual-review TG bot.
// M1: /start, /help, /list are real. Other commands stub a friendly "M2 coming"
// reply so the bot doesn't appear broken before the rest of the milestones land.

import { getCurrentTask, setActiveSection, getActiveSection,
         skipSection, clearCurrentTask, getPhotos, getTextEdits, getSkipped } from './state.mjs';
import { buildTaskListKeyboard, buildSectionKeyboard } from './keyboard.mjs';
import { SECTIONS, SECTION_BY_ID, LABELS } from '../config.mjs';
import { persistUrlInput, persistTgUpload } from './photo-handler.mjs';
import { splitUrlAndCaption, parseTextEdit } from './text-parser.mjs';
import { listIssuesByLabel, putFile, dispatchWorkflow, commentOnIssue } from './github-api.mjs';

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
  const text = [
    'Команды:',
    '/start — приветствие + статус',
    '/list — все активные задачи (needs-visual-review)',
    '/current — текущая открытая задача с inline-клавиатурой',
    '/skip <section> — пропустить секцию (M2)',
    '/cancel — выйти из текущей задачи без сохранения (M2)',
    '/done_all — финализировать и запустить builder-fix (M2)',
    '/auto_photos — auto-curation fallback Q14/Q15 (M2)',
    '/help — это сообщение',
    '',
    'В контексте секции: пришли IG-ссылку / фото / видео / текстовую инструкцию.',
  ].join('\n');
  await ctx.reply(text);
}

export async function handleList(ctx) {
  const tasks = await safeGetActiveTasks();
  if (tasks.length === 0) {
    await ctx.reply('Нет активных задач. Жду лейбла `needs-visual-review`.');
    return;
  }
  const kb = buildTaskListKeyboard(tasks);
  await ctx.reply(`Активных задач: ${tasks.length}`, { reply_markup: kb });
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

// ---- M2: /done_all + /auto_photos ---------------------------------------

export async function handleDoneAll(ctx) {
  await runRebuild(ctx, { mode: 'manual' });
}

export async function handleAutoPhotos(ctx) {
  await runRebuild(ctx, { mode: 'auto' });
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

  // Step 3: trigger workflow.
  try {
    await dispatchWorkflow({
      workflow: 'visual-review.yml',
      ref: 'main',
      inputs: {
        issue_number: String(task.issue_number),
        slug: task.slug,
      },
    });
  } catch (e) {
    console.error('[done_all] dispatchWorkflow failed:', e.message);
    await ctx.reply(`❌ Workflow dispatch failed: ${e.message}\n\nInput JSON всё равно закоммичен — можно запустить вручную через Actions tab.`);
    return;
  }

  // Step 4: clear active section but keep photo lists in case Actions fails
  // and user wants to re-trigger.
  await setActiveSection(ctx.from.id, '');

  await ctx.reply(
    [
      `✅ Workflow visual-review.yml запущен.`,
      ``,
      `Проверь логи: https://github.com/Shebovich/business-sites/actions/workflows/visual-review.yml`,
      ``,
      `Когда сборка закончится — GitHub-webhook пришлёт сюда уведомление с лейблом \`built\`.`,
    ].join('\n')
  );
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
    // Selected a task from /list — M2 wires it as current. Stub for M1.
    await ctx.reply('Выбор задачи из /list появится в M2.');
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
async function safeGetActiveTasks() {
  try {
    const issues = await listIssuesByLabel(LABELS.NEEDS_VISUAL_REVIEW);
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
