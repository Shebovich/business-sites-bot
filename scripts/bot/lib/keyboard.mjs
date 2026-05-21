// Inline keyboard builder for section navigation with progress counts.
// See Q16.2 (UX: inline keyboard with progress + multi-input).

import { InlineKeyboard } from 'grammy';
import { SECTIONS } from '../config.mjs';
import { countPhotos, getSkipped } from './state.mjs';

// Build the main section keyboard for a task.
// progress per section: "✅ 5/4", "3/4", "(нужно 1)", "⏭ skipped".
export async function buildSectionKeyboard(issueNumber) {
  const kb = new InlineKeyboard();
  const skipped = new Set(await getSkipped(issueNumber));

  for (const section of SECTIONS) {
    const count = await countPhotos(issueNumber, section.id);
    const label = renderSectionButton(section, count, skipped.has(section.id));
    kb.text(label, `sec:${section.id}`).row();
  }

  kb.text('📝 Тексты', 'mode:texts').row();

  // Always show "Готово" — assistant /submits to owner, owner /done_all'ит solo.
  // Hash check (Q24) + owner review catch empty/no-op submits, so we don't
  // need to gate on photo counts here.
  kb.text('✅ Готово', 'action:submit').row();

  kb.text('❌ Отмена', 'action:cancel');
  return kb;
}

function renderSectionButton(section, count, isSkipped) {
  const { emoji, label, min_count } = section;
  if (isSkipped) return `${emoji} ${label} — ⏭ skipped`;
  if (count >= min_count) return `${emoji} ${label} — ✅ ${count}/${min_count}`;
  if (count > 0)          return `${emoji} ${label} — ${count}/${min_count}`;
  return `${emoji} ${label} (нужно ${min_count})`;
}

// Keyboard for /list — one row per active task.
// `_icon` overrides the default 📋 (used to flag `awaiting-owner-review` as 🔵).
export function buildTaskListKeyboard(activeTasks) {
  const kb = new InlineKeyboard();
  for (const t of activeTasks) {
    const name = t.venue_name || t.slug || `issue-${t.issue_number}`;
    const hasProgress = (t.sections_done != null) && (t.sections_required != null);
    const suffix = hasProgress ? ` (${t.sections_done}/${t.sections_required})` : '';
    const icon = t._icon || '📋';
    kb.text(`${icon} ${name} · #${t.issue_number}${suffix}`, `task:${t.issue_number}`).row();
  }
  return kb;
}

// M3a: actions under the owner push (Q19). Returns plain markup so the
// review-helpers can stay TG-library-agnostic.
export function buildOwnerPushKeyboard(issueNumber) {
  return new InlineKeyboard()
    .text('👁 Открыть фото', `gallery:${issueNumber}`)
    .row()
    .text('✅ Approve', `approve:${issueNumber}`)
    .text('💬 Замечания', `feedback:${issueNumber}`);
}

// M3a: keyboard rendered next to /preview (Q24.5). Same review summary but
// with per-section [🔍 Открыть] (lazy gallery scoped to one section). Edit
// buttons for text fields will land with M3a stage 2 (text-edit flow). For
// now we expose the section-scoped gallery — that's the most-asked-for
// missing piece (assistant can't visually verify what they uploaded).
export function buildPreviewKeyboard(issueNumber, sectionsWithPhotos) {
  const kb = new InlineKeyboard();
  for (const sectionId of sectionsWithPhotos) {
    kb.text(`🔍 ${sectionId}`, `gallery:${issueNumber}:${sectionId}`).row();
  }
  return kb;
}
