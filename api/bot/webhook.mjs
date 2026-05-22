// Vercel serverless function — TG webhook entrypoint.
// See Q16.4: Vercel webhook + GitHub Actions split.

import { Bot, webhookCallback } from 'grammy';
import {
  handleStart, handleHelp, handleList, handleCurrent,
  handleSkip, handleCancel, handleDoneAll, handleAutoPhotos,
  handleSubmit, handleOwnerReview,
  handleApprove, handleApproveAll, handlePreview, handleRm, handleUnskip,
  handleNote, handleNotes, handleRmNote, handleClearNotes,
  handleWhoami, handlePlaybook, handleRole,
  handlePitchReview, handleSold, handleLost, handleGhosted,
  handleScout, handleScoutReview,
  handleCallback, handlePhoto, handleVideo, handleText,
} from '../../scripts/bot/lib/commands.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';
import { sendMessage } from '../../scripts/bot/lib/tg-api.mjs';
import { getRoleOverride, isApprovedAssistant,
         setPendingAccess, getPendingAccess } from '../../scripts/bot/lib/state.mjs';
import { InlineKeyboard } from 'grammy';

export const config = { api: { bodyParser: false } };

// Onboarding ping de-dup. In-memory only — survives between warm invocations
// on the same lambda instance, resets on cold start. Worst case: owner sees
// the same new chat_id pinged twice. Acceptable.
const onboardingPinged = new Set();

// setMyCommands is called once per cold-start so the TG slash-menu reflects
// our current command list. Fire-and-forget — failures are non-fatal.
let commandsRegistered = false;

const COMMON_COMMANDS = [
  { command: 'start',    description: 'Привет + статус' },
  { command: 'help',     description: 'Команды (/help <команда> — детали)' },
  { command: 'list',     description: 'Активные задачи' },
  { command: 'current',  description: 'Текущая задача + секции' },
  { command: 'preview',  description: 'Что собрано в задаче' },
  { command: 'note',     description: 'Заметка к задаче' },
  { command: 'notes',    description: 'Список заметок' },
  { command: 'rm_note',  description: 'Удалить заметку N' },
  { command: 'clear_notes', description: 'Очистить все заметки' },
  { command: 'skip',     description: 'Пропустить секцию' },
  { command: 'unskip',   description: 'Отменить skip' },
  { command: 'rm',       description: 'Удалить N-ое фото из секции' },
  { command: 'cancel',   description: 'Сбросить текущую задачу' },
  { command: 'whoami',   description: 'Моя роль + chat_id' },
  { command: 'playbook', description: 'Типовые сценарии для роли' },
];

const ASSISTANT_COMMANDS = [
  ...COMMON_COMMANDS,
  { command: 'submit',  description: 'Передать задачу owner на ревью' },
  { command: 'scout',   description: 'Предложить лид (2GIS/IG/имя)' },
];

const OWNER_COMMANDS = [
  ...COMMON_COMMANDS,
  { command: 'done_all',     description: 'Собрать сайт (solo, автозапуск Actions)' },
  { command: 'auto_photos',  description: 'Q14/Q15 auto-curation fallback' },
  { command: 'owner_review', description: 'Submit\'ы ассистентов на ревью' },
  { command: 'approve',      description: 'Одобрить submit → Actions rebuild' },
  { command: 'approve_all',  description: 'Batch-approve всех + автосборка' },
  { command: 'pitch_review', description: 'Батч-ревью готовых сайтов' },
  { command: 'sold',         description: 'N [notes] — продано' },
  { command: 'lost',         description: 'N [reason] — не сложилось' },
  { command: 'ghosted',      description: 'N — клиент молчит' },
  { command: 'scout',        description: 'Следующий лид или ad-hoc' },
  { command: 'scout_review', description: 'Inbox новых scouted' },
  { command: 'role',         description: 'Debug: смена эффективной роли (30 мин)' },
];

async function registerCommandsOnce(token, ownerId, assistantIds) {
  if (commandsRegistered) return;
  commandsRegistered = true;
  const call = (body) => fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ ok: false, description: e.message }));

  // Defer to event loop so first webhook request returns fast.
  setTimeout(async () => {
    try {
      await call({ commands: COMMON_COMMANDS, scope: { type: 'default' } });
      if (ownerId) {
        await call({ commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: Number(ownerId) } });
      }
      for (const id of assistantIds) {
        await call({ commands: ASSISTANT_COMMANDS, scope: { type: 'chat', chat_id: Number(id) } });
      }
      console.log('[bot] setMyCommands registered for owner + assistants');
    } catch (e) {
      console.warn('[bot] setMyCommands failed (non-fatal):', e.message);
    }
  }, 100);
}

// Fail fast at module load if env is misconfigured. On Vercel this produces
// a clear log entry instead of a cryptic runtime crash.
let bot;
function getBot() {
  if (bot) return bot;
  assertEnv();
  // botInfo skips the getMe() call on cold start (which fails in some
  // Vercel regions due to network egress quirks).
  bot = new Bot(getEnv('TG_BOT_TOKEN'), {
    botInfo: {
      id: 8230491925,
      is_bot: true,
      first_name: 'Shebovich-sites-agent',
      username: 'ShebovichSitesBot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  });

  // Multi-user whitelist with roles (M2.5 — updated Q16.5).
  // OWNER = Pavel (full access). ASSISTANTS = comma-separated chat_ids in env;
  // can collect input but cannot finalise — must /submit for owner review.
  const OWNER_ID = getEnv('TG_OWNER_CHAT_ID') || '';
  const ASSISTANT_IDS = (getEnv('TG_ASSISTANT_CHAT_IDS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Fire-and-forget: refresh TG slash-menu on cold start.
  registerCommandsOnce(getEnv('TG_BOT_TOKEN'), OWNER_ID, ASSISTANT_IDS);

  bot.use(async (ctx, next) => {
    const fromId = String(ctx.from?.id ?? '');

    // Resolve real role. Owner is fixed in env (single owner by design).
    // Assistants come from env (boot seed) plus a Redis overlay populated by
    // owner-driven /approve callbacks — change without redeploy.
    let realRole;
    if (OWNER_ID && fromId === OWNER_ID) {
      realRole = 'owner';
    } else if (ASSISTANT_IDS.includes(fromId)) {
      realRole = 'assistant';
    } else {
      let isDynamicAssistant = false;
      try { isDynamicAssistant = await isApprovedAssistant(fromId); }
      catch (e) { console.warn('[bot] isApprovedAssistant check failed:', e.message); }
      realRole = isDynamicAssistant ? 'assistant' : 'unknown';
    }

    // Debug override (owner-only feature, see /role command). Only owners may
    // downgrade their effective role for testing — escalation is impossible.
    let effectiveRole = realRole;
    if (realRole === 'owner') {
      try {
        const override = await getRoleOverride(fromId);
        if (override && override !== 'owner') effectiveRole = override;
      } catch (e) {
        console.warn(`[bot] role-override lookup failed for ${fromId}:`, e.message);
      }
    }
    ctx.role = effectiveRole;
    ctx.realRole = realRole;

    if (effectiveRole !== 'unknown') {
      await next();
      return;
    }

    // Escape hatch: a real owner stuck in their own /role unknown override
    // would otherwise be locked out of /role reset (middleware never calls
    // next() for unknown role). Always allow /role through for the real
    // owner so they can clear the override.
    const msgText = ctx.message?.text || ctx.update?.message?.text || '';
    if (realRole === 'owner' && /^\/role(\s|$|@)/.test(msgText)) {
      await next();
      return;
    }

    // Onboarding flow for unknown chats. Hybrid throttle: pending state in
    // Redis (survives cold start, has TTL) plus in-memory set (fast path,
    // avoids Redis roundtrip on hot requests from a known-pending chat).
    try {
      const username = ctx.from?.username ? `@${ctx.from.username}` : '';
      const firstName = ctx.from?.first_name || '';
      const overrideNote = realRole === 'owner'
        ? '\n\n<i>(role override active — /role reset чтобы вернуться в owner)</i>'
        : '';

      // If we already have a pending request from this chat, reply with a
      // soft reminder instead of re-pinging owner.
      const pending = realRole !== 'owner' ? await getPendingAccess(fromId).catch(() => null) : null;
      if (pending) {
        await ctx.reply(
          `🕓 Твой запрос на рассмотрении у owner'а. Дождись решения — оно прилетит сюда.${overrideNote}`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      await ctx.reply(
        `👋 Привет. Я бот ревью сайтов Shebovich.\n\n` +
        `Твой chat_id: <code>${fromId}</code>\n\n` +
        `🕓 Запрос отправлен owner'у. Жди ответа — он прилетит сюда.${overrideNote}`,
        { parse_mode: 'HTML' }
      );

      // Skip owner-ping when we're just simulating unknown via override —
      // owner is the same person who triggered it.
      if (OWNER_ID && realRole !== 'owner' && !onboardingPinged.has(fromId)) {
        onboardingPinged.add(fromId);
        await setPendingAccess(fromId, { username, first_name: firstName }).catch(() => {});

        const safe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const displayName = username ? safe(username) : (firstName ? safe(firstName) : '(no username)');
        const kb = new InlineKeyboard()
          .text('✅ Approve', `access:approve:${fromId}`)
          .text('❌ Reject', `access:reject:${fromId}`);
        await sendMessage(OWNER_ID,
          `🔔 Запрос доступа:\n• ${displayName}\n• id <code>${fromId}</code>\n\n` +
          `Тапни кнопку, бот сам ответит требующему.`,
          { parse_mode: 'HTML', reply_markup: kb }
        ).catch((e) => console.warn('[bot] owner access-ping failed:', e.message));
      }
    } catch (e) {
      console.warn(`[bot] onboarding reply failed for ${fromId}:`, e.message);
    }
  });

  bot.command('start',        handleStart);
  bot.command('help',         handleHelp);
  bot.command('list',         handleList);
  bot.command('current',      handleCurrent);
  bot.command('skip',         handleSkip);
  bot.command('unskip',       handleUnskip);
  bot.command('preview',      handlePreview);
  bot.command('rm',           handleRm);
  bot.command('note',         handleNote);
  bot.command('notes',        handleNotes);
  bot.command('rm_note',      handleRmNote);
  bot.command('clear_notes',  handleClearNotes);
  bot.command('cancel',       handleCancel);
  bot.command('done_all',     handleDoneAll);
  bot.command('auto_photos',  handleAutoPhotos);
  bot.command('submit',       handleSubmit);
  bot.command('owner_review', handleOwnerReview);
  bot.command('approve',      handleApprove);
  bot.command('approve_all',  handleApproveAll);
  bot.command('whoami',       handleWhoami);
  bot.command('playbook',     handlePlaybook);
  bot.command('role',         handleRole);
  bot.command('pitch_review', handlePitchReview);
  bot.command('sold',         handleSold);
  bot.command('lost',         handleLost);
  bot.command('ghosted',      handleGhosted);
  bot.command('scout',        handleScout);
  bot.command('scout_review', handleScoutReview);

  bot.on('callback_query',   handleCallback);
  bot.on('message:photo',    handlePhoto);
  bot.on('message:video',    handleVideo);
  bot.on('message:text',     handleText);

  // Last-resort error catch — keeps webhook returning 200 to TG so updates
  // aren't infinitely retried while we debug.
  bot.catch((err) => {
    console.error('[bot] unhandled error:', err);
  });

  return bot;
}

const handler = async (req, res) => {
  try {
    const cb = webhookCallback(getBot(), 'http');
    return cb(req, res);
  } catch (e) {
    console.error('[bot] webhook init failed:', e.message);
    res.statusCode = 500;
    res.end('bot init error');
  }
};

export default handler;
