// Vercel serverless function — TG webhook entrypoint.
// See Q16.4: Vercel webhook + GitHub Actions split.

import { Bot, webhookCallback } from 'grammy';
import {
  handleStart, handleHelp, handleList, handleCurrent,
  handleSkip, handleCancel, handleDoneAll, handleAutoPhotos,
  handleSubmit, handleOwnerReview,
  handleCallback, handlePhoto, handleVideo, handleText,
} from '../../scripts/bot/lib/commands.mjs';
import { assertEnv, getEnv } from '../../scripts/bot/config.mjs';

export const config = { api: { bodyParser: false } };

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
      console.warn(`[bot] ignoring update from non-whitelisted ${fromId}`);
      return; // silently ignore
    }
    await next();
  });

  bot.command('start',        handleStart);
  bot.command('help',         handleHelp);
  bot.command('list',         handleList);
  bot.command('current',      handleCurrent);
  bot.command('skip',         handleSkip);
  bot.command('cancel',       handleCancel);
  bot.command('done_all',     handleDoneAll);
  bot.command('auto_photos',  handleAutoPhotos);
  bot.command('submit',       handleSubmit);
  bot.command('owner_review', handleOwnerReview);

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
