/**
 * Reading a page's Open Graph card out of its HTML.
 *
 * Deliberately a scan of `<meta>` tags rather than a DOM parse: it runs on
 * untrusted HTML fetched from wherever an agent pointed, and a regex over the
 * head never executes, loads or instantiates anything. It is also callable
 * from any realm, `DOMParser` or not.
 *
 * Only the head matters, so the scan stops at `</head>` (or a size cap when a
 * page has none) — a multi-megabyte body is never searched.
 */

/** The fields a link preview shows. All optional: pages publish what they like. */
export interface OpenGraphCard {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/** How much of a page is searched when it has no `</head>`. */
const MAX_SCAN_CHARS = 256 * 1024;

/** Longest title/description kept; the card clamps visually anyway. */
const MAX_FIELD_CHARS = 400;

const META_TAG_RE = /<meta\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Decode the entities that actually show up in meta content. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(ATTR_RE)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
}

/**
 * Resolve an image reference against the page URL, keeping only web URLs.
 * A `javascript:` or `data:` "image" is dropped rather than rendered.
 */
function resolveImage(raw: string | undefined, baseUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(decodeEntities(raw).trim(), baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the Open Graph card from `html`, falling back to Twitter card tags
 * and then to plain `<title>` / `description` meta.
 */
export function parseOpenGraph(html: string, baseUrl: string): OpenGraphCard {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = html.slice(0, headEnd >= 0 ? headEnd : MAX_SCAN_CHARS);

  const meta = new Map<string, string>();
  for (const match of head.matchAll(META_TAG_RE)) {
    const attrs = attributesOf(match[0]);
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    // First one wins: pages list the canonical image before alternates.
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value?.trim()) return value;
    }
    return undefined;
  };

  const card: OpenGraphCard = {};
  const title = clean(pick('og:title', 'twitter:title') ?? TITLE_RE.exec(head)?.[1]);
  const description = clean(pick('og:description', 'twitter:description', 'description'));
  const image = resolveImage(
    pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    baseUrl
  );
  const siteName = clean(pick('og:site_name', 'application-name'));
  if (title) card.title = title;
  if (description) card.description = description;
  if (image) card.image = image;
  if (siteName) card.siteName = siteName;
  return card;
}
