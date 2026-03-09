/**
 * Tests for VfsAdapter binary-aware file operations.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/index.js';
import { VfsAdapter } from './vfs-adapter.js';

describe('VfsAdapter', () => {
  let vfs: VirtualFS;
  let adapter: VfsAdapter;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-vfs-adapter-${dbCounter++}`,
      wipe: true,
    });
    adapter = new VfsAdapter(vfs);
  });

  describe('writeFile — binary detection', () => {
    it('writes ASCII text correctly', async () => {
      await adapter.writeFile('/test.txt', 'hello world');
      const content = await vfs.readFile('/test.txt', { encoding: 'binary' });
      const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content as string);
      // ASCII bytes should match character codes exactly
      expect(bytes[0]).toBe(104); // 'h'
      expect(bytes[4]).toBe(111); // 'o'
    });

    it('preserves latin1-encoded binary data (chars <= 0xFF)', async () => {
      // Simulate a latin1-encoded JPEG header
      const latin1 = String.fromCharCode(0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10);
      await adapter.writeFile('/image.jpg', latin1);
      const content = await vfs.readFile('/image.jpg', { encoding: 'binary' });
      const bytes = content instanceof Uint8Array ? content : new Uint8Array();
      expect(bytes[0]).toBe(0xFF);
      expect(bytes[1]).toBe(0xD8);
      expect(bytes[2]).toBe(0xFF);
      expect(bytes[3]).toBe(0xE0);
      expect(bytes[4]).toBe(0x00);
      expect(bytes[5]).toBe(0x10);
    });

    it('uses UTF-8 encoding for strings with chars > 0xFF', async () => {
      // String with emoji (codepoint > 0xFF) should use TextEncoder (UTF-8)
      const text = 'hello \u{1F600}'; // hello 😀
      await adapter.writeFile('/emoji.txt', text);
      const content = await vfs.readFile('/emoji.txt', { encoding: 'utf-8' });
      expect(content).toBe(text);
    });

    it('writes Uint8Array content directly', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      await adapter.writeFile('/binary.bin', bytes);
      const content = await vfs.readFile('/binary.bin', { encoding: 'binary' }) as Uint8Array;
      // LightningFS may return a view into a larger buffer, so compare actual bytes
      expect(content.length).toBe(bytes.length);
      expect(Array.from(content)).toEqual(Array.from(bytes));
    });
  });

  describe('appendFile — ENOENT handling', () => {
    it('creates file if it does not exist', async () => {
      await adapter.appendFile('/new.txt', 'content');
      const result = await adapter.readFile('/new.txt');
      expect(result).toContain('content');
    });

    it('appends to existing file', async () => {
      await adapter.writeFile('/existing.txt', 'hello');
      await adapter.appendFile('/existing.txt', ' world');
      const content = await vfs.readFile('/existing.txt', { encoding: 'binary' });
      const bytes = content instanceof Uint8Array ? content : new Uint8Array();
      const text = new TextDecoder('iso-8859-1').decode(bytes);
      expect(text).toBe('hello world');
    });

    it('throws on non-ENOENT errors (e.g., path is a directory)', async () => {
      await vfs.mkdir('/mydir', { recursive: true });
      await expect(adapter.appendFile('/mydir', 'data')).rejects.toThrow();
    });
  });

  describe('virtual /usr/bin directory', () => {
    beforeEach(() => {
      adapter.setRegisteredCommandsFn(() => ['ls', 'cat', 'node', 'git']);
    });

    it('exists returns true for /usr', async () => {
      expect(await adapter.exists('/usr')).toBe(true);
    });

    it('exists returns true for /usr/bin', async () => {
      expect(await adapter.exists('/usr/bin')).toBe(true);
    });

    it('exists returns true for /usr/bin/<registered command>', async () => {
      expect(await adapter.exists('/usr/bin/ls')).toBe(true);
      expect(await adapter.exists('/usr/bin/node')).toBe(true);
    });

    it('exists returns false for /usr/bin/<unknown command>', async () => {
      expect(await adapter.exists('/usr/bin/nonexistent')).toBe(false);
    });

    it('stat returns directory for /usr and /usr/bin', async () => {
      const usrStat = await adapter.stat('/usr');
      expect(usrStat.isDirectory).toBe(true);
      expect(usrStat.isFile).toBe(false);

      const binStat = await adapter.stat('/usr/bin');
      expect(binStat.isDirectory).toBe(true);
      expect(binStat.isFile).toBe(false);
    });

    it('stat returns file for /usr/bin/<registered command>', async () => {
      const s = await adapter.stat('/usr/bin/ls');
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
      expect(s.mode).toBe(0o755);
    });

    it('readdir /usr returns ["bin"]', async () => {
      const entries = await adapter.readdir('/usr');
      expect(entries).toEqual(['bin']);
    });

    it('readdir /usr/bin returns sorted registered commands', async () => {
      const entries = await adapter.readdir('/usr/bin');
      expect(entries).toEqual(['cat', 'git', 'ls', 'node']);
    });

    it('readdirWithFileTypes /usr/bin returns file entries', async () => {
      const entries = await adapter.readdirWithFileTypes('/usr/bin');
      expect(entries.length).toBe(4);
      expect(entries[0]).toEqual({ name: 'cat', isFile: true, isDirectory: false, isSymbolicLink: false });
    });

    it('readdirWithFileTypes /usr returns directory entry for bin', async () => {
      const entries = await adapter.readdirWithFileTypes('/usr');
      expect(entries).toEqual([{ name: 'bin', isFile: false, isDirectory: true, isSymbolicLink: false }]);
    });

    it('works without setRegisteredCommandsFn (empty list)', async () => {
      const freshAdapter = new VfsAdapter(vfs);
      const entries = await freshAdapter.readdir('/usr/bin');
      expect(entries).toEqual([]);
      expect(await freshAdapter.exists('/usr/bin')).toBe(true);
    });
  });
});
