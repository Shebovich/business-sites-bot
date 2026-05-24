// Vercel serverless function — receives GitHub webhook events.
// M1: signature verification + label-change detection. Sends a TG ping to
// TG_OWNER_CHAT_ID when an issue gets labeled `needs-visual-review`.
// M2: also handle `built` / `ready-for-pitch` for status updates.

import crypto from 'node:crypto';
import { LABELS, getEnv } from '../scripts/bot/config.mjs';
import { sendMessage } from '../scripts/bot/lib/tg-api.mjs';
import { registerActiveTask, getTaskAssignee, getAssistantChatId,
         getCcHeartbeat, markCcOfflineNotified, wasCcOfflineNotified } from '../scripts/bot/lib/state.mjs';
import { InlineKeyboard } from 'grammy';

// Wave 2 W3 — labels требующие активной CC сессии (locked §24.11 Решение 2 + 3).
// При получении webhook на эти labels: check heartbeat; stale → push owner "CC offline".
// CC fresh → не делаем доп. notify (CC reactive Monitor подхватит сам, M2 discipline).
const CC_REQUIRED_LABELS = new Set([
  LABELS.AWAITING_CLAUDE_PROCESS,  // visual-review fix loop
  'approved',                       // researcher trigger
  'researched',                     // design-director trigger
  'design-approved',                // builder Mode skeleton trigger
]);

const TG_OWNER_CHAT_ID = String(getEnv('TG_OWNER_CHAT_ID') || '').trim();

export const config = { api: { bodyParser: false } };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifySignature(secret, body, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }

  const secret = process.env.GH_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[gh-webhook] GH_WEBHOOK_SECRET not set');
    res.statusCode = 500; res.end('config error'); return;
  }

  const body = await readBody(req);
  const sig = req.headers['x-hub-signature-256'];
  if (!verifySignature(secret, body, sig)) {
    res.statusCode = 401; res.end('bad signature'); return;
  }

  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { res.statusCode = 400; res.end('bad json'); return; }

  const event = req.headers['x-github-event'];
  if (event !== 'issues' || payload.action !== 'labeled') {
    res.statusCode = 204; res.end(); return;
  }

  const label = payload.label?.name;
  const issue = payload.issue;
  if (!issue) { res.statusCode = 204; res.end(); return; }

  // Wave 2 W3 — B1 hold-and-notify: если label требует CC и сессия offline,
  // пингуем owner один раз (per issue, TTL 6h). Не блокируем нормальные handlers
  // ниже — label остаётся, CC при next /start-session подберёт через gh issue list.
  if (TG_OWNER_CHAT_ID && CC_REQUIRED_LABELS.has(label)) {
    try {
      const hb = await getCcHeartbeat(TG_OWNER_CHAT_ID);
      if (!hb) {
        // Stale / never seen heartbeat → CC offline
        const already = await wasCcOfflineNotified(TG_OWNER_CHAT_ID, issue.number);
        if (!already) {
          await sendMessage(
            TG_OWNER_CHAT_ID,
            `🔴 CC сессия не активна.\n\n` +
            `#${issue.number} получил label <b>${label}</b> — работа не подхвачена ` +
            `(нет heartbeat от Claude Code последние 3 мин).\n\n` +
            `${issue.html_url}\n\n` +
            `Открой Claude Code → <code>/start-session</code>. ` +
            `Issue останется с label, /start-session подхватит автоматически.`,
            { parse_mode: 'HTML' }
          );
          await markCcOfflineNotified(TG_OWNER_CHAT_ID, issue.number);
        }
      }
      // Heartbeat fresh → continue к обычным handlers; CC reactive Monitor сам обработает
    } catch (e) {
      console.warn('[gh-webhook B1] heartbeat check failed:', e?.message);
      // Не блокируем — продолжаем нормальный flow
    }
  }

  try {
    if (label === LABELS.NEEDS_VISUAL_REVIEW) {
      await registerActiveTask(issue.number, {
        issue_number: issue.number,
        slug: extractSlug(issue.title, issue.body),
        title: issue.title,
        url: issue.html_url,
        added_at: new Date().toISOString(),
        sections_required: 3,  // M2 will read actual section count from issue body
        sections_done: 0,
      });
      await pushNotification(
        `🆕 #${issue.number} — ждёт visual review\n\n${issue.title}\n${issue.html_url}\n\n/current чтобы открыть.`
      );
    } else if (label === LABELS.BUILT) {
      // Phase 3.5 — push BOTH (owner + assignee) с 3 кнопками после tester green.
      const slug = extractSlug(issue.title, issue.body);
      const previewUrl = `https://${slug}.vercel.app`;
      const kb = new InlineKeyboard()
        .text('✅ Готово / В pitch', `done_review:${issue.number}:approve`)
        .text('🔄 Ещё правки',       `done_review:${issue.number}:revise`)
        .row()
        .url('📲 Открыть preview',   previewUrl);
      const replyMarkup = { inline_keyboard: kb.inline_keyboard };
      const text = `🧱 #${issue.number} собран (${slug}).\n\n` +
                   `Preview: ${previewUrl}\nIssue: ${issue.html_url}\n\n` +
                   `[✅ Готово] → ready-for-pitch · [🔄 Ещё правки] → новый круг.`;
      await pushBoth(issue.number, text, { reply_markup: replyMarkup });
    } else if (label === LABELS.DESIGN_PENDING) {
      // Phase 3.4 — push owner с inline A/B + preview moodboard.
      // Grammy InlineKeyboard → плоский объект для TG raw API (без method bindings).
      const kb = new InlineKeyboard()
        .text('🅰 Variant A', `design_pick:${issue.number}:A`)
        .text('🅱 Variant B', `design_pick:${issue.number}:B`)
        .row()
        .text('🖼 Moodboard', `design_pick:${issue.number}:preview`);
      const replyMarkup = { inline_keyboard: kb.inline_keyboard };
      try {
        await pushNotification(
          `🎨 #${issue.number} — design-director выдал 2 варианта.\n\n` +
          `${issue.title}\n${issue.html_url}\n\n` +
          `Открой design_brief.md в issue, выбери A или B.`,
          { reply_markup: replyMarkup }
        );
      } catch (e) {
        console.error('[gh-webhook DESIGN_PENDING] push failed:', e?.message, e?.stack);
        throw e;
      }
    } else if (label === LABELS.READY_FOR_PITCH) {
      // M3c — Q30 quiet push: single line, no buttons. Batch review via /pitch_review.
      await pushNotification(`🎉 #${issue.number} готов к pitch — /pitch_review`);
    } else if (label === LABELS.SCOUTED) {
      // M3b — Q27: push with approve buttons. Bot handles the callbacks.
      const requested = extractRequestedBy(issue.body);
      const author = requested ? ` (предложил ${requested})` : '';
      await pushNotification(
        `🔍 Новый лид #${issue.number}${author}\n\n${issue.title}\n${issue.html_url}\n\n/scout_review для approve.`
      );
    } else if (label === LABELS.BUG_PENDING) {
      // /bug — assistant submitted, owner should review via /bug_review.
      // De-dup от handleDone direct push: проверяем "Reported by ... via TG bot" в body.
      const viaTgBot = /Reported by .* via TG bot/i.test(issue.body || '');
      if (!viaTgBot) {
        await pushNotification(
          `🐛 Bug-репорт #${issue.number}\n\n${issue.title}\n${issue.html_url}\n\n/bug_review`
        );
      }
    } else if (label === LABELS.PROMPT_PENDING) {
      // /prompt — assistant submitted, owner reviews via /prompt_review.
      const viaTgBot = /Sent by .* via TG bot/i.test(issue.body || '');
      if (!viaTgBot) {
        await pushNotification(
          `💡 Prompt #${issue.number}\n\n${issue.title}\n${issue.html_url}\n\n/prompt_review`
        );
      }
    } else if (label === LABELS.AWAITING_SCOUT) {
      // Safety net (Phase 1.1 hotfix). processScoutInput уже пушит owner'у
      // напрямую — но если issue создан не через бот (scout-agent локально
      // через `gh issue create --label awaiting-scout`), процесс-tg-tasks
      // ничего не знает, owner иначе не получит сигнала вообще.
      // De-dup от processScoutInput push'а: проверяем `Requested by … via TG bot`
      // в body — если есть, push уже был отправлен ботом.
      const requested = extractRequestedBy(issue.body);
      const viaTgBot = /Requested by .* via TG bot/i.test(issue.body || '');
      if (!viaTgBot) {
        const author = requested ? ` (предложил ${requested})` : '';
        await pushNotification(
          `🔍 Заявка на скаут #${issue.number}${author}\n\n${issue.title}\n${issue.html_url}\n\n` +
          `Запусти /process-tg-tasks — skill разведает.`
        );
      }
    }
  } catch (e) {
    console.error('[gh-webhook] handler error:', e?.message);
    console.error('[gh-webhook] stack:', e?.stack);
  }
  res.statusCode = 200; res.end('ok');
}

// Reserved tokens that look like slugs but are pipeline markers.
// e.g. "[scout-request] IG @mana_minsk" — the bracket payload is buildScoutIssue's
// placeholder marker, NOT the actual slug. Slug for that issue is "mana-minsk".
const RESERVED_SLUGS = new Set([
  'scout-request', 'scouted', 'scout',
  'needs', 'needs-fix', 'needs-visual-review',
  'ready', 'ready-for-pitch',
  'awaiting', 'awaiting-scout', 'awaiting-claude-process', 'awaiting-owner-review',
  'building', 'built',
  'design-pending', 'design-approved', 'design-ready',
  'pitched', 'sold', 'lost', 'ghosted', 'wont-do',
  'archived', 'bot-test',
]);

function extractSlug(title, body) {
  // 1. Body `Slug: xxx` или metadata block (researcher/builder заполняют).
  if (body) {
    const bodySlug = body.match(/^\s*slug:\s*([a-z0-9-]+)\s*$/im);
    if (bodySlug && !RESERVED_SLUGS.has(bodySlug[1].toLowerCase())) {
      return bodySlug[1];
    }
  }
  // 2. Title `[slug]` if not reserved.
  const titleBracket = title.match(/\[([a-z0-9-]+)\]/i);
  if (titleBracket && !RESERVED_SLUGS.has(titleBracket[1].toLowerCase())) {
    return titleBracket[1];
  }
  // 3. Body `IG @handle` — derive slug from IG handle (mana_minsk → mana-minsk).
  if (body) {
    const igHandle = body.match(/IG (?:handle:\s*)?@?([a-z0-9_.]+)/i);
    if (igHandle) {
      return igHandle[1].toLowerCase().replace(/[_.]+/g, '-').replace(/^-|-$/g, '');
    }
  }
  // 4. Last resort: first word of title, sanitized.
  const fallback = (title || '').split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
  return fallback || `issue-unknown`;
}

// Bot writes "Requested by @username via TG" in the issue body when an
// assistant submits /scout. Pull that hint into the push so owner sees who
// asked. Returns null if not present.
function extractRequestedBy(body) {
  if (!body) return null;
  const m = body.match(/Requested by\s+([@\w-]+)/i);
  return m ? m[1] : null;
}

async function pushNotification(text, extra = {}) {
  // BOM-aware read: vercel env add через PowerShell pipe иногда вставляет
  // U+FEFF в начало значения. config.getEnv() стрипает его (+trim).
  const chatId = getEnv('TG_OWNER_CHAT_ID');
  if (!chatId) {
    console.warn('[gh-webhook] TG_OWNER_CHAT_ID not set — skipping push');
    return;
  }
  await sendMessage(chatId, text, extra);
}

// Phase 3.5 — parallel-authority push. Owner + assignee оба получают
// сообщение и могут tap «Готово» / «Ещё правки». De-dup если они один
// и тот же chatId.
async function pushBoth(issueNumber, text, extra = {}) {
  const ownerId = getEnv('TG_OWNER_CHAT_ID');
  const assignee = await getTaskAssignee(issueNumber).catch(() => null);
  const igAssignee = await getAssistantChatId(issueNumber).catch(() => null);
  const targets = new Set([ownerId, assignee, igAssignee].filter(Boolean));
  for (const chatId of targets) {
    try {
      await sendMessage(chatId, text, extra);
    } catch (e) {
      console.warn(`[gh-webhook] pushBoth → ${chatId} failed:`, e.message);
    }
  }
}
