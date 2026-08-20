/**
 * Tests for content-based file type sniffing.
 *
 * The point of the module is that an unknown extension is no longer a dead end,
 * so the load-bearing cases are: `.jsh` (and friends) resolving to text via the
 * bytes, and the precedence rules that stop that permissiveness from
 * misidentifying binaries as prose.
 */

import { describe, expect, it } from 'vitest';
import {
  isTextMimeType,
  looksLikeText,
  richPreviewKind,
  sniffFileType,
  sniffMagicBytes,
} from '../../src/core/file-type.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe('sniffMagicBytes', () => {
  it('identifies a PNG', () => {
    expect(sniffMagicBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      'image/png'
    );
  });

  it('identifies a JPEG and a GIF', () => {
    expect(sniffMagicBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMagicBytes(utf8('GIF89a....'))).toBe('image/gif');
  });

  it('identifies a PDF', () => {
    expect(sniffMagicBytes(utf8('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('distinguishes the two RIFF containers rather than guessing', () => {
    // Both start with "RIFF"; only bytes 8..12 say which is which.
    const riff = (tag: string): Uint8Array => utf8(`RIFF${'\0'.repeat(4)}${tag}`);
    expect(sniffMagicBytes(riff('WEBP'))).toBe('image/webp');
    expect(sniffMagicBytes(riff('WAVE'))).toBe('audio/wav');
  });

  it('splits Ogg into audio and video by codec', () => {
    expect(sniffMagicBytes(utf8(`OggS${'\0'.repeat(24)}vorbis`))).toBe('audio/ogg');
    expect(sniffMagicBytes(utf8(`OggS${'\0'.repeat(24)}theora`))).toBe('video/ogg');
  });

  it('identifies wasm and archives so they never read as text', () => {
    expect(sniffMagicBytes(bytes(0x00, 0x61, 0x73, 0x6d, 0x01))).toBe('application/wasm');
    expect(sniffMagicBytes(utf8('PK\x03\x04'))).toBe('application/zip');
    expect(sniffMagicBytes(bytes(0x1f, 0x8b, 0x08))).toBe('application/gzip');
  });

  it('returns null for content with no signature', () => {
    expect(sniffMagicBytes(utf8('#!/usr/bin/env bash\n'))).toBeNull();
  });
});

describe('looksLikeText', () => {
  it('accepts plain source', () => {
    expect(looksLikeText(utf8('#!/usr/bin/env jsh\necho hi\n'))).toBe(true);
  });

  it('accepts an empty file', () => {
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
  });

  it('accepts multi-byte UTF-8', () => {
    expect(looksLikeText(utf8('const greeting = "héllo wörld — ✨";\n'))).toBe(true);
  });

  it('accepts tabs, newlines and ANSI escapes from terminal captures', () => {
    expect(looksLikeText(utf8('col1\tcol2\r\n[31mred[0m\n'))).toBe(true);
  });

  it('rejects content containing a NUL byte', () => {
    expect(looksLikeText(bytes(0x68, 0x69, 0x00, 0x68, 0x69))).toBe(false);
  });

  it('rejects invalid UTF-8', () => {
    expect(looksLikeText(bytes(0xc3, 0x28, 0xa0, 0xa1))).toBe(false);
  });

  it('rejects control-character soup that happens to avoid NUL', () => {
    expect(looksLikeText(Uint8Array.from({ length: 200 }, (_, i) => (i % 2 ? 0x01 : 0x02)))).toBe(
      false
    );
  });

  it('does not fail a large text file whose window ends mid-codepoint', () => {
    // Pad so the 4096-byte window slices a multi-byte character in half; that is
    // an artifact of where we stopped reading, not a decoding error.
    const padded = `${'a'.repeat(4095)}é${'b'.repeat(100)}`;
    expect(looksLikeText(utf8(padded))).toBe(true);
  });
});

describe('sniffFileType', () => {
  it('calls an unknown extension text when the bytes decode — the .jsh case', () => {
    const result = sniffFileType('/workspace/bb.jsh', utf8('#!/usr/bin/env jsh\necho hi\n'));
    expect(result.text).toBe(true);
    expect(result.mime).toBe('text/plain');
    expect(result.source).toBe('content');
  });

  it('still resolves known extensions from the table', () => {
    const result = sniffFileType('/a/b.json', utf8('{"a":1}'));
    expect(result.mime).toBe('application/json');
    expect(result.source).toBe('extension');
    expect(result.text).toBe(true);
  });

  it('lets magic bytes overrule a lying extension', () => {
    // A .txt full of PNG bytes must not be rendered as prose.
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
    const result = sniffFileType('/tmp/notes.txt', png);
    expect(result.mime).toBe('image/png');
    expect(result.source).toBe('magic');
    expect(result.text).toBe(false);
  });

  it('reports binary content under an unknown extension as opaque', () => {
    const result = sniffFileType('/tmp/blob.weird', bytes(0x00, 0x01, 0x02, 0x00, 0xff));
    expect(result.mime).toBe('application/octet-stream');
    expect(result.text).toBe(false);
  });

  it('degrades to the extension table when no bytes are supplied', () => {
    expect(sniffFileType('/a/b.css').mime).toBe('text/css');
    expect(sniffFileType('/a/b.jsh').source).toBe('unknown');
  });
});

describe('isTextMimeType', () => {
  it('accepts text/* and the structured formats that are text underneath', () => {
    for (const mime of [
      'text/plain',
      'text/markdown',
      'application/json',
      'application/xml',
      'application/javascript',
      'image/svg+xml',
      'application/ld+json',
    ]) {
      expect(isTextMimeType(mime)).toBe(true);
    }
  });

  it('tolerates a charset parameter', () => {
    expect(isTextMimeType('text/plain; charset=utf-8')).toBe(true);
  });

  it('rejects real binaries', () => {
    for (const mime of ['image/png', 'application/pdf', 'application/octet-stream', 'video/mp4']) {
      expect(isTextMimeType(mime)).toBe(false);
    }
  });
});

describe('richPreviewKind', () => {
  it('recognizes markdown by the only signal it has — the name', () => {
    // Sniffing cannot help here: markdown and plain text are byte-identical.
    for (const path of ['/w/README.md', '/w/notes.markdown', '/w/x.mkd']) {
      expect(richPreviewKind(path, 'text/plain')).toBe('markdown');
    }
  });

  it('recognizes HTML by type or by name', () => {
    expect(richPreviewKind('/w/page.html', 'text/html')).toBe('html');
    expect(richPreviewKind('/w/page.htm', 'text/plain')).toBe('html');
    expect(richPreviewKind('/w/page.html', 'text/html; charset=utf-8')).toBe('html');
  });

  it('leaves .mdx alone — a markdown parser would drop the half that matters', () => {
    expect(richPreviewKind('/w/doc.mdx', 'text/plain')).toBeNull();
  });

  it('offers nothing for files with only one form', () => {
    expect(richPreviewKind('/w/app.ts', 'text/plain')).toBeNull();
    expect(richPreviewKind('/w/photo.png', 'image/png')).toBeNull();
    expect(richPreviewKind('/w/Makefile', 'text/plain')).toBeNull();
  });
});
