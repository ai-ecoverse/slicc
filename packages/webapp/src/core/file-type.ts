/**
 * Content-based file type sniffing — the `file(1)` of the VFS.
 *
 * `getMimeType()` (mime-types.ts) maps an extension to a Content-Type for
 * SERVING bytes over HTTP, where guessing wrong is a correctness bug and
 * `application/octet-stream` is the right conservative answer. That makes it the
 * wrong tool for deciding whether a human can READ a file: every extension the
 * table has never heard of — `.jsh`, `.mjsh`, `.runbook`, a `Justfile` — comes
 * back as octet-stream and the previewer gives up, even though the bytes are
 * plainly UTF-8 text.
 *
 * This module answers the other question — "what IS this?" — by looking at the
 * bytes the way `/usr/bin/file` does:
 *
 *   1. **Magic bytes** win outright. A PNG is a PNG whatever the name says, and
 *      a mislabeled `.txt` that starts with `%PDF-` must not render as prose.
 *   2. **Extension** breaks ties for formats with no usable signature (`.css`,
 *      `.json`, `.svg`) — a name is decent evidence, just not proof.
 *   3. **UTF-8 decodability** is the fallback, and it is the whole point: bytes
 *      that decode cleanly and carry no NUL / control-character soup are text,
 *      so unknown extensions preview instead of hitting a dead end.
 *
 * Only step 3 is new capability; steps 1-2 exist to stop it from being wrong.
 * Nothing here is used to set a Content-Type header — sniffing a type you then
 * serve to a browser is how MIME-confusion bugs happen. Preview only.
 */

import { getMimeType } from './mime-types.js';

/**
 * A magic-byte signature. `offset` is where `bytes` must appear; `mime` is what
 * that proves. Ordered longest-and-most-specific first at match time so a
 * generic RIFF container can't shadow the WEBP that lives inside it.
 */
interface Signature {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly mime: string;
  /** Extra bytes that must also match, for container formats (RIFF, ftyp). */
  readonly also?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ASCII = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/**
 * Signatures we can assert from bytes alone. Deliberately not exhaustive: this
 * covers what the previewer can actually RENDER (images, audio, video, PDF)
 * plus the archive/executable families that must be recognized precisely so
 * they are never mistaken for text.
 */
const SIGNATURES: readonly Signature[] = [
  // -- images --
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

  // -- audio --
  { offset: 0, bytes: ASCII('RIFF'), also: { offset: 8, bytes: ASCII('WAVE') }, mime: 'audio/wav' },
  { offset: 0, bytes: ASCII('ID3'), mime: 'audio/mpeg' },
  { offset: 0, bytes: ASCII('fLaC'), mime: 'audio/flac' },
  { offset: 4, bytes: ASCII('ftypM4A'), mime: 'audio/mp4' },

  // -- video --
  { offset: 4, bytes: ASCII('ftypisom'), mime: 'video/mp4' },
  { offset: 4, bytes: ASCII('ftypmp42'), mime: 'video/mp4' },
  { offset: 4, bytes: ASCII('ftypqt'), mime: 'video/quicktime' },
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm' },

  // -- documents --
  { offset: 0, bytes: ASCII('%PDF-'), mime: 'application/pdf' },

  // -- opaque binaries: recognized so they are never sniffed as text --
  { offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d], mime: 'application/wasm' },
  { offset: 0, bytes: ASCII('PK\x03\x04'), mime: 'application/zip' },
  { offset: 0, bytes: [0x1f, 0x8b], mime: 'application/gzip' },
  { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], mime: 'application/x-executable' },
  { offset: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], mime: 'application/x-mach-binary' },
];

/**
 * Ogg is a container: the codec inside decides audio vs video, and the answer
 * sits ~28 bytes in rather than at a fixed signature offset. Checked separately
 * so the table above stays a pure offset/bytes lookup.
 */
const OGG_MAGIC = ASCII('OggS');

function matchesAt(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (offset + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** The MIME type proven by `data`'s leading bytes, or `null` if nothing matches. */
export function sniffMagicBytes(data: Uint8Array): string | null {
  // RIFF/ftyp entries carry an `also` clause, so a bare "RIFF" prefix can't
  // claim WEBP when the payload is actually WAVE. Longest signature first keeps
  // `ftypM4A` from losing to a shorter `ftyp*` neighbour.
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
    // The codec name sits in the first page's segment table. "theora"/"VP8"
    // mean video; anything else (vorbis, opus, FLAC) is audio.
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

/**
 * How many leading bytes the text heuristic inspects. `file(1)` reads a similar
 * fixed-size window rather than the whole file: a 40 MB log is text if its first
 * page is, and scanning all of it to say so would stall the preview.
 */
const TEXT_SNIFF_WINDOW = 4096;

/**
 * Whether `data` looks like human-readable text.
 *
 * Two rules, both borrowed from `file(1)`:
 *
 *  - **A NUL byte means binary.** No text encoding this previewer can render
 *    emits one, and it is the single most reliable binary tell. (UTF-16 trips
 *    this, which is correct: the previewer decodes UTF-8, so UTF-16 must not be
 *    handed to it as prose.)
 *  - **The bytes must decode as strict UTF-8** and be mostly printable. Control
 *    characters other than tab/newline/carriage-return/form-feed/escape are
 *    allowed only in trace amounts, so a binary that happens to avoid NUL for
 *    4 KB still fails.
 *
 * A truncated multi-byte sequence at the window edge is not evidence of binary,
 * so the window is trimmed back to a codepoint boundary before decoding.
 */
export function looksLikeText(data: Uint8Array): boolean {
  if (data.length === 0) return true; // an empty file previews fine as empty text

  const window = data.subarray(0, Math.min(data.length, TEXT_SNIFF_WINDOW));
  if (window.includes(0x00)) return false;

  // Trim a multi-byte sequence cut in half by the window edge — that is an
  // artifact of where we stopped reading, not a decoding failure.
  let end = window.length;
  if (end === TEXT_SNIFF_WINDOW) {
    for (let back = 0; back < 4 && end > 0; back += 1) {
      const byte = window[end - 1] ?? 0;
      if ((byte & 0x80) === 0) break; // ASCII: already on a boundary
      end -= 1;
      if ((byte & 0xc0) === 0xc0) break; // reached the lead byte
    }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(window.subarray(0, end));
    let suspicious = 0;
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      // Tab, LF, CR, FF and ESC are ordinary in source and terminal captures.
      if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c || code === 0x1b) {
        continue;
      }
      if (code < 0x20 || code === 0x7f) suspicious += 1;
    }
    return suspicious <= text.length * 0.05;
  } catch {
    return false; // not valid UTF-8
  }
}

/** What `sniffFileType` concluded, and how much it trusted the answer. */
export interface SniffedType {
  /** The resolved MIME type — `application/octet-stream` only when truly unknown. */
  mime: string;
  /** Whether the content can be shown as text. */
  text: boolean;
  /** How the type was determined. */
  source: 'magic' | 'extension' | 'content' | 'unknown';
}

/**
 * Identify a file from its path AND its bytes.
 *
 * Pass whatever prefix of the file is cheap to read — 4 KB is plenty; passing
 * the whole buffer is fine but buys nothing. With no bytes at all this degrades
 * to the extension table, which is exactly the old behavior.
 *
 * The precedence (magic → extension → content) is what keeps the permissive
 * text fallback safe: a `.txt` full of PNG bytes is reported as an image, and
 * only files that NOTHING else identifies get the "does it decode?" treatment.
 */
export function sniffFileType(path: string, data?: Uint8Array): SniffedType {
  if (data && data.length > 0) {
    const magic = sniffMagicBytes(data);
    if (magic) return { mime: magic, text: isTextMimeType(magic), source: 'magic' };
  }

  const byExtension = getMimeType(path);
  if (byExtension !== 'application/octet-stream') {
    return { mime: byExtension, text: isTextMimeType(byExtension), source: 'extension' };
  }

  // The extension table has never heard of this one. Ask the bytes — this is
  // the branch that makes `.jsh` (and every future unknown) previewable.
  if (data && looksLikeText(data)) {
    return { mime: 'text/plain', text: true, source: 'content' };
  }

  return { mime: 'application/octet-stream', text: false, source: data ? 'content' : 'unknown' };
}

/**
 * Whether a MIME type carries text.
 *
 * `text/*` is the obvious half. The rest are the structured formats that are
 * text underneath but are registered under `application/` for historical
 * reasons — JSON, XML, JavaScript, SVG — which a previewer should render as
 * source rather than refuse.
 */
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

/**
 * File types that have a RENDERED form as well as a source form.
 *
 * Markdown and HTML are the two a transcript actually produces: an agent writes
 * a report and the user wants to read it, then wants to check what was written.
 * Neither view is the true one, so the previewer offers both (see
 * `slicc-quick-look`'s `rendered` option).
 */
export type RichPreviewKind = 'markdown' | 'html';

/**
 * Extensions that DECLARE markdown.
 *
 * The rest of this module answers "what is this?" from bytes on purpose, and
 * this is the honest exception: markdown has no signature, and a markdown file
 * and a text file are byte-identical until someone says otherwise. The name is
 * that statement. Being wrong costs only which of two views opens first, never
 * whether the file previews — the source view is always there.
 *
 * `.mdx` is absent: it is JSX in markdown clothing, and rendering it with a
 * plain markdown parser silently drops the half that matters.
 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn']);

/**
 * Whether `path`/`mime` name a file worth rendering, and how.
 *
 * `null` means "source only" — every other text file, which has no second form
 * to show.
 */
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
