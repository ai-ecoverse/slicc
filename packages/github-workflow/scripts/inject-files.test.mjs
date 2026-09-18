import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { countFiles, main, packDirectory } from './inject-files.mjs';

describe('inject-files', () => {
  let t;
  let src;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    src = join(t.root, 'src');
    mkdirSync(join(src, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(src, 'a.txt'), 'alpha');
    writeFileSync(join(src, 'nested', 'b.txt'), 'beta');
    writeFileSync(join(src, 'nested', 'deeper', 'c.bin'), Buffer.from([0, 1, 2, 255]));
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('packs a tree and unpacks it on the leader in one exec', () => {
    t.inputs({ source: src, target: '/workspace/inject' });
    const r = main();
    expect(r.files).toBe(3);
    expect(r.bytes).toBeGreaterThan(0);
    expect(readFileSync(join(t.vfs, 'workspace/inject/a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(t.vfs, 'workspace/inject/nested/b.txt'), 'utf8')).toBe('beta');
    expect([...readFileSync(join(t.vfs, 'workspace/inject/nested/deeper/c.bin'))]).toEqual([
      0, 1, 2, 255,
    ]);
    expect(t.calls()).toHaveLength(1);
    expect(t.outputs()).toEqual({ files: '3', bytes: String(r.bytes) });
    expect(existsSync(join(t.home, 'inject'))).toBe(true);
  });

  it('defaults the target to / and enforces the size cap', () => {
    t.inputs({ source: src, 'max-bytes': '10' });
    expect(() => main()).toThrow(/above the 10-byte cap/);
    t.inputs({ 'max-bytes': '' });
    main();
    expect(readFileSync(join(t.vfs, 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('rejects a non-directory source', () => {
    t.inputs({ source: join(src, 'a.txt') });
    expect(() => main()).toThrow(/not a directory/);
    t.inputs({ source: join(t.root, 'missing') });
    expect(() => main()).toThrow(/ENOENT/);
  });

  it('countFiles and packDirectory work standalone', () => {
    expect(countFiles(src)).toBe(3);
    const bytes = packDirectory(src, join(t.root, 'scratch'));
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });
});
