// M3b — Q25/Q26.5: universal input parser for /scout.
//
// Accepts:
//   - 2GIS URL                 → {kind: '2gis', firmId}
//   - Google Maps URL          → {kind: 'google_maps', queryOrPlaceId}
//   - Yandex Maps URL          → {kind: 'yandex_maps', queryOrId}
//   - Instagram URL/handle     → {kind: 'instagram', handle}
//   - Existing website URL     → {kind: 'existing_website', url}
//   - Naked name (free text)   → {kind: 'name', value}
//
// The Claude Code skill picks up the issue and figures out the rest. This
// parser exists so the bot can at least put a meaningful title on the issue
// + flag `existing-site-replace` for own-website inputs.

const TWO_GIS_RE = /2gis\.(by|ru|com|kz|ua)\/[^\/?]+\/(?:firm|geo)\/(\d+)/i;
const GOOGLE_MAPS_RE = /(?:google\.[^\/]+\/maps|maps\.google|maps\.app\.goo\.gl)\b/i;
const YANDEX_MAPS_RE = /(?:yandex\.[^\/]+\/maps|maps\.yandex)\b/i;
const IG_HANDLE_RE = /^@?([a-zA-Z0-9_.]{2,30})$/;
const IG_URL_RE = /instagram\.com\/([a-zA-Z0-9_.]+)\/?/i;
// URL = scheme://host[…] — used only when a string starts with http(s).
const URL_RE = /^https?:\/\//i;

// Domains we consider "agency-managed" — incoming URLs pointing to these
// shouldn't be flagged as "client has their own site".
const OWN_AGENCY_HOSTS = new Set([
  'vercel.app', 'github.io', 'github.com',
]);

export function parseScoutInput(raw) {
  const input = (raw || '').trim();
  if (!input) return { kind: 'empty' };

  // 2GIS (most specific)
  const tg = input.match(TWO_GIS_RE);
  if (tg) return { kind: '2gis', firmId: tg[2], url: extractUrl(input) || input };

  // Google Maps
  if (GOOGLE_MAPS_RE.test(input) && URL_RE.test(input)) {
    return { kind: 'google_maps', url: input };
  }

  // Yandex Maps
  if (YANDEX_MAPS_RE.test(input) && URL_RE.test(input)) {
    return { kind: 'yandex_maps', url: input };
  }

  // Instagram URL
  const igUrl = input.match(IG_URL_RE);
  if (igUrl && URL_RE.test(input)) {
    return { kind: 'instagram', handle: igUrl[1], url: input };
  }

  // Generic URL → treat as own website (existing-site-replace) unless host
  // is in OWN_AGENCY_HOSTS.
  if (URL_RE.test(input)) {
    try {
      const u = new URL(input);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      const isAgency = [...OWN_AGENCY_HOSTS].some(h => host === h || host.endsWith('.' + h));
      if (isAgency) return { kind: 'unknown_url', url: input };
      return { kind: 'existing_website', url: input, host };
    } catch {
      return { kind: 'unknown_url', url: input };
    }
  }

  // @handle or bare handle (no spaces, only IG-allowed chars)
  if (IG_HANDLE_RE.test(input) && !input.includes(' ')) {
    const handle = input.replace(/^@/, '');
    // Heuristic: if it's clearly a domain-looking thing without scheme, fall
    // through to name. e.g. "skif.by" isn't a handle.
    if (handle.includes('.')) return { kind: 'name', value: input };
    return { kind: 'instagram', handle };
  }

  // Naked name — everything else.
  return { kind: 'name', value: input };
}

// Build the GitHub issue title + body for a scout request.
// Always tagged `[scout-request]` so /list filters can find them; Claude Code
// skill replaces title with real venue name when it processes `awaiting-scout`.
export function buildScoutIssue({ parsed, requesterName, requesterRole }) {
  const labels = ['awaiting-scout'];
  if (parsed.kind === 'existing_website') labels.push('existing-site-replace');

  let titleHint;
  switch (parsed.kind) {
    case '2gis':              titleHint = `2GIS firm/${parsed.firmId}`; break;
    case 'google_maps':       titleHint = 'Google Maps lookup'; break;
    case 'yandex_maps':       titleHint = 'Yandex Maps lookup'; break;
    case 'instagram':         titleHint = `IG @${parsed.handle}`; break;
    case 'existing_website':  titleHint = `existing site: ${parsed.host}`; break;
    case 'name':              titleHint = parsed.value.slice(0, 60); break;
    case 'unknown_url':       titleHint = `URL lookup`; break;
    default:                  titleHint = 'unknown'; break;
  }

  const title = `[scout-request] ${titleHint}`;
  const body = [
    `Requested by ${requesterName} (${requesterRole}) via TG bot.`,
    '',
    `Input kind: \`${parsed.kind}\``,
    parsed.url ? `URL: ${parsed.url}` : null,
    parsed.firmId ? `2GIS firm id: ${parsed.firmId}` : null,
    parsed.handle ? `IG handle: @${parsed.handle}` : null,
    parsed.host ? `Website host: ${parsed.host}` : null,
    parsed.value ? `Name: ${parsed.value}` : null,
    '',
    '**Action needed:** run `/process-tg-tasks` in Claude Code on owner laptop.',
    'Skill will verify the venue (rubric match, no-website check) and replace this title + body.',
  ].filter(Boolean).join('\n');

  return { title, body, labels };
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
}
