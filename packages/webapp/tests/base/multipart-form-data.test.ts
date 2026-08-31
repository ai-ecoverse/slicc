import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeMultipartFormData,
  encodeMultipartParts,
  generateMultipartBoundary,
  isFormDataBody,
} from '../../src/base/multipart-form-data.js';

const decoder = new TextDecoder('latin1');

/**
 * Parse the encoded bytes back with the platform's own multipart parser
 * (undici's, via `Response.formData()`). This is the assertion that matters:
 * a hand-rolled wire image can look plausible and still be unparseable by a
 * real server, which is the failure mode the issue reported as "awkward to
 * debug against a remote API".
 */
async function reparse(encoded: { bytes: Uint8Array; contentType: string }): Promise<FormData> {
  const response = new Response(encoded.bytes as unknown as BodyInit, {
    headers: { 'content-type': encoded.contentType },
  });
  return response.formData();
}

describe('generateMultipartBoundary', () => {
  it('stays inside the RFC 2046 length cap and uses only safe characters', () => {
    const boundary = generateMultipartBoundary();
    expect(boundary.length).toBeLessThanOrEqual(70);
    expect(boundary).toMatch(/^[0-9a-zA-Z'()+_,\-./:=?-]+$/);
  });

  it('does not repeat across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateMultipartBoundary()));
    expect(seen.size).toBe(50);
  });

  it('falls back to Math.random where crypto.getRandomValues is missing', () => {
    // Some kernel-worker / extension realms boot without a usable `crypto`;
    // a boundary must still be produced rather than throwing mid-upload.
    vi.stubGlobal('crypto', undefined);
    const boundary = generateMultipartBoundary();
    expect(boundary).toMatch(/^----SliccFormBoundary[0-9a-f]{32}$/);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe('isFormDataBody', () => {
  it('accepts a FormData and rejects everything else', () => {
    expect(isFormDataBody(new FormData())).toBe(true);
    expect(isFormDataBody(new URLSearchParams())).toBe(false);
    expect(isFormDataBody(new Blob(['x']))).toBe(false);
    expect(isFormDataBody('a=b')).toBe(false);
    expect(isFormDataBody(null)).toBe(false);
  });
});

describe('encodeMultipartParts', () => {
  it('emits the exact wire image for a text field and a file part', () => {
    const encoded = encodeMultipartParts(
      [
        { name: 'purpose', value: 'assistants' },
        {
          name: 'file',
          file: {
            bytes: new TextEncoder().encode('hello'),
            filename: 'hello.txt',
            contentType: 'text/plain',
          },
        },
      ],
      'BOUND'
    );

    expect(encoded.contentType).toBe('multipart/form-data; boundary=BOUND');
    expect(decoder.decode(encoded.bytes)).toBe(
      '--BOUND\r\n' +
        'Content-Disposition: form-data; name="purpose"\r\n' +
        '\r\n' +
        'assistants\r\n' +
        '--BOUND\r\n' +
        'Content-Disposition: form-data; name="file"; filename="hello.txt"\r\n' +
        'Content-Type: text/plain\r\n' +
        '\r\n' +
        'hello\r\n' +
        '--BOUND--\r\n'
    );
  });

  it('defaults a part with no content type to application/octet-stream', () => {
    const encoded = encodeMultipartParts(
      [{ name: 'f', file: { bytes: new Uint8Array([1]), filename: 'a.bin' } }],
      'B'
    );
    expect(decoder.decode(encoded.bytes)).toContain('Content-Type: application/octet-stream\r\n');
  });

  it('escapes quotes and newlines in names and filenames', () => {
    const encoded = encodeMultipartParts(
      [
        {
          name: 'ev"il\r\nX-Injected: 1',
          file: { bytes: new Uint8Array(), filename: 'a"b\nc.txt', contentType: 'text/plain' },
        },
      ],
      'B'
    );
    const wire = decoder.decode(encoded.bytes);
    expect(wire).toContain(
      'Content-Disposition: form-data; name="ev%22il%0D%0AX-Injected: 1"; filename="a%22b%0Ac.txt"'
    );
    expect(wire).not.toContain('\r\nX-Injected: 1');
  });

  it('strips CR/LF from a caller-supplied part content type', () => {
    const encoded = encodeMultipartParts(
      [
        {
          name: 'f',
          file: { bytes: new Uint8Array(), filename: 'a', contentType: 'text/plain\r\nX-Bad: 1' },
        },
      ],
      'B'
    );
    expect(decoder.decode(encoded.bytes)).toContain('Content-Type: text/plainX-Bad: 1\r\n\r\n');
  });

  it('normalizes lone CR and lone LF in a text value to CRLF', () => {
    const encoded = encodeMultipartParts([{ name: 'n', value: 'a\nb\rc\r\nd' }], 'B');
    expect(decoder.decode(encoded.bytes)).toContain('\r\na\r\nb\r\nc\r\nd\r\n--B--');
  });

  it('produces a body with only the terminator when there are no parts', () => {
    expect(decoder.decode(encodeMultipartParts([], 'B').bytes)).toBe('--B--\r\n');
  });
});

describe('encodeMultipartFormData', () => {
  it('round-trips string fields and a Blob part through a real parser', async () => {
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

    const encoded = await encodeMultipartFormData(form);
    expect(encoded.contentType).toBe(`multipart/form-data; boundary=${encoded.boundary}`);

    const parsed = await reparse(encoded);
    expect(parsed.get('purpose')).toBe('assistants');
    const file = parsed.get('file') as File;
    expect(file.name).toBe('hello.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('hello');
  });

  it('carries arbitrary binary bytes without corruption', async () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
    const form = new FormData();
    form.append('blob', new Blob([bytes]), 'raw.bin');

    const parsed = await reparse(await encodeMultipartFormData(form));
    const file = parsed.get('blob') as File;
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  it('preserves repeated field names in order', async () => {
    const form = new FormData();
    form.append('tag', 'one');
    form.append('tag', 'two');

    const parsed = await reparse(await encodeMultipartFormData(form));
    expect(parsed.getAll('tag')).toEqual(['one', 'two']);
  });

  it('names a Blob appended without a filename "blob"', async () => {
    const form = new FormData();
    form.append('f', new Blob(['x']));

    const parsed = await reparse(await encodeMultipartFormData(form));
    expect((parsed.get('f') as File).name).toBe('blob');
  });

  it('encodes non-ASCII field names and values as UTF-8', async () => {
    const form = new FormData();
    form.append('naïve', 'café ☕');

    const parsed = await reparse(await encodeMultipartFormData(form));
    expect(parsed.get('naïve')).toBe('café ☕');
  });

  it('accepts an explicit boundary so callers can pin the wire image', async () => {
    const form = new FormData();
    form.append('a', 'b');

    const encoded = await encodeMultipartFormData(form, 'PINNED');
    expect(encoded.boundary).toBe('PINNED');
    expect(decoder.decode(encoded.bytes)).toBe(
      '--PINNED\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--PINNED--\r\n'
    );
  });
});
