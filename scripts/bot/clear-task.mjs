#!/usr/bin/env node
// Clears all Redis state for a given issue number.
// Used by the `process-tg-tasks` Claude Code skill after a successful run
// so re-triggering a fresh visual-review session for the same slug starts clean.
//
// CLI: node scripts/bot/clear-task.mjs --issue <number>

import { argv, exit } from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (avoid adding dotenv dep). Only reads KEY=VALUE lines,
// ignores comments + blank lines. Doesn't override existing process.env vars.
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  const txt = readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}
for (const f of ['.env', '.env.local']) loadEnvFile(resolve(process.cwd(), f));

const args = Object.fromEntries(
  argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const ISSUE = args.issue;
if (!ISSUE) {
  console.error('Usage: clear-task.mjs --issue <number>');
  exit(1);
}

const { getRedis } = await import('./lib/state.mjs');

const r = getRedis();
const prefix = `task:${ISSUE}:`;

// Upstash Redis supports SCAN; pull keys in batches.
// Mirror the exception list from lib/state.mjs clearTaskState — preserve
// `assistant_chat_id` (routing info, not session data; bot needs it to push
// post-build notifications to the original submitter).
const PRESERVED_SUFFIXES = [':assistant_chat_id'];
let cursor = 0;
const allKeys = [];
do {
  const [next, batch] = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
  cursor = Number(next);
  for (const k of batch) {
    if (PRESERVED_SUFFIXES.some(suffix => k.endsWith(suffix))) continue;
    allKeys.push(k);
  }
} while (cursor !== 0);

if (allKeys.length === 0) {
  console.log(`No Redis keys found for task:${ISSUE}:*`);
  exit(0);
}

// Also remove from active list set.
await r.srem('task:list:active', String(ISSUE));

// Delete keys (Upstash REST supports variadic del).
await r.del(...allKeys);

console.log(`Cleared ${allKeys.length} keys for issue #${ISSUE}:`);
for (const k of allKeys) console.log(`  - ${k}`);
