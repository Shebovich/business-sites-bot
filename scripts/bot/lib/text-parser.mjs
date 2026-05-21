// Detect text-edit instructions vs free-form replies.
// Two flavours per Q16.7:
//   1. "замени lede на ..."  -> field-targeted edit
//   2. caption alongside photo URL -> instruction attached to upload

import { TEXT_EDIT_VERBS, TEXT_FIELDS, URL_PATTERNS } from '../config.mjs';

export function isTextEditInstruction(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return TEXT_EDIT_VERBS.some(re => re.test(trimmed));
}

// Returns the text edit details or null. Best-effort field matching:
// looks for a known field id/label substring in the instruction.
export function parseTextEdit(text) {
  if (!isTextEditInstruction(text)) return null;
  const lower = text.toLowerCase();
  let matchedField = null;
  for (const f of TEXT_FIELDS) {
    if (lower.includes(f.id) || lower.includes(f.label.toLowerCase())) {
      matchedField = f.id;
      break;
    }
  }
  return {
    field: matchedField,           // null if user didn't mention a known field
    raw_instruction: text.trim(),
  };
}

// Split a TG message body into (url, caption) — URL on its own line/token,
// caption is the remainder. Returns { url, caption } or { url: null, caption: text }.
export function splitUrlAndCaption(text) {
  if (!text) return { url: null, caption: '' };
  const all = [
    URL_PATTERNS.ig_highlight,
    URL_PATTERNS.ig_reel,
    URL_PATTERNS.ig_post,
    URL_PATTERNS.direct_video,
    URL_PATTERNS.direct_image,
  ];
  // Find the first matching URL anywhere in the text.
  const urlRe = /(https?:\/\/\S+)/i;
  const m = text.match(urlRe);
  if (!m) return { url: null, caption: text.trim() };
  const url = m[1];
  // Only return URL if it matches one of our supported patterns.
  if (!all.some(p => p.test(url))) return { url: null, caption: text.trim() };
  const caption = text.replace(url, '').trim();
  return { url, caption };
}
