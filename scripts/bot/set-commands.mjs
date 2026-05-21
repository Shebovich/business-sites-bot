#!/usr/bin/env node
// One-shot: register bot command list with Telegram via setMyCommands.
// This populates the autocomplete menu when user types `/` in chat.
//
// Run after adding new commands:
//   node scripts/bot/set-commands.mjs
//
// Owner sees owner-scoped commands (via setMyCommands with scope=chat),
// assistants see assistant-scoped commands. We push both lists.

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

const TOKEN = process.env.TG_BOT_TOKEN;
const OWNER_ID = process.env.TG_OWNER_CHAT_ID;
const ASSISTANT_IDS = (process.env.TG_ASSISTANT_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TOKEN) { console.error('TG_BOT_TOKEN not set'); process.exit(1); }

// Default list (visible to anyone not in a per-chat scope).
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
  { command: 'unskip',   description: 'Отменить skip секции' },
  { command: 'rm',       description: 'Удалить N-ое фото из секции' },
  { command: 'cancel',   description: 'Сбросить текущую задачу' },
  { command: 'whoami',   description: 'Моя роль + chat_id' },
  { command: 'playbook', description: 'Типовые сценарии для роли' },
];

const ASSISTANT_COMMANDS = [
  ...COMMON_COMMANDS,
  { command: 'submit',   description: 'Передать задачу owner на ревью' },
  { command: 'scout',    description: 'Предложить лид (2GIS/IG/имя)' },
];

const OWNER_COMMANDS = [
  ...COMMON_COMMANDS,
  { command: 'done_all',     description: 'Собрать сайт (solo, GH Actions автозапуск)' },
  { command: 'auto_photos',  description: 'Q14/Q15 auto-curation fallback' },
  { command: 'owner_review', description: 'Submit\'ы ассистентов на ревью' },
  { command: 'approve',      description: 'Одобрить submit → GH Actions rebuild' },
  { command: 'approve_all',  description: 'Batch-approve всех + автосборка' },
  { command: 'pitch_review', description: 'Батч-ревью готовых сайтов' },
  { command: 'sold',         description: 'N [notes] — продано' },
  { command: 'lost',         description: 'N [reason] — не сложилось' },
  { command: 'ghosted',      description: 'N — клиент молчит' },
  { command: 'scout',        description: 'Следующий лид или ad-hoc' },
  { command: 'scout_review', description: 'Inbox новых scouted' },
];

async function setMyCommands(commands, scope) {
  const url = `https://api.telegram.org/bot${TOKEN}/setMyCommands`;
  const body = scope ? { commands, scope } : { commands };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`setMyCommands: ${json.description || res.status}`);
  return json;
}

// 1. Default (shown to non-whitelisted lurkers — basic commands)
await setMyCommands(COMMON_COMMANDS, { type: 'default' });
console.log(`✓ Default scope: ${COMMON_COMMANDS.length} commands`);

// 2. Owner — per-chat scope
if (OWNER_ID) {
  await setMyCommands(OWNER_COMMANDS, { type: 'chat', chat_id: Number(OWNER_ID) });
  console.log(`✓ Owner scope (${OWNER_ID}): ${OWNER_COMMANDS.length} commands`);
}

// 3. Each assistant — per-chat scope
for (const id of ASSISTANT_IDS) {
  await setMyCommands(ASSISTANT_COMMANDS, { type: 'chat', chat_id: Number(id) });
  console.log(`✓ Assistant scope (${id}): ${ASSISTANT_COMMANDS.length} commands`);
}

console.log('\n✅ Done. Restart your TG client (close + reopen chat) to see the updated menu.');
