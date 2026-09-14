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

describe('just-bash curl output patch — installed dist', () => {
  it.each([
    'dist/bundle/browser.js',
    'dist/bundle/index.cjs',
    'dist/bundle/chunks/curl-DEHFBW27.js',
  ])('%s skips stdout formatting for -o/-O', async (rel) => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL(`../../../../node_modules/just-bash/${rel}`, import.meta.url),
      'utf8'
    );
    expect(
      /\.useRemoteName\)&&![a-z]\.verbose\?"":/.test(src),
      `${rel} lacks the -o/-O stdout guard; patches/just-bash+*.patch is missing or failed to apply`
    ).toBe(true);
  });
});
