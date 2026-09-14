import { getMimeType } from './mime-types.js';

interface Signature {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly mime: string;

  readonly also?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ASCII = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { offset: 0, bytes: ASCII('GIF87a'), mime: 'image/gif' },
  { offset: 0, bytes: ASCII('GIF89a'), mime: 'image/gif' },
  { offset: 0, bytes: ASCII('BM'), mime: 'image/bmp' },
  {
    offset: 0,
    bytes: ASCII('RIFF'),
    also: { offset: 8, bytes: ASCII('WEBP') },
    mime: 'image/webp',
  },
  { offset: 4, bytes: ASCII('ftypavif'), mime: 'image/avif' },
  { offset: 0, bytes: [0x00, 0x00, 0x01, 0x00], mime: 'image/x-icon' },

  { offset: 0, bytes: ASCII('RIFF'), also: { offset: 8, bytes: ASCII('WAVE') }, mime: 'audio/wav' },
  { offset: 0, bytes: ASCII('ID3'), mime: 'audio/mpeg' },
  { offset: 0, bytes: ASCII('fLaC'), mime: 'audio/flac' },
  { offset: 4, bytes: ASCII('ftypM4A'), mime: 'audio/mp4' },

  { offset: 4, bytes: ASCII('ftypisom'), mime: 'video/mp4' },
  { offset: 4, bytes: ASCII('ftypmp42'), mime: 'video/mp4' },
  { offset: 4, bytes: ASCII('ftypqt'), mime: 'video/quicktime' },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' },

  { offset: 0, bytes: ASCII('%PDF-'), mime: 'application/pdf' },

  { offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d], mime: 'application/wasm' },
  { offset: 0, bytes: ASCII('PK\x03\x04'), mime: 'application/zip' },
  { offset: 0, bytes: [0x1f, 0x8b], mime: 'application/gzip' },
  { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], mime: 'application/x-executable' },
  { offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], mime: 'application/x-mach-binary' },
];

const OGG_MAGIC = ASCII('OggS');

function matchesAt(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (offset + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

export function sniffMagicBytes(data: Uint8Array): string | null {
  const ordered = [...SIGNATURES].sort(
    (a, b) =>
      b.bytes.length + (b.also?.bytes.length ?? 0) - (a.bytes.length + (a.also?.bytes.length ?? 0))
  );
  for (const sig of ordered) {
    if (!matchesAt(data, sig.offset, sig.bytes)) continue;
    if (sig.also && !matchesAt(data, sig.also.offset, sig.also.bytes)) continue;
    return sig.mime;
  }
  if (matchesAt(data, 0, OGG_MAGIC)) {
    const head = data.subarray(0, 64);
    const text = latin1(head);
    return /theora|VP8/.test(text) ? 'video/ogg' : 'audio/ogg';
  }
  return null;
}

function latin1(data: Uint8Array): string {
  let out = '';
  for (const byte of data) out += String.fromCharCode(byte);
  return out;
}

const TEXT_SNIFF_WINDOW = 4096;

export function looksLikeText(data: Uint8Array): boolean {
  if (data.length === 0) return true;

  const window = data.subarray(0, Math.min(data.length, TEXT_SNIFF_WINDOW));
  if (window.includes(0x00)) return false;

  let end = window.length;
  if (end === TEXT_SNIFF_WINDOW) {
    for (let back = 0; back < 4 && end > 0; back += 1) {
      const byte = window[end - 1] ?? 0;
      if ((byte & 0x80) === 0) break;
      end -= 1;
      if ((byte & 0xc0) === 0xc0) break;
    }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(window.subarray(0, end));
    let suspicious = 0;
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;

      if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c || code === 0x1b) {
        continue;
      }
      if (code < 0x20 || code === 0x7f) suspicious += 1;
    }
    return suspicious <= text.length * 0.05;
  } catch {
    return false;
  }
}

export interface SniffedType {
  mime: string;

  text: boolean;

  source: 'magic' | 'extension' | 'content' | 'unknown';
}

export function sniffFileType(path: string, data?: Uint8Array): SniffedType {
  if (data && data.length > 0) {
    const magic = sniffMagicBytes(data);
    if (magic) return { mime: magic, text: isTextMimeType(magic), source: 'magic' };
  }

  const byExtension = getMimeType(path);
  if (byExtension !== 'application/octet-stream') {
    return { mime: byExtension, text: isTextMimeType(byExtension), source: 'extension' };
  }

  if (data && looksLikeText(data)) {
    return { mime: 'text/plain', text: true, source: 'content' };
  }

  return { mime: 'application/octet-stream', text: false, source: data ? 'content' : 'unknown' };
}

export function isTextMimeType(mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  const base = mime.split(';', 1)[0]?.trim() ?? mime;
  return (
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'application/javascript' ||
    base === 'application/ecmascript' ||
    base === 'image/svg+xml' ||
    base.endsWith('+json') ||
    base.endsWith('+xml')
  );
}

export type RichPreviewKind = 'markdown' | 'html';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn']);

export function richPreviewKind(path: string, mime: string): RichPreviewKind | null {
  const base = mime.split(';', 1)[0]?.trim() ?? mime;
  if (base === 'text/html') return 'html';
  if (base === 'text/markdown' || base === 'text/x-markdown') return 'markdown';
  const dot = path.lastIndexOf('.');
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : '';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}
