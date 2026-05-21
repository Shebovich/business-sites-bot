export default function handler(req, res) {
  const ownerId = process.env.TG_OWNER_CHAT_ID || '';
  const token = process.env.TG_BOT_TOKEN || '';
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    TG_OWNER_CHAT_ID: {
      raw: ownerId,
      length: ownerId.length,
      charCodes: Array.from(ownerId).map(c => c.charCodeAt(0)),
      asNumber: Number(ownerId),
    },
    TG_BOT_TOKEN_present: token.length > 0,
    TG_BOT_TOKEN_length: token.length,
    UPSTASH_URL_present: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_TOKEN_present: !!process.env.UPSTASH_REDIS_REST_TOKEN,
  }));
}
