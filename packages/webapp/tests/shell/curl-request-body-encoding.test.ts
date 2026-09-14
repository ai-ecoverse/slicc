import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

let dbCounter = 0;
let fs: VirtualFS;
let proxyFetch: ReturnType<typeof vi.fn>;
let realFetch: typeof globalThis.fetch | undefined;
let realChrome: unknown;

const PAYLOAD = '{"body":"plan → build — ship ✓ café"}';
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

async function sentBytes(index = 0): Promise<Uint8Array> {
  expect(proxyFetch.mock.calls.length).toBeGreaterThan(index);
  const init = proxyFetch.mock.calls[index][1] as RequestInit;
  return new Uint8Array(await new Response(init.body).arrayBuffer());
}

function c1Chars(bytes: Uint8Array): number {
  let count = 0;
  for (const char of new TextDecoder().decode(bytes)) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x80 && code <= 0x9f) count++;
  }
  return count;
}

const URL = 'https://api.example.com/repos/o/r/issues/46';

async function post(args: string, shell = new AlmostBashShellHeadless({ fs })): Promise<void> {
  const result = await shell.executeCommand(`curl -s -X POST ${args} ${URL}`);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
}

beforeEach(async () => {
  fs = await VirtualFS.create({ dbName: `test-curl-body-${dbCounter++}`, wipe: true });
  realChrome = (globalThis as { chrome?: unknown }).chrome;
  realFetch = globalThis.fetch;

  (globalThis as { chrome?: unknown }).chrome = undefined;
  proxyFetch = vi.fn(
    async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  );
  (globalThis as { fetch: typeof globalThis.fetch }).fetch =
    proxyFetch as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  (globalThis as { chrome?: unknown }).chrome = realChrome;
  if (realFetch) (globalThis as { fetch: typeof globalThis.fetch }).fetch = realFetch;
  vi.restoreAllMocks();
  await fs.dispose();
});

describe('curl request bodies keep their bytes', () => {
  it('--data-binary @file with a UTF-8 JSON payload', async () => {
    await fs.writeFile('/workspace/body.json', PAYLOAD);
    await post("-H 'Content-Type: application/json' --data-binary @/workspace/body.json");
    expect(await sentBytes()).toEqual(utf8(PAYLOAD));
  });

  it('--data-binary @file whose bytes are not valid UTF-8, under a text Content-Type', async () => {
    const onDisk = new Uint8Array([...utf8(PAYLOAD), 0xff]);
    await fs.writeFile('/workspace/mixed.bin', onDisk);
    await post("-H 'Content-Type: application/json' --data-binary @/workspace/mixed.bin");
    const sent = await sentBytes();
    expect(sent).toEqual(onDisk);
    expect(c1Chars(sent)).toBe(0);
  });

  it('--data-binary @file with a UTF-8 payload, under a binary Content-Type', async () => {
    await fs.writeFile('/workspace/body.json', PAYLOAD);
    await post("-H 'Content-Type: application/octet-stream' --data-binary @/workspace/body.json");
    expect(await sentBytes()).toEqual(utf8(PAYLOAD));
  });

  it('-d @file strips newlines but keeps every other byte', async () => {
    await fs.writeFile('/workspace/lines.json', `${PAYLOAD}\n`);
    await post("-H 'Content-Type: application/json' -d @/workspace/lines.json");
    expect(await sentBytes()).toEqual(utf8(PAYLOAD));
  });

  it('--data-binary @file with binary content under a binary Content-Type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
    await fs.writeFile('/workspace/x.png', png);
    await post("-H 'Content-Type: application/octet-stream' --data-binary @/workspace/x.png");
    expect(await sentBytes()).toEqual(png);
  });

  it('inline -d with non-ASCII text', async () => {
    await post(`-H 'Content-Type: application/json' -d '${PAYLOAD}'`);
    expect(await sentBytes()).toEqual(utf8(PAYLOAD));
  });

  it('a read in an EARLIER command never answers for a later inline body', async () => {
    const shell = new AlmostBashShellHeadless({ fs });
    await fs.writeFile('/workspace/legacy.txt', new Uint8Array([0xe9]));
    await post("-H 'Content-Type: application/json' --data-binary @/workspace/legacy.txt", shell);
    expect(await sentBytes(0)).toEqual(new Uint8Array([0xe9]));
    await post(`-H 'Content-Type: application/json' -d 'é'`, shell);
    expect(await sentBytes(1)).toEqual(utf8('é'));
  });

  it('two files that read as the same string each still send their own bytes', async () => {
    await fs.writeFile('/workspace/latin1.txt', new Uint8Array([0xe9]));
    await fs.writeFile('/workspace/utf8.txt', utf8('é'));
    const shell = new AlmostBashShellHeadless({ fs });
    const result = await shell.executeCommand(
      `curl -s -X POST -H 'Content-Type: application/json' --data-binary @/workspace/latin1.txt ${URL} ` +
        `&& curl -s -X POST -H 'Content-Type: application/json' --data-binary @/workspace/utf8.txt ${URL}`
    );
    expect(result.exitCode).toBe(0);
    expect(await sentBytes(0)).toEqual(new Uint8Array([0xe9]));
    expect(await sentBytes(1)).toEqual(utf8('é'));
  });

  it('-T @file upload keeps its bytes', async () => {
    const onDisk = new Uint8Array([...utf8('note: a → b'), 0xfe]);
    await fs.writeFile('/workspace/upload.bin', onDisk);
    await post('-T /workspace/upload.bin');
    expect(await sentBytes()).toEqual(onDisk);
  });
});
