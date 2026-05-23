export default async function handler(req, res) {
  const ownerId = process.env.TG_OWNER_CHAT_ID || '';
  const token = (process.env.TG_BOT_TOKEN || '').replace(/^﻿/, '').trim();

  // Identify bot via getMe so мы знаем КАКОМУ именно боту owner должен писать /start.
  let botInfo = null;
  let getMeError = null;
  if (token) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const j = await r.json();
      if (j.ok) {
        botInfo = { id: j.result.id, username: j.result.username, first_name: j.result.first_name };
      } else {
        getMeError = `HTTP ${r.status}: ${j.description || 'unknown'}`;
      }
    } catch (e) {
      getMeError = e.message;
    }
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    TG_OWNER_CHAT_ID: {
      raw: ownerId,
      length: ownerId.length,
      asNumber: Number(ownerId),
    },
    TG_BOT_TOKEN_present: token.length > 0,
    TG_BOT_TOKEN_length: token.length,
    bot_identity: botInfo,
    bot_identity_error: getMeError,
    UPSTASH_URL_present: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_TOKEN_present: !!process.env.UPSTASH_REDIS_REST_TOKEN,
  }, null, 2));
}
