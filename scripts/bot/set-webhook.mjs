#!/usr/bin/env node
// One-time setup: register the TG webhook URL with BotFather's API.
// Usage:
//   $env:TG_BOT_TOKEN = "..."
//   node scripts/bot/set-webhook.mjs https://<your-app>.vercel.app/api/bot/webhook

const url = process.argv[2];
if (!url) {
  console.error('Usage: node scripts/bot/set-webhook.mjs <webhook_url>');
  process.exit(1);
}

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  console.error('TG_BOT_TOKEN env var required.');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }),
});
const json = await res.json();
if (json.ok) {
  console.log(`Webhook set: ${url}`);
} else {
  console.error('Failed:', json);
  process.exit(1);
}
