#!/usr/bin/env node
// Pulls production env vars from Vercel into `.env.local` and copies to `.env`
// for use by local Claude Code skill runs (process-tg-tasks).
//
// Run once before invoking the skill, and again whenever env vars change in
// Vercel (e.g. new TG_ASSISTANT_CHAT_IDS).
//
// CLI: node scripts/bot/pull-env.mjs

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', '..');
const ENV_LOCAL = resolve(ROOT, '.env.local');
const ENV       = resolve(ROOT, '.env');

console.log('[pull-env] Pulling production env vars from Vercel...');
try {
  execSync('vercel env pull .env.local --environment=production --yes', {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (e) {
  console.error('[pull-env] vercel env pull failed:', e.message);
  console.error('Hint: make sure you are logged in (`vercel login`) and the project is linked.');
  exit(1);
}

if (!existsSync(ENV_LOCAL)) {
  console.error('[pull-env] .env.local was not created — check vercel output above.');
  exit(1);
}

// Copy/refresh .env so anything reading the canonical name picks it up.
// We overwrite on every pull — .env is a derived file in this project.
copyFileSync(ENV_LOCAL, ENV);

const size = statSync(ENV).size;
console.log(`[pull-env] OK — .env.local + .env refreshed (${size} bytes).`);
console.log('[pull-env] You can now run: /process-tg-tasks');
