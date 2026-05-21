// Vercel serverless function — receives GitHub webhook events.
// M1: signature verification + label-change detection. Sends a TG ping to
// TG_OWNER_CHAT_ID when an issue gets labeled `needs-visual-review`.
// M2: also handle `built` / `ready-for-pitch` for status updates.

import crypto from 'node:crypto';
import { LABELS } from '../scripts/bot/config.mjs';
import { sendMessage } from '../scripts/bot/lib/tg-api.mjs';
import { registerActiveTask } from '../scripts/bot/lib/state.mjs';

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

  try {
    if (label === LABELS.NEEDS_VISUAL_REVIEW) {
      await registerActiveTask(issue.number, {
        issue_number: issue.number,
        slug: extractSlug(issue.title),
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
      await pushNotification(`✅ #${issue.number} обновлено, посмотри preview в issue: ${issue.html_url}`);
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
    }
  } catch (e) {
    console.error('[gh-webhook] handler error:', e.message);
  }

  res.statusCode = 200; res.end('ok');
}

function extractSlug(title) {
  // Issues are titled like "Скиф — нужен сайт" or "[slug] ..." — best-effort.
  const m = title.match(/\[([a-z0-9-]+)\]/i);
  return m ? m[1] : title.split(/\s+/)[0];
}

// Bot writes "Requested by @username via TG" in the issue body when an
// assistant submits /scout. Pull that hint into the push so owner sees who
// asked. Returns null if not present.
function extractRequestedBy(body) {
  if (!body) return null;
  const m = body.match(/Requested by\s+([@\w-]+)/i);
  return m ? m[1] : null;
}

async function pushNotification(text) {
  const chatId = process.env.TG_OWNER_CHAT_ID;
  if (!chatId) {
    console.warn('[gh-webhook] TG_OWNER_CHAT_ID not set — skipping push');
    return;
  }
  await sendMessage(chatId, text);
}
