// Shared constants for the visual-review TG bot.
// Single source of truth — used by webhook handlers, GitHub Actions, dev runner.

// Overridable via env so the same bot binary can target a different sites
// repo (e.g. staging fork) without code change. Default preserves history.
export const GITHUB_REPO = (process.env.GITHUB_REPO || 'Shebovich/business-sites').trim();

// Issue labels that drive the state machine
export const LABELS = {
  NEEDS_VISUAL_REVIEW: 'needs-visual-review',
  BUILDING: 'building',
  BUILT: 'built',
  READY_FOR_PITCH: 'ready-for-pitch',
  AWAITING_PHOTOS: 'awaiting-photos',
  // M2.5 — Claude Code executor pivot (Q18.1).
  // Bot commits input.json + sets this label; Claude Code skill picks them up.
  AWAITING_CLAUDE_PROCESS: 'awaiting-claude-process',
  // M2.5 — multi-user. Assistants /submit → owner reviews via /owner_review.
  AWAITING_OWNER_REVIEW: 'awaiting-owner-review',
  // M3c — lifecycle after pitch (Q30, Q31)
  PITCHED: 'pitched',
  SOLD: 'sold',
  LOST: 'lost',
  // M3b — scout from bot (Q26, Q26.5)
  AWAITING_SCOUT: 'awaiting-scout',
  SCOUTED: 'scouted',
  EXISTING_SITE_REPLACE: 'existing-site-replace',
  // Phase 1.1 — explicit reject path для /scout_review.
  // Issue закрывается с причиной + комментарий + push assignee.
  WONT_DO: 'wont-do',
  // Phase 3.4 — design-director выводит 2 варианта, owner picks A/B в TG.
  DESIGN_PENDING:  'design-pending',
  DESIGN_APPROVED: 'design-approved',
  // v5 Flow X — owner approve scouted → researcher запускается с этим лейблом.
  // Заменяет legacy NEEDS_VISUAL_REVIEW в approve handler.
  APPROVED: 'approved',
};

// Sections a user can submit photos for. Each entry: id, label (RU display),
// emoji, suggested_count (informational hint shown in /current — not a gate;
// /submit and /done_all accept any state, owner decides on review),
// accepts_video flag.
//
// `required` and `min_count` kept for back-compat but no longer block flow.
// `required: false` everywhere; previously enforced by gate logic that was
// removed when the contract shifted to "assistant collects, owner reviews".
export const SECTIONS = [
  { id: 'hero',                 label: 'Hero (видео процесса)',     emoji: '🎬', min_count: 1, required: false, accepts_video: true },
  { id: 'above_fold_thumbs',    label: 'Above-fold блюда',          emoji: '🍽', min_count: 3, required: false, accepts_video: false },
  { id: 'menu_full',            label: 'Меню (карточки)',           emoji: '📋', min_count: 4, required: false, accepts_video: false },
  { id: 'interior_unique',      label: 'Интерьер',                  emoji: '🪑', min_count: 3, required: false, accepts_video: false },
  { id: 'private_dining',       label: 'Банкетный зал',             emoji: '🏛', min_count: 2, required: false, accepts_video: false },
  { id: 'signature_dishes',     label: 'Фирменные блюда',           emoji: '⭐️', min_count: 3, required: false, accepts_video: false },
  { id: 'family_celebrations',  label: 'Семейные торжества',        emoji: '👨‍👩‍👧', min_count: 1, required: false, accepts_video: false },
  { id: 'chef_or_bartender',    label: 'Шеф/бармен',                emoji: '👨‍🍳', min_count: 1, required: false, accepts_video: false },
  { id: 'about_atmospheric',    label: 'Атмосферное (about)',       emoji: '🌆', min_count: 1, required: false, accepts_video: false },
];

export const SECTION_BY_ID = Object.fromEntries(SECTIONS.map(s => [s.id, s]));

// URL pattern classifier — order matters (more-specific first).
export const URL_PATTERNS = {
  ig_highlight: /instagram\.com\/stories\/highlights\/(\d+)/i,
  ig_reel:      /instagram\.com\/reels?\/([A-Za-z0-9_-]+)/i,
  ig_post:      /instagram\.com\/p\/([A-Za-z0-9_-]+)/i,
  direct_image: /\.(jpe?g|png|webp|gif|avif)(\?.*)?$/i,
  direct_video: /\.(mp4|mov|webm|m4v)(\?.*)?$/i,
};

// Text-edit instruction detection.
// "замени X на Y" / "поставь Y в качестве X" / "добавь Z" — see Q16.7.
export const TEXT_EDIT_VERBS = [
  /^замени(?:те)?\b/i,
  /^постав(?:ь|ьте)\b/i,
  /^обнови(?:те)?\b/i,
  /^измени(?:те)?\b/i,
  /^добав(?:ь|ьте)\b/i,
  /^удали(?:те)?\b/i,
  /^перепиши(?:те)?\b/i,
  /^поменя(?:й|йте)\b/i,
];

// Editable text fields exposed under the [📝 Тексты] keyboard.
export const TEXT_FIELDS = [
  { id: 'tagline',                 label: 'Заголовок в hero' },
  { id: 'about_lede',              label: 'Лид about-секции' },
  { id: 'private_dining_lede',     label: 'Лид банкетного зала' },
  { id: 'signature_dishes_lede',   label: 'Лид фирменных блюд' },
  { id: 'family_celebrations_lede',label: 'Лид семейных торжеств' },
];

// Required env vars — surface clear error if missing.
export const REQUIRED_ENV = [
  'TG_BOT_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TG_OWNER_CHAT_ID',
];

export function assertEnv(names = REQUIRED_ENV) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. See BOT_SETUP.md.`);
  }
}

// Strip leading BOM (U+FEFF) and trim whitespace from env vars.
// PowerShell `echo "X" | vercel env add` introduces BOM via UTF-16 encoding,
// silently breaking string equality. Always read env through this helper.
export function getEnv(name) {
  const v = process.env[name];
  if (v == null) return v;
  return v.replace(/^﻿/, '').trim();
}
