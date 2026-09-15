import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { main } from './vfs-file.mjs';

describe('vfs-file', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('writes inline text and reads it back byte-exact', () => {
    t.inputs({ mode: 'write', path: '/workspace/a/hello.txt', content: 'hi\nthere\n' });
    expect(main()).toBe(9);
    expect(readFileSync(join(t.vfs, 'workspace/a/hello.txt'), 'utf8')).toBe('hi\nthere\n');
    const local = join(t.root, 'out', 'hello.txt');
    t.inputs({ mode: 'read', path: '/workspace/a/hello.txt', local, content: '' });
    expect(main()).toBe(9);
    expect(readFileSync(local, 'utf8')).toBe('hi\nthere\n');
    expect(t.outputs().bytes).toBe('9');
    expect(t.outputs().local).toBe(local);
  });

  it('round-trips binary from a local file', () => {
    const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256));
    const src = join(t.root, 'rand.bin');
    writeFileSync(src, bin);
    t.inputs({ mode: 'write', path: '/data/rand.bin', local: src });
    expect(main()).toBe(4096);
    const back = join(t.root, 'back.bin');
    t.inputs({ mode: 'read', path: '/data/rand.bin', local: back });
    main();
    expect(readFileSync(back).equals(bin)).toBe(true);
  });

  it('fails on a missing VFS file, a bad mode, and an empty write', () => {
    mkdirSync(t.vfs, { recursive: true });
    t.inputs({ mode: 'read', path: '/nope.txt', local: join(t.root, 'x') });
    expect(() => main()).toThrow(/leader command failed \(status 1\)/);
    t.inputs({ mode: 'copy', path: '/x' });
    expect(() => main()).toThrow(/mode must be read\|write/);
    t.inputs({ mode: 'write', path: '/x', local: '', content: '' });
    expect(() => main()).toThrow(/needs `local` or `content`/);
    t.inputs({ mode: 'read', path: 'relative', local: '/tmp/x' });
    expect(() => main()).toThrow(/absolute VFS path/);
  });
});
