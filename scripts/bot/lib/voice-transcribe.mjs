// Voice transcription via Google Gemini 1.5 Flash.
//
// Why Gemini: native audio input (inline_data), free tier 15 RPM, accepts
// audio/ogg directly (TG voice messages = Opus в .ogg container). $0 cost.
//
// Flow: TG file_id → getFile → download bytes → base64 → Gemini API → text.
//
// Env: GEMINI_API_KEY (set in Vercel + .env). TG_BOT_TOKEN for getFile.

import { getEnv } from '../config.mjs';

const GEMINI_MODEL = 'gemini-2.5-flash';

// Multi-key fallback: parse GEMINI_API_KEYS (comma-separated) ИЛИ single
// GEMINI_API_KEY. Try each key strictly in order; на 429 (rate limit) →
// next key; на other error → fail (don't waste fallback на real bugs).
function loadGeminiKeys() {
  const multi = (getEnv('GEMINI_API_KEYS') || '').trim();
  if (multi) {
    return multi.split(',').map(k => k.trim()).filter(Boolean);
  }
  const single = (getEnv('GEMINI_API_KEY') || '').trim();
  return single ? [single] : [];
}

export async function transcribeTgVoice(fileId, { hintLanguage = 'ru' } = {}) {
  const tgToken = getEnv('TG_BOT_TOKEN');
  if (!tgToken) throw new Error('TG_BOT_TOKEN missing');
  const keys = loadGeminiKeys();
  if (!keys.length) throw new Error('GEMINI_API_KEYS / GEMINI_API_KEY missing');

  // 1. Resolve TG file_id → file_path
  const getFileResp = await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const getFileJson = await getFileResp.json();
  if (!getFileJson.ok) throw new Error(`TG getFile failed: ${JSON.stringify(getFileJson)}`);
  const filePath = getFileJson.result.file_path;

  // 2. Download bytes
  const fileResp = await fetch(`https://api.telegram.org/file/bot${tgToken}/${filePath}`);
  if (!fileResp.ok) throw new Error(`TG download failed: ${fileResp.status}`);
  const buf = Buffer.from(await fileResp.arrayBuffer());
  const base64 = buf.toString('base64');

  // 3. Gemini inline audio — try keys в order until success или not-429-error.
  const prompt = hintLanguage === 'ru'
    ? 'Транскрибируй это голосовое сообщение на русский язык, дословно. Если есть слова на других языках — оставляй как есть. Возвращай только текст без preface.'
    : 'Transcribe this voice message verbatim. Return only the transcript, no preface.';

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'audio/ogg', data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  };

  let lastError;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const keyTag = `key#${i + 1}/${keys.length}`;
    try {
      const geminiResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (geminiResp.status === 429) {
        const text = await geminiResp.text();
        console.warn(`[voice-transcribe] ${keyTag} 429 rate limited, trying next key. Detail: ${text.slice(0, 200)}`);
        lastError = new Error(`Gemini 429 (${keyTag})`);
        continue;
      }
      if (!geminiResp.ok) {
        const text = await geminiResp.text();
        console.error(`[voice-transcribe] ${keyTag} HTTP ${geminiResp.status}: ${text}`);
        throw new Error(`Gemini API ${geminiResp.status}: ${text.slice(0, 500)}`);
      }
      const json = await geminiResp.json();
      const transcript = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!transcript) {
        console.error(`[voice-transcribe] ${keyTag} empty response: ${JSON.stringify(json)}`);
        throw new Error(`Gemini returned no text: ${JSON.stringify(json).slice(0, 500)}`);
      }
      if (i > 0) console.log(`[voice-transcribe] ${keyTag} succeeded after fallback from ${i} key(s)`);
      return transcript;
    } catch (e) {
      // Network errors etc — fail (не fallback на bugs)
      if (e.message.includes('Gemini 429')) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  throw lastError || new Error('All Gemini keys exhausted');
}
