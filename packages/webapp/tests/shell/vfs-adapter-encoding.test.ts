import 'fake-indexeddb/auto';
import { Buffer } from 'node:buffer';
import { Bash, type BufferEncoding, getCommandNames } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { cacheBinaryBody } from '../../src/shell/binary-cache.js';
import { stdinAsLatin1 } from '../../src/shell/just-bash-compat.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

let dbCounter = 0;
let vfs: VirtualFS;
let adapter: VfsAdapter;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `encoding-contract-${dbCounter++}`, wipe: true });
  adapter = new VfsAdapter(vfs);
  adapter.setRegisteredCommandsFn(() => getCommandNames());
});

afterEach(async () => {
  await vfs.dispose();
});

describe('filesystem byte and text contracts', () => {
  const encodings: BufferEncoding[] = [
    'utf8',
    'utf-8',
    'ascii',
    'binary',
    'latin1',
    'hex',
    'base64',
  ];

  it.each(encodings)('honors %s for writes, appends and reads', async (encoding) => {
    const text = encoding === 'hex' ? 'c3b6ff' : encoding === 'base64' ? 'w7b/' : 'ö你好';
    const expected = Buffer.from(text, encoding);
    await adapter.writeFile('/file', text, encoding);
    await adapter.appendFile('/file', text, { encoding });
    const combined = Buffer.concat([expected, expected]);
    expect(Array.from(await adapter.readFileBuffer('/file'))).toEqual(Array.from(combined));
    expect(await adapter.readFile('/file', encoding)).toBe(combined.toString(encoding));
    expect(await adapter.readFile('/file', { encoding })).toBe(combined.toString(encoding));
  });

  it('defaults to UTF-8 even when every character fits in Latin-1', async () => {
    cacheBinaryBody('ö', new Uint8Array([0xf6]));
    await adapter.writeFile('/file', 'ö');
    await adapter.appendFile('/file', 'é');
    expect(Array.from(await adapter.readFileBuffer('/file'))).toEqual([0xc3, 0xb6, 0xc3, 0xa9]);
    expect(await adapter.readFile('/file')).toBe('öé');
    expect(await adapter.readFile('/file', { encoding: null })).toBe('öé');
  });

  it('explicit text encoding takes precedence over a cached binary response', async () => {
    cacheBinaryBody('SGk=', new Uint8Array([83, 71, 107, 61]));
    await adapter.writeFile('/file', 'SGk=', { encoding: 'base64' });
    expect(await adapter.readFile('/file')).toBe('Hi');
  });

  it('exposes raw bytes including C1 values without UTF-8 or Windows-1252 decoding', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await adapter.writeFile('/file', bytes);
    const raw = stdinAsLatin1(await adapter.readFileBytes('/file'));
    expect(Array.from(raw, (char) => char.charCodeAt(0))).toEqual(Array.from(bytes));
    expect(await adapter.readFile('/file')).toBe(Buffer.from(bytes).toString('utf8'));
  });

  it('preserves byte-view boundaries regardless of encoding options', async () => {
    const bytes = new Uint8Array([99, 0xff, 0x80, 99]).subarray(1, 3);
    await adapter.writeFile('/file', bytes, 'utf8');
    await adapter.appendFile('/file', bytes, 'base64');
    expect(Array.from(await adapter.readFileBuffer('/file'))).toEqual([255, 128, 255, 128]);
  });

  it('reports missing raw-byte reads', async () => {
    await expect(adapter.readFileBytes('/absent')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves Unicode redirects and binary pipelines through the actual shell', async () => {
    const shell = new Bash({ fs: adapter, cwd: '/', defenseInDepth: false });
    const text = await shell.exec("echo 'ö你好' > /text; printf 'é' >> /text; cat /text");
    expect(text).toMatchObject({ exitCode: 0, stdout: 'ö你好\né', stderr: '' });
    const binary = await shell.exec("printf '/4AA' | base64 -d > /binary; cat /binary | base64");
    expect(binary).toMatchObject({ exitCode: 0, stdout: '/4AA\n', stderr: '' });
    expect(Array.from(await adapter.readFileBuffer('/binary'))).toEqual([255, 128, 0]);
  });
});
