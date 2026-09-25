import 'fake-indexeddb/auto';
import { type CommandContext, unsafeBytesFromLatin1 } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { createFsBridge } from '../../../src/kernel/realm/realm-fs-bridge.js';
import type { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { runCode } from './cjs-realm-harness.js';

let dbCounter = 0;
let vfs: VirtualFS;
let peer: VirtualFS;

beforeEach(async () => {
  const dbName = `realm-append-${dbCounter++}`;
  vfs = await VirtualFS.create({ dbName, wipe: true });
  peer = await VirtualFS.create({ dbName });
});
afterEach(async () => {
  await peer.dispose();
  await vfs.dispose();
});

function ctxFor(fs: VirtualFS): CommandContext {
  return {
    fs: new VfsAdapter(fs),
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: unsafeBytesFromLatin1(''),
  };
}

describe('realm fs.appendFile atomic RPC', () => {
  it('is a single vfs.appendFile round-trip, not exists/read/write', async () => {
    const calls: Array<{ channel: string; op: string }> = [];
    const rpc = {
      call: async (channel: string, op: string, args: unknown[]) => {
        calls.push({ channel, op });
        return args;
      },
    };
    const bridge = createFsBridge(rpc as unknown as RealmRpcClient, async () => new Response());
    await bridge.appendFile('/workspace/log.txt', 'A');
    await bridge.appendFile('/workspace/log.txt', new Uint8Array([66]));
    expect(calls).toEqual([
      { channel: 'vfs', op: 'appendFile' },
      { channel: 'vfs', op: 'appendFile' },
    ]);
  });

  it('Promise.all of two fs.promises.appendFile keeps both payloads', async () => {
    await vfs.writeFile('/workspace/log.txt', '');
    const out = await runCode(
      `const fs = require('fs').promises;
       await Promise.all([
         fs.appendFile('/workspace/log.txt', 'A'),
         fs.appendFile('/workspace/log.txt', 'B'),
       ]);
       const raw = await fs.readFile('/workspace/log.txt');
       const text = await fs.readFile('/workspace/log.txt', 'utf8');
       console.log(Buffer.isBuffer(raw) ? 'buf' : typeof raw, text);`,
      ctxFor(vfs)
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('buf AB');
  });

  it('preserves concurrent appends from two realms sharing a database', async () => {
    await vfs.writeFile('/workspace/file', 'start\n');
    const even = runCode(
      `const fs = require('fs').promises;
       await Promise.all(
         Array.from({ length: 20 }, (_, i) =>
           fs.appendFile('/workspace/file', String(i * 2) + '\\n')
         )
       );`,
      ctxFor(vfs)
    );
    const odd = runCode(
      `const fs = require('fs').promises;
       await Promise.all(
         Array.from({ length: 20 }, (_, i) =>
           fs.appendFile('/workspace/file', String(i * 2 + 1) + '\\n')
         )
       );`,
      ctxFor(peer)
    );
    const [left, right] = await Promise.all([even, odd]);
    expect(left.exitCode).toBe(0);
    expect(right.exitCode).toBe(0);
    const lines = (await vfs.readTextFile('/workspace/file')).trim().split('\n');
    expect(lines[0]).toBe('start');
    expect(
      lines
        .slice(1)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('creates a missing file and rejects directory appends', async () => {
    const created = await runCode(
      `const fs = require('fs');
       await fs.appendFile('/workspace/new.txt', 'hello');
       console.log(await fs.readFile('/workspace/new.txt'));`,
      ctxFor(vfs)
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout.trim()).toBe('hello');
    await vfs.mkdir('/workspace/dir');
    const dir = await runCode(
      `const fs = require('fs');
       try { await fs.appendFile('/workspace/dir', 'bad'); console.log('ok'); }
       catch (e) { console.log(e.code || e.message); }`,
      ctxFor(vfs)
    );
    expect(dir.exitCode).toBe(0);
    expect(dir.stdout.trim()).toMatch(/EISDIR|directory/i);
  });
});
