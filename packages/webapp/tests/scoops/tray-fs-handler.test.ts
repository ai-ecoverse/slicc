import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { handleFsRequest, uint8ToBase64, base64ToUint8 } from '../../src/scoops/tray-fs-handler.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type {
  TrayFsRequest,
  TrayFsResponse,
  TrayFsResponseData,
} from '../../src/scoops/tray-sync-protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let vfs: VirtualFS;
let dbCounter = 0;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `test-fs-handler-${dbCounter++}`, wipe: true });
});

afterEach(async () => {
  await vfs.dispose();
});

function firstOk(responses: TrayFsResponse[]): TrayFsResponseData {
  expect(responses).toHaveLength(1);
  expect(responses[0].ok).toBe(true);
  if (!responses[0].ok) throw new Error('Expected ok response');
  return responses[0].data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tray-fs-handler', () => {
  describe('readFile', () => {
    it('reads a text file as utf-8', async () => {
      await vfs.writeFile('/hello.txt', 'Hello, world!');

      const responses = await handleFsRequest(vfs, { op: 'readFile', path: '/hello.txt' });
      const data = firstOk(responses);

      expect(data).toEqual({ type: 'file', content: 'Hello, world!', encoding: 'utf-8' });
    });

    it('reads a binary file as base64', async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      await vfs.writeFile('/image.png', bytes);

      const responses = await handleFsRequest(vfs, {
        op: 'readFile',
        path: '/image.png',
        encoding: 'binary',
      });
      const data = firstOk(responses);

      expect(data.type).toBe('file');
      if (data.type === 'file') {
        expect(data.encoding).toBe('base64');
        const decoded = base64ToUint8(data.content);
        expect(decoded).toEqual(bytes);
      }
    });

    it('returns error for non-existent file', async () => {
      const responses = await handleFsRequest(vfs, { op: 'readFile', path: '/nope.txt' });
      expect(responses).toHaveLength(1);
      expect(responses[0].ok).toBe(false);
      if (!responses[0].ok) {
        expect(responses[0].code).toBe('ENOENT');
      }
    });

    it('chunks large files', async () => {
      // Create content larger than the serialized chunk threshold.
      const largeContent = 'x'.repeat(100_000);
      await vfs.writeFile('/large.txt', largeContent);

      const responses = await handleFsRequest(vfs, { op: 'readFile', path: '/large.txt' });
      expect(responses.length).toBeGreaterThan(1);

      // All responses should be ok with chunk metadata
      for (let i = 0; i < responses.length; i++) {
        const r = responses[i];
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.chunkIndex).toBe(i);
          expect(r.totalChunks).toBe(responses.length);
          expect(r.data.type).toBe('file');
        }
      }

      // Reassemble and verify
      let reassembled = '';
      for (const r of responses) {
        if (r.ok && r.data.type === 'file') {
          reassembled += r.data.content;
        }
      }
      expect(reassembled).toBe(largeContent);
    });
  });

  describe('writeFile', () => {
    it('writes a text file', async () => {
      const responses = await handleFsRequest(vfs, {
        op: 'writeFile',
        path: '/out.txt',
        content: 'written!',
        encoding: 'utf-8',
      });
      const data = firstOk(responses);
      expect(data).toEqual({ type: 'void' });

      const content = await vfs.readFile('/out.txt', { encoding: 'utf-8' });
      expect(content).toBe('written!');
    });

    it('writes a binary file from base64', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const b64 = uint8ToBase64(bytes);

      const responses = await handleFsRequest(vfs, {
        op: 'writeFile',
        path: '/bin.dat',
        content: b64,
        encoding: 'base64',
      });
      const data = firstOk(responses);
      expect(data).toEqual({ type: 'void' });

      const readBack = await vfs.readFile('/bin.dat', { encoding: 'binary' });
      expect(new Uint8Array(readBack as Uint8Array)).toEqual(bytes);
    });

    it('creates parent directories automatically', async () => {
      const responses = await handleFsRequest(vfs, {
        op: 'writeFile',
        path: '/deep/nested/file.txt',
        content: 'deep',
        encoding: 'utf-8',
      });
      expect(responses[0].ok).toBe(true);

      const content = await vfs.readFile('/deep/nested/file.txt', { encoding: 'utf-8' });
      expect(content).toBe('deep');
    });
  });

  describe('stat', () => {
    it('returns file stats', async () => {
      await vfs.writeFile('/myfile.txt', 'content');

      const responses = await handleFsRequest(vfs, { op: 'stat', path: '/myfile.txt' });
      const data = firstOk(responses);
      expect(data.type).toBe('stat');
      if (data.type === 'stat') {
        expect(data.stat.type).toBe('file');
        expect(data.stat.size).toBeGreaterThan(0);
      }
    });

    it('returns directory stats', async () => {
      await vfs.mkdir('/mydir');

      const responses = await handleFsRequest(vfs, { op: 'stat', path: '/mydir' });
      const data = firstOk(responses);
      expect(data.type).toBe('stat');
      if (data.type === 'stat') {
        expect(data.stat.type).toBe('directory');
      }
    });

    it('returns error for non-existent path', async () => {
      const responses = await handleFsRequest(vfs, { op: 'stat', path: '/nonexistent' });
      expect(responses[0].ok).toBe(false);
      if (!responses[0].ok) {
        expect(responses[0].code).toBe('ENOENT');
      }
    });
  });

  describe('readDir', () => {
    it('lists directory entries', async () => {
      await vfs.writeFile('/dir/a.txt', 'a');
      await vfs.writeFile('/dir/b.txt', 'b');
      await vfs.mkdir('/dir/sub');

      const responses = await handleFsRequest(vfs, { op: 'readDir', path: '/dir' });
      const data = firstOk(responses);
      expect(data.type).toBe('dirEntries');
      if (data.type === 'dirEntries') {
        const names = data.entries.map((e) => e.name).sort();
        expect(names).toEqual(['a.txt', 'b.txt', 'sub']);
        const subEntry = data.entries.find((e) => e.name === 'sub');
        expect(subEntry?.type).toBe('directory');
      }
    });
  });

  describe('mkdir', () => {
    it('creates a directory', async () => {
      const responses = await handleFsRequest(vfs, { op: 'mkdir', path: '/newdir' });
      const data = firstOk(responses);
      expect(data).toEqual({ type: 'void' });

      const exists = await vfs.exists('/newdir');
      expect(exists).toBe(true);
    });

    it('creates directories recursively', async () => {
      const responses = await handleFsRequest(vfs, {
        op: 'mkdir',
        path: '/a/b/c',
        recursive: true,
      });
      expect(responses[0].ok).toBe(true);

      const exists = await vfs.exists('/a/b/c');
      expect(exists).toBe(true);
    });
  });

  describe('rm', () => {
    it('removes a file', async () => {
      await vfs.writeFile('/todelete.txt', 'bye');

      const responses = await handleFsRequest(vfs, { op: 'rm', path: '/todelete.txt' });
      const data = firstOk(responses);
      expect(data).toEqual({ type: 'void' });

      const exists = await vfs.exists('/todelete.txt');
      expect(exists).toBe(false);
    });

    it('removes a directory recursively', async () => {
      await vfs.writeFile('/dir/file.txt', 'content');

      const responses = await handleFsRequest(vfs, {
        op: 'rm',
        path: '/dir',
        recursive: true,
      });
      expect(responses[0].ok).toBe(true);

      const exists = await vfs.exists('/dir');
      expect(exists).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true for existing path', async () => {
      await vfs.writeFile('/exists.txt', 'yes');

      const responses = await handleFsRequest(vfs, { op: 'exists', path: '/exists.txt' });
      const data = firstOk(responses);
      expect(data).toEqual({ type: 'exists', exists: true });
    });

    it('returns false for non-existent path', async () => {
      const responses = await handleFsRequest(vfs, { op: 'exists', path: '/nope' });
      const data = firstOk(responses);
      expect(data).toEqual({ type: 'exists', exists: false });
    });
  });

  describe('walk', () => {
    it('recursively walks a directory tree', async () => {
      await vfs.writeFile('/root/a.txt', 'a');
      await vfs.writeFile('/root/sub/b.txt', 'b');
      await vfs.writeFile('/root/sub/deep/c.txt', 'c');

      const responses = await handleFsRequest(vfs, { op: 'walk', path: '/root' });
      const data = firstOk(responses);
      expect(data.type).toBe('paths');
      if (data.type === 'paths') {
        const sorted = [...data.paths].sort();
        expect(sorted).toEqual(['/root/a.txt', '/root/sub/b.txt', '/root/sub/deep/c.txt']);
      }
    });
  });

  describe('unknown op', () => {
    it('returns error for unknown operation', async () => {
      const responses = await handleFsRequest(vfs, { op: 'bogus' } as unknown as TrayFsRequest);
      expect(responses).toHaveLength(1);
      expect(responses[0].ok).toBe(false);
      if (!responses[0].ok) {
        expect(responses[0].error).toContain('Unknown fs operation');
      }
    });
  });
});

describe('base64 helpers', () => {
  it('roundtrips binary data', () => {
    const original = new Uint8Array([0, 127, 255, 1, 128, 64]);
    const encoded = uint8ToBase64(original);
    const decoded = base64ToUint8(encoded);
    expect(decoded).toEqual(original);
  });

  it('handles empty data', () => {
    const empty = new Uint8Array(0);
    const encoded = uint8ToBase64(empty);
    const decoded = base64ToUint8(encoded);
    expect(decoded).toEqual(empty);
  });
});
