#!/usr/bin/env node
// leads-cli.mjs — тест + ops для пула лидов (Ф1).
// Запуск с кредами: node --env-file=.env.local scripts/leads-cli.mjs --test
//   --test                       самотест против реального Upstash (ниша __test__, с очисткой)
//   --seed <path.json> --niche X  залить лиды из adlib-JSON в пул
//   --stats [niche]              статистика пула
//   --list-owner <id>            лиды ассистента

import { readFileSync } from 'node:fs';
import { argv } from 'node:process';
import * as L from './bot/lib/leads.mjs';
import { getRedis } from './bot/lib/state.mjs';

const args = Object.fromEntries(argv.slice(2).reduce((a, c, i, arr) => { if (c.startsWith('--')) a.push([c.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return a; }, []));
const r = getRedis();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ FAIL: ${msg}`); } };

async function cleanupTest() {
  const handles = ['__t_alpha', '__t_beta', '__t_gamma'];
  for (const h of handles) { await r.del(`lead:${h}`); await r.srem('leads:all', h); }
  await r.del('leads:pool:__test__');
  await r.del('leads:owner:u1'); await r.del('leads:owner:u2');
  await r.zrem('leads:reoffer', 'u1::__t_beta');
}

async function selfTest() {
  console.log('=== САМОТЕСТ пула лидов (ниша __test__) ===');
  await cleanupTest();
  const test = [
    { handle: '__t_alpha', name: 'Alpha', niche: '__test__', kind: 'fb', profile_url: 'https://x/alpha' },
    { handle: '__t_beta', name: 'Beta', niche: '__test__' },
    { handle: '__t_gamma', name: 'Gamma', niche: '__test__' },
  ];
  const s1 = await L.seedLeads(test);
  ok(s1.added === 3 && s1.dup === 0, `seed 3 новых (added=${s1.added}, dup=${s1.dup})`);
  const s2 = await L.seedLeads(test);
  ok(s2.added === 0 && s2.dup === 3, `повторный seed → дедуп (dup=${s2.dup})`);
  ok((await L.poolStats('__test__')).available === 3, 'в пуле 3 доступных');

  const offered = await L.offerNext('__test__', 'u1');
  ok(offered && offered.niche === '__test__', `offerNext вернул лида (${offered?.handle})`);

  const t1 = await L.takeLead('u1', '__t_alpha');
  ok(t1.ok && t1.lead.owner === 'u1' && t1.lead.status === 'taken', 'takeLead u1 → закреплён');
  const t2 = await L.takeLead('u2', '__t_alpha');
  ok(!t2.ok && t2.error === 'already_taken', `🔒 АТОМАРНОСТЬ: второй захват отклонён (${t2.error}, by=${t2.by})`);
  ok((await L.poolStats('__test__')).available === 2, 'после take в пуле 2');

  const sk = await L.skipLead('u1', '__t_beta');
  ok(sk.ok && sk.reoffer_at > Date.now(), 'skipLead → парковка с reoffer_at');
  ok((await L.poolStats('__test__')).available === 1, 'после skip в пуле 1');
  ok((await L.getLead('__t_beta')).status === 'skipped', 'beta статус skipped');

  const rj = await L.rejectLead('u1', '__t_gamma', 'не та ниша');
  ok(rj.ok, 'rejectLead ok');
  ok((await L.poolStats('__test__')).available === 0, 'после reject пул пуст');
  ok((await L.getLead('__t_gamma')).reject_reason === 'не та ниша', 'причина reject сохранена');

  const st = await L.setStatus('__t_alpha', 'contacted', 'u1');
  ok(st.ok && st.lead.status === 'contacted', 'setStatus → contacted');
  const byOwner = await L.listByOwner('u1');
  ok(byOwner.length === 1 && byOwner[0].handle === '__t_alpha', `listByOwner u1 → [${byOwner.map(x => x.handle).join(',')}]`);

  await cleanupTest();
  ok((await L.getLead('__t_alpha')) === null, 'очистка теста ok');

  console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
  process.exit(fail ? 1 : 0);
}

async function seed() {
  const path = args.seed;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const niche = args.niche || data.query || 'misc';
  const list = (data.leads || []).map(l => ({ handle: l.handle, name: l.name, kind: l.kind, profile_url: l.profile_url, niche, source: 'adlib' }));
  const res = await L.seedLeads(list);
  console.log(`seed «${niche}»: ${res.added} новых, ${res.dup} дублей, ${res.err} ошибок (из ${res.total})`);
  console.log('пул ниши:', await L.poolStats(niche));
}

if (args.test) await selfTest();
else if (args.seed) { await seed(); process.exit(0); }
else if (args.stats !== undefined) { console.log(await L.poolStats(typeof args.stats === 'string' ? args.stats : null)); process.exit(0); }
else if (args['list-owner']) { console.log(await L.listByOwner(args['list-owner'])); process.exit(0); }
else { console.log('Usage: node --env-file=.env.local scripts/leads-cli.mjs --test | --seed <json> --niche X | --stats [niche] | --list-owner <id>'); process.exit(1); }
