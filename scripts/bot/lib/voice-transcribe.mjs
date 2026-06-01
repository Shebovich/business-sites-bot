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
      maxOutputTokens: 2048,
      // gemini-2.5-flash — thinking-модель: с дефолтным thinking budget она
      // тратит maxOutputTokens на внутренние «размышления» и возвращает ПУСТОЙ
      // текст (finishReason MAX_TOKENS, parts отсутствуют) → транскрипция падала.
      // Транскрипции рассуждать не нужно — отключаем thinking (надёжнее + быстрее).
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  console.log(`[voice-transcribe] start — ${keys.length} keys available, audio size ${buf.length}b`);
  // Fallback на ЛЮБУЮ осечку ключа (429 quota / 5xx overloaded / пустой ответ /
  // network), не только 429. Раньше первый non-429 error делал throw и
  // остальные ключи не пробовались → один транзиентный сбой = «не удалось»
  // при живых запасных ключах (#204). Throw только когда ВСЕ ключи исчерпаны.
  let lastError;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const keyTag = `key#${i + 1}/${keys.length}(${key.slice(0, 8)}...)`;
    try {
      const geminiResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // Per-key timeout: медленный/зависший ключ не должен съесть весь
          // бюджет функции (webhook maxDuration 30s). Abort → catch → след. ключ.
          signal: AbortSignal.timeout(7000),
        },
      );
      if (!geminiResp.ok) {
        const text = await geminiResp.text();
        const level = geminiResp.status === 429 ? 'warn' : 'error';
        console[level](`[voice-transcribe] ${keyTag} HTTP ${geminiResp.status}, trying next key. Detail: ${text.slice(0, 200)}`);
        lastError = new Error(`Gemini ${geminiResp.status} (${keyTag}): ${text.slice(0, 200)}`);
        continue;
      }
      const json = await geminiResp.json();
      const transcript = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!transcript) {
        const finish = json?.candidates?.[0]?.finishReason || 'unknown';
        console.error(`[voice-transcribe] ${keyTag} empty response (finishReason=${finish}), trying next key`);
        lastError = new Error(`Gemini empty text (${keyTag}, finishReason=${finish})`);
        continue;
      }
      if (i > 0) console.log(`[voice-transcribe] ${keyTag} succeeded after fallback from ${i} key(s)`);
      return transcript;
    } catch (e) {
      // Network/parse error на этом ключе — пробуем следующий, не сдаёмся сразу.
      console.error(`[voice-transcribe] ${keyTag} threw: ${e.message}, trying next key`);
      lastError = e;
      continue;
    }
  }

  throw lastError || new Error('All Gemini keys exhausted');
}
