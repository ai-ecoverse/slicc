import { normalizeBase64 } from '@slicc/shared-ts';

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

export function createImageMarkerRegex(): RegExp {
  return new RegExp(IMAGE_MARKER_SOURCE, 'g');
}

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

export type ImageMarkerKind = 'image' | 'unsupported' | 'inert';

export interface ClassifiedImageMarker {
  kind: ImageMarkerKind;
  marker: string;
  index: number;

  parsed: ParsedImageMarker | null;
}

export function classifyImageMarkers(text: string): ClassifiedImageMarker[] {
  const found: ClassifiedImageMarker[] = [];
  for (const match of text.matchAll(createImageMarkerRegex())) {
    const marker = match[0];
    const index = match.index ?? 0;
    const parsed = parseImageMarker(marker);
    const data = parsed ? normalizeBase64(parsed.data) : null;
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
