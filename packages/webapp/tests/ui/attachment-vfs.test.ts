// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  createAttachmentTmpWriter,
  makeAttachmentPath,
  sanitizeAttachmentName,
} from '../../src/ui/attachment-vfs.js';

describe('attachment-vfs', () => {
  describe('sanitizeAttachmentName', () => {
    it('preserves safe characters and dots', () => {
      expect(sanitizeAttachmentName('hello-world.v2.txt')).toBe('hello-world.v2.txt');
    });

    it('replaces spaces and slashes', () => {
      expect(sanitizeAttachmentName('my notes/draft 1.md')).toBe('my_notes_draft_1.md');
    });

    it('falls back to "attachment" for fully stripped names', () => {
      expect(sanitizeAttachmentName('***')).toBe('attachment');
    });
  });

  describe('makeAttachmentPath', () => {
    it('produces deterministic, collision-resistant /tmp paths', () => {
      const a = makeAttachmentPath('hello world.txt', 1, 1, 'abcd1234');
      const b = makeAttachmentPath('hello world.txt', 1, 2, 'abcd1234');
      expect(a).toMatch(/^\/tmp\/attachment-1-1-abcd1234-hello_world\.txt$/);
      expect(a).not.toBe(b);
    });

    it('disambiguates across writer instances via the random segment', () => {
      const a = makeAttachmentPath('same.txt', 1, 1, 'aaaaaaaa');
      const b = makeAttachmentPath('same.txt', 1, 1, 'bbbbbbbb');
      expect(a).not.toBe(b);
    });
  });

  describe('createAttachmentTmpWriter', () => {
    let dbCounter = 0;
    let fs: VirtualFS;

    beforeEach(async () => {
      dbCounter += 1;
      fs = await VirtualFS.create({ dbName: `attachment-vfs-${dbCounter}`, wipe: true });
    });

    afterEach(async () => {
      // Best-effort cleanup; ignore errors on already-removed dirs.
      await fs.rm('/tmp', { recursive: true }).catch(() => {});
      // Close IndexedDB connections / drop the fake-indexeddb DB to
      // avoid spurious AbortError rejections leaking between tests.
      await fs.dispose();
    });

    it('writes the file bytes into /tmp and returns the path', async () => {
      const writer = createAttachmentTmpWriter(fs);
      const file = new File([new Uint8Array([10, 20, 30, 40])], 'data.bin', {
        type: 'application/octet-stream',
      });

      const path = await writer(file);

      expect(path.startsWith('/tmp/')).toBe(true);
      const stored = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
      expect(Array.from(stored)).toEqual([10, 20, 30, 40]);
    });

    it('produces unique paths for two writes of the same file name', async () => {
      const writer = createAttachmentTmpWriter(fs);
      const file = new File(['x'], 'note.txt', { type: 'text/plain' });
      const a = await writer(file);
      const b = await writer(file);
      expect(a).not.toBe(b);
    });
  });
});
