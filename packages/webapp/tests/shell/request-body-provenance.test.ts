/**
 * Byte provenance for VFS reads that become request bodies, and the two
 * decisions it takes out of the Content-Type's hands (see
 * `src/shell/request-body-provenance.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getFetchBodyBytes } from '../../src/shell/fetch-body.js';
import { prepareRequestBody, resolveExactRequestBody } from '../../src/shell/proxied-fetch.js';
import {
  clearReadByteProvenance,
  lookupReadBytes,
  parkReadBytes,
} from '../../src/shell/request-body-provenance.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The string a latin1 (one char per byte) read of `bytes` returns. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

async function bodyBytes(body: BodyInit | undefined): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

afterEach(() => {
  clearReadByteProvenance();
});

describe('parkReadBytes', () => {
  it('recovers the exact bytes a decoded string came from', () => {
    const bytes = utf8('plan → ship');
    parkReadBytes('plan → ship', bytes);
    expect(lookupReadBytes('plan → ship')).toBe(bytes);
  });

  it('does not park an all-ASCII read — latin1 and UTF-8 agree on it', () => {
    parkReadBytes('plain ascii', utf8('plain ascii'));
    expect(lookupReadBytes('plain ascii')).toBeNull();
  });

  it('does not park an empty read', () => {
    parkReadBytes('', new Uint8Array(0));
    expect(lookupReadBytes('')).toBeNull();
  });

  it('also parks the newline-free form, which is what `curl -d @file` sends', () => {
    const bytes = utf8('a → 1\nb → 2\r\n');
    parkReadBytes('a → 1\nb → 2\r\n', bytes);
    const stripped = lookupReadBytes('a → 1b → 2');
    expect(stripped).not.toBeNull();
    expect(Array.from(stripped as Uint8Array)).toEqual(Array.from(utf8('a → 1b → 2')));
  });

  it('keeps the entry available for repeated lookups (a redirect re-sends the body)', () => {
    parkReadBytes('é', utf8('é'));
    expect(lookupReadBytes('é')).not.toBeNull();
    expect(lookupReadBytes('é')).not.toBeNull();
  });

  it('refuses a read past the parking budget', () => {
    const huge = new Uint8Array(9 * 1024 * 1024);
    huge.fill(0xc3);
    parkReadBytes('past the budget', huge);
    expect(lookupReadBytes('past the budget')).toBeNull();
  });

  it('evicts oldest-first once the budget is spent', () => {
    const chunk = (fill: number): Uint8Array => {
      const bytes = new Uint8Array(3 * 1024 * 1024);
      bytes.fill(fill);
      return bytes;
    };
    const first = chunk(0x81);
    const second = chunk(0x82);
    const third = chunk(0x83);
    parkReadBytes('first', first);
    parkReadBytes('second', second);
    parkReadBytes('third', third);
    expect(lookupReadBytes('first')).toBeNull();
    expect(lookupReadBytes('third')).toBe(third);
  });

  it('does not report a string it never parked', () => {
    expect(lookupReadBytes('never read')).toBeNull();
  });

  it('stops resolving a string two reads decoded from different bytes', () => {
    // A latin1 file holding `E9` and a UTF-8 file holding `C3 A9` both read as
    // "é". Neither can claim a body typed as "é", so the string goes quiet.
    parkReadBytes('é', new Uint8Array([0xe9]));
    parkReadBytes('é', utf8('é'));
    expect(lookupReadBytes('é')).toBeNull();
  });

  it('keeps resolving when the same file is read twice', () => {
    parkReadBytes('é', utf8('é'));
    parkReadBytes('é', utf8('é'));
    expect(Array.from(lookupReadBytes('é') as Uint8Array)).toEqual(Array.from(utf8('é')));
  });

  it('stays quiet for a poisoned string even if a third read follows', () => {
    parkReadBytes('é', new Uint8Array([0xe9]));
    parkReadBytes('é', utf8('é'));
    parkReadBytes('é', new Uint8Array([0xe9]));
    expect(lookupReadBytes('é')).toBeNull();
  });
});

describe('resolveExactRequestBody', () => {
  it('swaps a parked string for its bytes', () => {
    const bytes = utf8('café → ok');
    parkReadBytes('café → ok', bytes);
    expect(resolveExactRequestBody('café → ok')).toBe(bytes);
  });

  it('leaves an unparked string, bytes and undefined alone', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(resolveExactRequestBody('hand-typed')).toBe('hand-typed');
    expect(resolveExactRequestBody(bytes)).toBe(bytes);
    expect(resolveExactRequestBody(undefined)).toBeUndefined();
    expect(resolveExactRequestBody('')).toBe('');
  });
});

describe('prepareRequestBody with a parked read', () => {
  it('sends a payload that is not valid UTF-8 verbatim under a text Content-Type', async () => {
    // A UTF-8 JSON body plus one stray byte: the read falls back to latin1 for
    // the whole file, and UTF-8-encoding that string would double-encode every
    // arrow (`E2 86 92` → `C3 A2 C2 86 C2 92`).
    const onDisk = new Uint8Array([...utf8('{"note":"a → b"}'), 0xff]);
    const asRead = latin1(onDisk);
    parkReadBytes(asRead, onDisk);
    const prepared = prepareRequestBody(asRead, { 'Content-Type': 'application/json' });
    expect(await bodyBytes(prepared)).toEqual(onDisk);
  });

  it('sends valid UTF-8 verbatim under a binary Content-Type', async () => {
    const onDisk = utf8('{"note":"a → b"}');
    parkReadBytes('{"note":"a → b"}', onDisk);
    const prepared = prepareRequestBody('{"note":"a → b"}', {
      'Content-Type': 'application/octet-stream',
    });
    expect(await bodyBytes(prepared)).toEqual(onDisk);
  });

  it('falls back to the Content-Type convention for an unparked string', async () => {
    const prepared = prepareRequestBody('{"note":"a → b"}', {
      'Content-Type': 'application/json',
    });
    expect(prepared).toBe('{"note":"a → b"}');
  });
});

describe('getFetchBodyBytes', () => {
  it('reads a latin1 byte string one byte per char', () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x41]);
    expect(Array.from(getFetchBodyBytes(latin1(bytes)))).toEqual(Array.from(bytes));
  });

  it('UTF-8-encodes a string that cannot be a byte string instead of masking it', () => {
    // `→` is U+2192; masking it to `0x92` was silent corruption.
    expect(Array.from(getFetchBodyBytes('→'))).toEqual([0xe2, 0x86, 0x92]);
  });

  it('passes bytes through untouched', () => {
    const bytes = new Uint8Array([0xff, 0xd8]);
    expect(getFetchBodyBytes(bytes)).toBe(bytes);
  });
});
