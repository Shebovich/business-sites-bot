// Thin TG Bot API wrapper for calls that grammy doesn't make ergonomic
// (e.g. raw file URL retrieval for IG-style URL downloading).
// Most handler code should use ctx.* from grammy instead.

export async function tgApi(method, payload = {}) {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) throw new Error('TG_BOT_TOKEN not set');
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`TG API ${method}: ${json.description || res.status}`);
  return json.result;
}

export async function getFileUrl(fileId) {
  const token = process.env.TG_BOT_TOKEN;
  const file = await tgApi('getFile', { file_id: fileId });
  return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
}

export async function sendMessage(chatId, text, extra = {}) {
  return await tgApi('sendMessage', { chat_id: chatId, text, ...extra });
}

// `media` is an array of `{type, media, caption?}` — TG accepts up to 10 per
// call. Caller is responsible for batching (see review.mjs buildGalleryBatches).
export async function sendMediaGroup(chatId, media) {
  return await tgApi('sendMediaGroup', { chat_id: chatId, media });
}
