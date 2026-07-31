import { isSupportedImageFormat } from './image-processor.js';

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

/** Split renderable image markers from text without dropping malformed markers. */
export function splitToolResultImages(text: string): ToolResultSegment[] {
  const segments: ToolResultSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(createImageMarkerRegex())) {
    const marker = match[0];
    const parsed = parseImageMarker(marker);
    const data = parsed ? normalizedBase64(parsed.data) : null;
    if (!parsed || !data || !isSupportedImageFormat(parsed.mimeType)) continue;
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex)
      segments.push({ type: 'text', text: text.slice(lastIndex, matchIndex) });
    segments.push({
      type: 'image',
      marker,
      mimeType: parsed.mimeType,
      data,
      dataUrl: `data:${parsed.mimeType};base64,${data}`,
    });
    lastIndex = matchIndex + marker.length;
  }
  if (lastIndex < text.length || segments.length === 0) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return segments;
}
