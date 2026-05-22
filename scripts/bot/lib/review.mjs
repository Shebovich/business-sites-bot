// M3a — owner-assistant review loop helpers (Q19-Q24.5).
// Builds the owner push, hashes submit state for noop-detection, prepares
// media-group payloads for lazy gallery.

import crypto from 'node:crypto';
import { SECTIONS, SECTION_BY_ID } from '../config.mjs';
import { getPhotos, getTextEdits, getSkipped, getNotes } from './state.mjs';

const TG_MESSAGE_LIMIT = 4096;
const TEXT_PREVIEW_LIMIT = 150;

// Aggregate everything an assistant has submitted for a task.
// Used by both push-builder and hash function.
export async function collectSubmitState(issueNumber) {
  const sections = {};
  for (const s of SECTIONS) {
    const photos = await getPhotos(issueNumber, s.id);
    sections[s.id] = photos;
  }
  const textEdits = await getTextEdits(issueNumber);
  const skipped = await getSkipped(issueNumber);
  const notes = await getNotes(issueNumber);
  return { sections, textEdits, skipped, notes };
}

// SHA1 over the *content* of the submit, not the timestamps. Two /submit
// calls without any change between them produce the same hash → Q24 rejects
// the second one.
export function hashSubmitState({ sections, textEdits, skipped, notes }) {
  const fileTokens = [];
  for (const sectionId of Object.keys(sections).sort()) {
    for (const p of sections[sectionId]) {
      if (p.source === 'tg_upload') fileTokens.push(`${sectionId}|tg:${p.file_id}`);
      else if (p.url)               fileTokens.push(`${sectionId}|url:${p.url}`);
      else                          fileTokens.push(`${sectionId}|unknown:${JSON.stringify(p).slice(0, 80)}`);
    }
  }
  const textTokens = textEdits
    .filter(e => e.field && e.new_value != null)
    .map(e => `${e.field}=${e.new_value}`)
    .sort();
  const skippedTokens = [...skipped].sort();
  // Notes are order-significant (sequence of instructions matters for context),
  // so we hash them as-written, not sorted.
  const noteTokens = (notes || []).map(n => `${n.section || '_'}|${n.text}`);

  const payload = [
    ...fileTokens.sort(),
    '---texts---',
    ...textTokens,
    '---skipped---',
    ...skippedTokens,
    '---notes---',
    ...noteTokens,
  ].join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

// Build the owner push message body. Round counter shown only when > 1.
//
// Layout (Q19):
//   🔔 {who} прислал на ревью: {venue} #{N}     [🔁 Раунд K — if K > 1]
//
//   📸 Фото:
//   ✅ Hero: 1/1 (видео)
//   ✅ Above-fold: 4/3
//   …
//
//   📝 Тексты:
//   • tagline: «…»
//   • about_lede: «…»
//
//   🔗 Ссылки (3):
//   • https://… → section
//
// Trim long texts down to TEXT_PREVIEW_LIMIT chars with `…` if message
// approaches TG's 4096-byte cap.
export function buildOwnerPush({ task, who, round, state }) {
  const { sections, textEdits, skipped } = state;
  const lines = [];
  const roundTag = round > 1 ? `  🔁 Раунд ${round}` : '';
  lines.push(`🔔 ${who} прислал на ревью: ${task.venue_name || task.slug} #${task.issue_number}${roundTag}`);

  // Photos block
  const photoLines = [];
  for (const s of SECTIONS) {
    const photos = sections[s.id] || [];
    if (photos.length === 0 && !s.required && !skipped.includes(s.id)) continue;
    if (skipped.includes(s.id)) {
      photoLines.push(`⏭ ${s.label}: пропущена`);
      continue;
    }
    const required = s.min_count;
    const got = photos.length;
    const enough = got >= required;
    const hint = describePhotoSet(photos);
    const status = enough ? '✅' : (got > 0 ? '🟡' : '❌');
    photoLines.push(`${status} ${s.label}: ${got}/${required}${hint ? ` (${hint})` : ''}`);
  }
  if (photoLines.length) {
    lines.push('');
    lines.push('📸 Фото:');
    lines.push(...photoLines);
  }

  // Text-edits block (preview only)
  const textLines = [];
  // Latest value per field wins (multiple edits get squashed in the push).
  const latestByField = {};
  for (const e of textEdits) {
    if (e.field && e.new_value != null) latestByField[e.field] = e.new_value;
  }
  for (const [field, value] of Object.entries(latestByField)) {
    const preview = truncate(value, TEXT_PREVIEW_LIMIT);
    textLines.push(`• ${field}: «${preview}»`);
  }
  if (textLines.length) {
    lines.push('');
    lines.push('📝 Тексты:');
    lines.push(...textLines);
  }

  // URL block (only URL-type photos, listed separately so owner sees what
  // still needs downloading at rebuild time).
  const urlEntries = [];
  for (const s of SECTIONS) {
    for (const p of (sections[s.id] || [])) {
      if (p.source === 'url' && p.url) urlEntries.push({ url: p.url, section: s.label });
    }
  }
  if (urlEntries.length) {
    lines.push('');
    lines.push(`🔗 Ссылки (${urlEntries.length}):`);
    for (const e of urlEntries) {
      lines.push(`• ${truncate(e.url, 80)} → ${e.section}`);
    }
  }

  // Notes block — free-form text instructions grouped by section.
  const notes = state.notes || [];
  if (notes.length) {
    lines.push('');
    lines.push(`📝 Заметки (${notes.length}):`);
    notes.forEach((n, idx) => {
      const where = n.section
        ? (SECTION_BY_ID[n.section]?.label || n.section)
        : 'общая';
      lines.push(`${idx + 1}. [${where}] ${truncate(n.text, 200)}`);
    });
  }

  let body = lines.join('\n');

  // Crude TG-cap safety: if we overshoot, fall back to summary only.
  if (body.length > TG_MESSAGE_LIMIT) {
    const summary = [
      `🔔 ${who} прислал на ревью: ${task.venue_name || task.slug} #${task.issue_number}${roundTag}`,
      '',
      '⚠️ Слишком длинный список — открой /current для полного просмотра.',
    ].join('\n');
    body = summary;
  }
  return body;
}

// Build [👁 Открыть фото] [✅ Approve] [💬 Замечания] inline keyboard data.
// Pure-data return — actual InlineKeyboard built in keyboard.mjs.
export function ownerPushActions(issueNumber) {
  return [
    { text: '👁 Открыть фото', callback_data: `gallery:${issueNumber}` },
    { text: '✅ Approve', callback_data: `approve:${issueNumber}` },
    { text: '💬 Замечания', callback_data: `feedback:${issueNumber}` },
  ];
}

// Build the sendMediaGroup payload for the lazy gallery (Q22).
// Returns an array of media-group "batches" (TG limits to 10 items per group).
// Each photo gets a caption like "[hero] 1/2" so owner can locate it on the
// section list.
//
// URL-typed photos can't always be inlined — IG CDN URLs require auth. We
// include direct image URLs (TG can fetch those) but skip IG / video URLs
// with a textual placeholder.
export function buildGalleryBatches(state) {
  const { sections } = state;
  const all = [];
  for (const s of SECTIONS) {
    const photos = sections[s.id] || [];
    photos.forEach((p, idx) => {
      const label = `[${s.id}] ${idx + 1}/${photos.length}`;
      if (p.source === 'tg_upload' && p.type === 'photo') {
        all.push({ type: 'photo', media: p.file_id, caption: label });
      } else if (p.source === 'tg_upload' && p.type === 'video') {
        all.push({ type: 'video', media: p.file_id, caption: label });
      } else if (p.source === 'url' && p.type === 'direct_image' && p.url) {
        all.push({ type: 'photo', media: p.url, caption: label });
      } else if (p.source === 'url' && p.type === 'direct_video' && p.url) {
        all.push({ type: 'video', media: p.url, caption: label });
      } else if (p.source === 'url' && p.url) {
        // IG-style URLs — can't preview, defer to rebuild.
        all.push({ _placeholder: true, label, url: p.url });
      }
    });
  }
  // TG sendMediaGroup rejects groups containing duplicate file_id/url with
  // HTTP 404 — known quirk. We dedupe within the gallery (assistants often
  // send the same photo to multiple sections, or upload same file twice).
  // Captions of duplicates are merged so owner still sees where it belongs.
  const seen = new Map();
  const deduped = [];
  for (const item of all) {
    if (item._placeholder) { deduped.push(item); continue; }
    const key = item.media;
    if (seen.has(key)) {
      const first = deduped[seen.get(key)];
      first.caption = `${first.caption} + ${item.caption}`;
    } else {
      seen.set(key, deduped.length);
      deduped.push({ ...item });
    }
  }

  // Split into batches of 10 (TG sendMediaGroup limit).
  const batches = [];
  let current = [];
  let placeholders = [];
  for (const item of deduped) {
    if (item._placeholder) {
      placeholders.push(`${item.label}: ${truncate(item.url, 80)}`);
      continue;
    }
    current.push(item);
    if (current.length === 10) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return { batches, placeholders };
}

// Human-readable hint for photo set: "видео" / "url-only" / "3 фото".
function describePhotoSet(photos) {
  if (photos.length === 0) return '';
  if (photos.length === 1) {
    const p = photos[0];
    if (p.type === 'video' || p.type === 'ig_reel' || p.type === 'direct_video') return 'видео';
    return '';
  }
  return '';
}

function truncate(s, limit) {
  if (!s) return '';
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}
