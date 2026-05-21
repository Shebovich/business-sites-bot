// Vercel serverless function — TG webhook entrypoint.
// See Q16.4: Vercel webhook + GitHub Actions split.

import { Bot, webhookCallback } from 'grammy';
import {
  handleStart, handleHelp, handleList, handleCurrent,
  handleSkip, handleCancel, handleDoneAll, handleAutoPhotos,
  handleSubmit, handleOwnerReview,
  handleApprove, handlePreview, handleRm, handleUnskip,
  handleWhoami, handlePlaybook,
  handlePitchReview, handleSold, handleLost, handleGhosted,
  handleScout, handleScoutReview,
  handleCallback, handlePhoto, handleVideo, handleText,
} from '../../scripts/bot/lib/commands.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';
import { sendMessage } from '../../scripts/bot/lib/tg-api.mjs';

export const config = { api: { bodyParser: false } };

// Onboarding ping de-dup. In-memory only — survives between warm invocations
// on the same lambda instance, resets on cold start. Worst case: owner sees
// the same new chat_id pinged twice. Acceptable.
const onboardingPinged = new Set();

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

  bot.use(async (ctx, next) => {
    const fromId = String(ctx.from?.id ?? '');
    if (OWNER_ID && fromId === OWNER_ID) {
      ctx.role = 'owner';
    } else if (ASSISTANT_IDS.includes(fromId)) {
      ctx.role = 'assistant';
    } else {
      // M3c — Q29 onboarding: instead of silently ignoring, tell the user
      // their chat_id so they can forward it to owner. Also push owner with
      // the access request. Throttle is best-effort via in-memory set (cold
      // start resets it — that's fine, owner won't see duplicates often).
      try {
        const username = ctx.from?.username ? `@${ctx.from.username}` : '(no username)';
        await ctx.reply(
          `👋 Привет. Я бот ревью сайтов Shebovich.\n\n` +
          `Твой chat_id: \`${fromId}\`\n\n` +
          `Перешли этот id Pavel — он добавит тебя в whitelist. Я тебя пока игнорю.`,
          { parse_mode: 'Markdown' }
        );
        if (OWNER_ID && !onboardingPinged.has(fromId)) {
          onboardingPinged.add(fromId);
          await sendMessage(OWNER_ID,
            `🔔 Новый chat_id хочет доступ:\n• ${username}\n• id \`${fromId}\`\n\n` +
            `Добавь в \`TG_ASSISTANT_CHAT_IDS\` через Vercel env, потом redeploy.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      } catch (e) {
        console.warn(`[bot] onboarding reply failed for ${fromId}:`, e.message);
      }
      return;
    }
    await next();
  });

  bot.command('start',        handleStart);
  bot.command('help',         handleHelp);
  bot.command('list',         handleList);
  bot.command('current',      handleCurrent);
  bot.command('skip',         handleSkip);
  bot.command('unskip',       handleUnskip);
  bot.command('preview',      handlePreview);
  bot.command('rm',           handleRm);
  bot.command('cancel',       handleCancel);
  bot.command('done_all',     handleDoneAll);
  bot.command('auto_photos',  handleAutoPhotos);
  bot.command('submit',       handleSubmit);
  bot.command('owner_review', handleOwnerReview);
  bot.command('approve',      handleApprove);
  bot.command('whoami',       handleWhoami);
  bot.command('playbook',     handlePlaybook);
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
