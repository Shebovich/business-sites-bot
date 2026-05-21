#!/usr/bin/env node
// One-shot: prepend bot-readable metadata block to issues #8-#17 so the
// visual-review bot can extract slug + preview URL + Instagram handle.
//
// Run once: node scripts/bot/backfill-issue-meta.mjs

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}
for (const f of ['.env', '.env.local']) loadEnvFile(resolve(process.cwd(), f));

const REPO = 'Shebovich/business-sites';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GH_TOKEN not set — `node scripts/bot/pull-env.mjs` first.');
  process.exit(1);
}

// issue # → { slug, vercel_url, instagram, twoGis }
const ISSUES = {
  8:  { slug: 'benedict-bistro',     vercel: 'benedict-bistro',     ig: '@benedict.minsk'  },
  9:  { slug: 'mon-nom',             vercel: 'mon-nom',             ig: '@monnombar'       },
  10: { slug: 'legendar',            vercel: 'legendar-one',        ig: '@legendar_minsk'  },
  11: { slug: 'traktir-na-parkovoj', vercel: 'traktir-na-parkovoj', ig: '@traktir.minsk'   },
  12: { slug: 'skif',                vercel: 'skif',                ig: '@skifcafe'        },
  13: { slug: 'storis',              vercel: 'storis-inky',         ig: '@stories_minsk'   },
  14: { slug: 'lidbeer-legenda',     vercel: 'lidbeer-legenda',     ig: '@lidbeerlegenda'  },
  15: { slug: 'berezka',             vercel: 'berezka',             ig: '@berezka_minsk'   },
  16: { slug: 'zharynka',            vercel: 'zharynka',            ig: '@zharynka_cafe'   },
  17: { slug: 'jerry',               vercel: 'jerry-alpha-one',     ig: '@jerry.shotbar'   },
};

const META_HEADER = '<!-- bot-metadata-v1 -->';

function buildMetaBlock({ slug, vercel, ig }) {
  const handle = ig.replace(/^@/, '');
  return [
    META_HEADER,
    `slug: ${slug}`,
    `preview: https://${vercel}.vercel.app`,
    `instagram: ${ig}  (https://instagram.com/${handle})`,
    '<!-- /bot-metadata-v1 -->',
    '',
  ].join('\n');
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path}: ${res.status} ${text}`);
  }
  return res.json();
}

for (const [num, meta] of Object.entries(ISSUES)) {
  const issue = await gh(`/repos/${REPO}/issues/${num}`);
  let body = issue.body || '';

  // Strip any prior metadata block so re-runs are idempotent.
  const blockRe = /<!-- bot-metadata-v1 -->[\s\S]*?<!-- \/bot-metadata-v1 -->\n*/;
  body = body.replace(blockRe, '');

  const newBody = buildMetaBlock(meta) + body;

  await gh(`/repos/${REPO}/issues/${num}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: newBody }),
  });
  console.log(`#${num} ${meta.slug} → metadata block prepended (preview: https://${meta.vercel}.vercel.app)`);
}

console.log('\n✅ Done. Bot will now resolve slug + preview + Instagram from issue body.');
