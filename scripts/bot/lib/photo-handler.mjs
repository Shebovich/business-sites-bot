// Classify incoming photo input (URL or TG file) and route to the appropriate
// downloader. M1: only classification + persistence to Redis. M2 actually
// invokes downloaders via the GitHub Actions builder-fix workflow.

import { URL_PATTERNS, detectUnsupportedHost } from '../config.mjs';
import { addPhoto } from './state.mjs';

export function classifyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (URL_PATTERNS.ig_highlight.test(url)) return 'ig_highlight';
  if (URL_PATTERNS.ig_reel.test(url))      return 'ig_reel';
  if (URL_PATTERNS.ig_post.test(url))      return 'ig_post';
  if (URL_PATTERNS.direct_video.test(url)) return 'direct_video';
  if (URL_PATTERNS.direct_image.test(url)) return 'direct_image';
  return null;
}

// Persist a URL-based photo input. M2 will pick it up and run the
// appropriate downloader (ig-download-posts.mjs / yt-dlp / curl).
//
// Wave 3 W11: fail-fast на explicit unsupported domains (Drive/Dropbox/etc).
// Returns reason='unsupported_domain' с serviceName чтобы commands.mjs мог
// показать friendly «Drive не поддерживается, скинь файлы напрямую» сообщение.
export async function persistUrlInput({ issueNumber, section, url, caption = '' }) {
  const unsupportedService = detectUnsupportedHost(url);
  if (unsupportedService) {
    return { ok: false, reason: 'unsupported_domain', service: unsupportedService };
  }
  const type = classifyUrl(url);
  if (!type) return { ok: false, reason: 'unrecognized_url' };
  await addPhoto(issueNumber, section, {
    source: 'url',
    type,
    url,
    caption,
    downloaded: false,
  });
  return { ok: true, type };
}

// Persist a TG-uploaded photo or video. M2 will call getFile + download.
export async function persistTgUpload({ issueNumber, section, fileId, kind, caption = '' }) {
  await addPhoto(issueNumber, section, {
    source: 'tg_upload',
    type: kind,    // 'photo' | 'video'
    file_id: fileId,
    caption,
    downloaded: false,
  });
  return { ok: true };
}
