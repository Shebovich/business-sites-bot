#!/usr/bin/env node
// Local dev runner — uses long polling instead of webhook so you can test
// without deploying. Mirrors the wiring in api/bot/webhook.mjs.
//
// Usage:
//   # load .env into PowerShell first, then:
//   npm run bot:dev

import { Bot } from 'grammy';
import {
  handleStart, handleHelp, handleList, handleCurrent,
  handleSkip, handleCancel, handleDoneAll, handleAutoPhotos,
  handleSubmit, handleOwnerReview,
  handleApprove, handlePreview, handleRm, handleUnskip,
  handleWhoami, handlePlaybook,
  handlePitchReview, handleSold, handleLost, handleGhosted,
  handleScout, handleScoutReview,
  handleCallback, handlePhoto, handleVideo, handleText,
} from './lib/commands.mjs';
import { assertEnv } from './config.mjs';

assertEnv();

const bot = new Bot(process.env.TG_BOT_TOKEN);

bot.use(async (ctx, next) => {
  const ownerId = String(process.env.TG_OWNER_CHAT_ID || '');
  if (!ownerId || String(ctx.from?.id) !== ownerId) {
    console.warn('[bot:dev] ignoring update from non-owner', ctx.from?.id);
    return;
  }
  ctx.role = 'owner';
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

bot.on('callback_query', handleCallback);
bot.on('message:photo',  handlePhoto);
bot.on('message:video',  handleVideo);
bot.on('message:text',   handleText);

bot.catch((err) => console.error('[bot:dev] unhandled:', err));

console.log('[bot:dev] starting long polling...');
await bot.start({
  onStart: (info) => console.log(`[bot:dev] @${info.username} ready`),
  drop_pending_updates: true,
});
