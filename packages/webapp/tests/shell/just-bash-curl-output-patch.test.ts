/**
 * Guard for `patches/just-bash+3.4.1.patch`: `curl -o`/`-O` must not
 * latin1-stringify the response body for a stdout it never prints. In the
 * browser that string (built by the `buffer` polyfill one `+=` per byte) cost
 * ~32 bytes of V8 heap per downloaded byte and crashed the leader tab on a
 * ~250 MB download. In Node the same code path goes through
 * `Buffer.prototype.toString('binary')`, which is what this test watches.
 */
import { Bash, type SecureFetch } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';

const payload = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) & 0xff);

function fetchStub(): SecureFetch {
  return async (url) => ({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/octet-stream' },
    body: payload,
    url,
  });
}

describe('just-bash curl output patch (just-bash@3.4.1)', () => {
  const toString = vi.spyOn(Buffer.prototype, 'toString');
  afterEach(() => toString.mockClear());

  const binaryDecodes = () =>
    toString.mock.calls.filter((c) => c[0] === 'binary' || c[0] === 'latin1').length;

  it('writes -o output from the raw bytes without decoding the body to a string', async () => {
    const b = new Bash({ fetch: fetchStub() });
    const result = await b.exec('curl -s -o /out.bin https://example.com/big.bin');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(Array.from(await b.fs.readFileBuffer('/out.bin'))).toEqual(Array.from(payload));
    expect(binaryDecodes()).toBe(0);
  });

  it('-O keeps the same fast path and -w still formats after the write', async () => {
    const b = new Bash({ fetch: fetchStub() });
    const result = await b.exec('cd / && curl -s -O -w "%{http_code}" https://example.com/big.bin');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('200');
    expect((await b.fs.readFileBuffer('/big.bin')).byteLength).toBe(payload.byteLength);
    expect(binaryDecodes()).toBe(0);
  });

  it('still prints the body to stdout when no output file is given', async () => {
    const b = new Bash({ fetch: fetchStub() });
    const result = await b.exec('curl -s https://example.com/big.bin > /copy.bin');
    expect(result.exitCode).toBe(0);
    expect(Array.from(await b.fs.readFileBuffer('/copy.bin'))).toEqual(Array.from(payload));
  });
});
