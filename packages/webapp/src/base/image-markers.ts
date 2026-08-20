/**
 * `<img:data:…>` tool-output image markers — the one place that knows the
 * marker syntax and decides whether a marker is a real image.
 *
 * Lives in `base/` because every layer above it needs the same answer: the
 * bash tool must keep markers out of its byte cap (#2217), the agent adapter
 * turns them into image content blocks, the transcript limiter strips them,
 * and the chat row renders them inline. A marker that only *looks* like one
 * (prose quoting the syntax, a marker sliced in half by an upstream `head`)
 * must stay inert text everywhere rather than become a bogus image.
 */

/** MIME types the vision APIs accept. */
export const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function isSupportedImageFormat(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mimeType);
}

const IMAGE_MARKER_SOURCE = String.raw`<img:data:image\/[^>]+>`;
const IMAGE_MARKER_PREFIX = '<img:';
const BASE64_DELIMITER = ';base64,';

export interface ParsedImageMarker {
  dataUrl: string;
  mimeType: string;
  data: string;
}

export type ToolResultImageSegment = ParsedImageMarker & {
  type: 'image';
  marker: string;
};

export type ToolResultSegment = { type: 'text'; text: string } | ToolResultImageSegment;

/** Fresh per call because global regular expressions carry mutable `lastIndex` state. */
export function createImageMarkerRegex(): RegExp {
  return new RegExp(IMAGE_MARKER_SOURCE, 'g');
}

/** Parse the strict data-URL shape consumed by the agent adapter. */
export function parseImageMarker(marker: string): ParsedImageMarker | null {
  if (!marker.startsWith(IMAGE_MARKER_PREFIX) || !marker.endsWith('>')) return null;
  const dataUrl = marker.slice(IMAGE_MARKER_PREFIX.length, -1);
  const delimiterIndex = dataUrl.indexOf(BASE64_DELIMITER);
  if (delimiterIndex < 0) return null;
  const mimeType = dataUrl.slice('data:'.length, delimiterIndex);
  const data = dataUrl.slice(delimiterIndex + BASE64_DELIMITER.length);
  if (
    !dataUrl.startsWith('data:image/') ||
    mimeType.length === 'image/'.length ||
    mimeType.includes(';') ||
    !data
  )
    return null;
  return { dataUrl, mimeType, data };
}

function normalizedBase64(data: string): string | null {
  const compact = data.replace(/[\t\n\f\r ]/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const firstPadding = compact.indexOf('=');
  if (firstPadding >= 0 && firstPadding < compact.length - (compact.endsWith('==') ? 2 : 1)) {
    return null;
  }
  const unpaddedLength = firstPadding < 0 ? compact.length : firstPadding;
  if (unpaddedLength % 4 === 1 || (firstPadding >= 0 && compact.length % 4 !== 0)) return null;
  return compact;
}

/**
 * What a `<img:…>`-shaped match actually is:
 *
 * - `image` — well-formed marker in a MIME type the API accepts.
 * - `unsupported` — well-formed marker (real base64 payload) in a MIME type
 *   the API rejects. A tool did emit an image; the model gets a short
 *   placeholder instead of the payload.
 * - `inert` — not a marker at all: prose quoting the syntax, or a marker
 *   truncated mid-payload so the base64 no longer decodes. Left as text,
 *   because calling it an "unsupported image format" both lies about the
 *   cause and, for a half-marker, hides that output was cut.
 */
export type ImageMarkerKind = 'image' | 'unsupported' | 'inert';

export interface ClassifiedImageMarker {
  kind: ImageMarkerKind;
  marker: string;
  index: number;
  /** Set for `image` and `unsupported`; base64 normalized (whitespace stripped). */
  parsed: ParsedImageMarker | null;
}

/** Classify every marker-shaped match in `text`, in order. */
export function classifyImageMarkers(text: string): ClassifiedImageMarker[] {
  const found: ClassifiedImageMarker[] = [];
  for (const match of text.matchAll(createImageMarkerRegex())) {
    const marker = match[0];
    const index = match.index ?? 0;
    const parsed = parseImageMarker(marker);
    const data = parsed ? normalizedBase64(parsed.data) : null;
    if (!parsed || !data) {
      found.push({ kind: 'inert', marker, index, parsed: null });
      continue;
    }
    const normalized: ParsedImageMarker = {
      mimeType: parsed.mimeType,
      data,
      dataUrl: `data:${parsed.mimeType};base64,${data}`,
    };
    found.push({
      kind: isSupportedImageFormat(parsed.mimeType) ? 'image' : 'unsupported',
      marker,
      index,
      parsed: normalized,
    });
  }
  return found;
}

/** Split renderable image markers from text without dropping malformed markers. */
export function splitToolResultImages(text: string): ToolResultSegment[] {
  const segments: ToolResultSegment[] = [];
  let lastIndex = 0;
  for (const found of classifyImageMarkers(text)) {
    if (found.kind !== 'image' || !found.parsed) continue;
    if (found.index > lastIndex)
      segments.push({ type: 'text', text: text.slice(lastIndex, found.index) });
    segments.push({ type: 'image', marker: found.marker, ...found.parsed });
    lastIndex = found.index + found.marker.length;
  }
  if (lastIndex < text.length || segments.length === 0) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return segments;
}
