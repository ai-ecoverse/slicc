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
      backend: 'indexeddb',
      dbName: `test-vfs-adapter-${dbCounter++}`,
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
      const content = await vfs.readFile('/binary.bin', { encoding: 'binary' });
      expect(content).toEqual(bytes);
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
});
