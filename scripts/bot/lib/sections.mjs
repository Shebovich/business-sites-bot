// Vertical-aware section catalog. Source of truth = `_verticals/{vertical}.yaml`
// в репозитории business-sites (поле `visual_review_sections`). Бот читает
// raw файл через GitHub API, парсит, нормализует под старый shape (id, label,
// emoji, min_count, accepts_video, required) и кеширует — Upstash на 1 час +
// in-memory на длительность warm lambda.
//
// На cold start `warmSections()` дёргает refresh. Если GitHub/Upstash отвалились —
// возвращаемся к статичному `SECTIONS` из config.mjs (то, что было до Phase 1.5).
// Это значит: yaml broken / network down ⇒ бот всё ещё рабочий, просто на
// последней встроенной картинке секций.

import yaml from 'js-yaml';
import { SECTIONS as STATIC_SECTIONS, GITHUB_REPO, getEnv } from '../config.mjs';
import { getRedis } from './state.mjs';

// Private repos require auth — raw.githubusercontent.com anonymous returns 404.
// Use api.github.com/contents (returns base64) with GH_TOKEN. Falls back to
// raw anonymous if no token (works for public repos).
async function fetchRepoFile(path) {
  const token = getEnv('GH_TOKEN') || getEnv('GITHUB_TOKEN');
  if (token) {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=main`;
    const res = await fetch(url, {
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`api.github.com ${path}: ${res.status}`);
    const j = await res.json();
    if (!j.content) return null;
    return Buffer.from(j.content, 'base64').toString('utf8');
  }
  // Fallback: anonymous raw (works only для public repos)
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${path}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw ${url}: ${res.status}`);
  return await res.text();
}

const CACHE_TTL_SECONDS = 60 * 60;        // 1h в Upstash
const DEFAULT_VERTICAL = 'restaurant';

// In-memory cache keyed by vertical. Survives between warm requests on the
// same lambda; cold start re-runs warmSections.
const MEM = new Map();

function redisKey(vertical) {
  return `sections:cache:${vertical}`;
}

function normalize(rawList) {
  return rawList.map(s => ({
    id: s.id,
    label: s.label || s.label_ru || s.id,
    emoji: s.emoji || '•',
    min_count: Number.isFinite(s.min_count) ? s.min_count : 0,
    accepts_video: Boolean(s.accepts_video),
    required: Boolean(s.required),
    photo_section_key: s.photo_section_key || s.id,
    hint: s.hint || s.hint_ru || '',
  }));
}

async function fetchFromGitHub(vertical) {
  const path = `_verticals/${vertical}.yaml`;
  const text = await fetchRepoFile(path);
  if (!text) throw new Error(`File not found: ${path}`);
  const doc = yaml.load(text);
  const list = doc?.visual_review_sections;
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`No visual_review_sections in ${path}`);
  }
  return normalize(list);
}

async function fetchFromUpstash(vertical) {
  try {
    const raw = await getRedis().get(redisKey(vertical));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed;
  } catch (e) {
    console.warn('[sections] Upstash read failed:', e.message);
    return null;
  }
}

async function saveToUpstash(vertical, sections) {
  try {
    await getRedis().set(redisKey(vertical), JSON.stringify(sections), { ex: CACHE_TTL_SECONDS });
  } catch (e) {
    console.warn('[sections] Upstash write failed:', e.message);
  }
}

// Warm cache: GitHub → Upstash → in-memory. Idempotent — safe to call on
// every cold start. Doesn't throw — failures degrade to static fallback.
export async function warmSections(vertical = DEFAULT_VERTICAL) {
  try {
    let sections = await fetchFromUpstash(vertical);
    if (!sections) {
      sections = await fetchFromGitHub(vertical);
      await saveToUpstash(vertical, sections);
    }
    MEM.set(vertical, sections);
    return sections;
  } catch (e) {
    console.warn(`[sections] warm failed for ${vertical}, using static fallback:`, e.message);
    MEM.set(vertical, normalize(STATIC_SECTIONS));
    return MEM.get(vertical);
  }
}

// Synchronous getter — what всё callsite-ы используют. Возвращает либо
// прогретый кеш, либо статичный fallback. Никогда не возвращает empty array.
export function getSections(vertical = DEFAULT_VERTICAL) {
  return MEM.get(vertical) || normalize(STATIC_SECTIONS);
}

export function getSectionById(id, vertical = DEFAULT_VERTICAL) {
  return getSections(vertical).find(s => s.id === id) || null;
}

// Optional helper if какой-то callsite готов ждать (не cold-path):
// нет смысла лезть в GitHub при каждом вызове, но если хочется свежее —
// зовём warmSections напрямую. Здесь просто гарантируем что MEM прогрет.
export async function ensureSections(vertical = DEFAULT_VERTICAL) {
  if (MEM.has(vertical)) return MEM.get(vertical);
  return warmSections(vertical);
}

// ---- Per-slug sections (Phase 6 — builder writes per-slug overrides) ----
//
// Each slug может иметь свой actual section list — depends on tier+modifier.
// Builder Mode skeleton writes `_data/{slug}/visual_review_sections.json` с
// массивом sections that actually exist в built HTML.
//
// При tap на task в /list → bot fetches per-slug sections. Если файл exists →
// use them в section keyboard. Иначе fallback на default restaurant sections
// (что было до этой фичи).

const SLUG_MEM = new Map();
const SLUG_REDIS_TTL = 60 * 60;  // 1h
const SLUG_REDIS_KEY = (slug) => `sections:slug:${slug}`;

async function fetchSlugSectionsFromGitHub(slug) {
  const path = `_data/${slug}/visual_review_sections.json`;
  const text = await fetchRepoFile(path);
  if (!text) return null;  // нет файла — fallback на default
  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    console.warn(`[sections-slug] bad JSON in ${path}: ${e.message}`);
    return null;
  }
  if (!Array.isArray(data) || !data.length) return null;
  return normalize(data);
}

async function fetchSlugSectionsFromUpstash(slug) {
  try {
    const raw = await getRedis().get(SLUG_REDIS_KEY(slug));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed;
  } catch (e) {
    console.warn('[sections-slug] Upstash read failed:', e.message);
    return null;
  }
}

async function saveSlugSectionsToUpstash(slug, sections) {
  try {
    await getRedis().set(SLUG_REDIS_KEY(slug), JSON.stringify(sections), { ex: SLUG_REDIS_TTL });
  } catch (e) {
    console.warn('[sections-slug] Upstash write failed:', e.message);
  }
}

// Returns per-slug sections OR default vertical sections.
// Only POSITIVE results are cached в SLUG_MEM — negative misses
// (file not yet committed / 404) re-attempted on next call. Иначе
// builder could write sections.json после bot cold start and bot
// would serve stale default forever.
export async function getSectionsForSlug(slug, vertical = DEFAULT_VERTICAL) {
  if (!slug) return getSections(vertical);
  const cached = SLUG_MEM.get(slug);
  if (cached) return cached;
  try {
    let sections = await fetchSlugSectionsFromUpstash(slug);
    if (!sections) {
      sections = await fetchSlugSectionsFromGitHub(slug);
      if (sections) await saveSlugSectionsToUpstash(slug, sections);
    }
    if (!sections) {
      // No per-slug file (yet) — fall back на default. НЕ кэшируем
      // negative — re-attempt next call (builder может позже залить файл).
      return getSections(vertical);
    }
    SLUG_MEM.set(slug, sections);
    return sections;
  } catch (e) {
    console.warn(`[sections-slug] failed for ${slug}, using default:`, e.message);
    return getSections(vertical);
  }
}

export async function getSectionByIdForSlug(slug, id, vertical = DEFAULT_VERTICAL) {
  // Re-uses getSectionsForSlug (которое handles cache + fallback правильно).
  const sections = await getSectionsForSlug(slug, vertical);
  return sections.find(s => s.id === id) || null;
}
