import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { zipSync } from 'fflate';
import { VirtualFS } from '../fs/index.js';
import { installSkillFromDrop } from './install-from-drop.js';

let dbCounter = 0;

function makeArchive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const encoded = Object.fromEntries(
    Object.entries(entries).map(([path, content]) => [
      path,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    ]),
  );
  return zipSync(encoded);
}

function makeDroppedFile(name: string, bytes: Uint8Array, size: number = bytes.byteLength) {
  return {
    name,
    size,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return new Uint8Array(bytes).buffer as ArrayBuffer;
    },
  };
}

describe('installSkillFromDrop', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `install-from-drop-${dbCounter++}`, wipe: true });
  });

  it('installs a dropped .skill archive into /workspace/skills/{name}', async () => {
    const archive = makeArchive({
      'manifest.yaml': 'skill: hello\nversion: 1.0.0\ndescription: hello\n',
      'SKILL.md': '# Hello\n',
      'add/hello.txt': 'Hello drop!\n',
    });

    const result = await installSkillFromDrop(fs, makeDroppedFile('hello.skill', archive));

    expect(result.skillName).toBe('hello');
    expect(result.destinationPath).toBe('/workspace/skills/hello');
    expect(result.fileCount).toBe(3);
    await expect(fs.readTextFile('/workspace/skills/hello/manifest.yaml')).resolves.toContain('skill: hello');
    await expect(fs.readTextFile('/workspace/skills/hello/add/hello.txt')).resolves.toBe('Hello drop!\n');
  });

  it('supports archives wrapped in a top-level folder and ignores side metadata outside it', async () => {
    const archive = makeArchive({
      '__MACOSX/ignored.txt': 'ignored',
      'wrapped/manifest.yaml': 'skill: wrapped\nversion: 1.0.0\n',
      'wrapped/SKILL.md': '# Wrapped\n',
    });

    const result = await installSkillFromDrop(fs, makeDroppedFile('wrapped.skill', archive));

    expect(result.skillName).toBe('wrapped');
    await expect(fs.exists('/workspace/skills/wrapped/SKILL.md')).resolves.toBe(true);
    await expect(fs.exists('/workspace/skills/wrapped/__MACOSX/ignored.txt')).resolves.toBe(false);
  });

  it('rejects archives larger than 50 MB', async () => {
    const archive = makeArchive({
      'manifest.yaml': 'skill: huge\nversion: 1.0.0\n',
    });

    await expect(
      installSkillFromDrop(fs, makeDroppedFile('huge.skill', archive, 50 * 1024 * 1024 + 1)),
    ).rejects.toThrow('50 MB or smaller');
  });

  it('rejects suspicious traversal paths in the archive', async () => {
    const archive = makeArchive({
      'manifest.yaml': 'skill: bad\nversion: 1.0.0\n',
      '../escape.txt': 'nope',
    });

    await expect(
      installSkillFromDrop(fs, makeDroppedFile('bad.skill', archive)),
    ).rejects.toThrow('Blocked suspicious path');
  });

  it('rejects corrupt archives or missing manifests with clear errors', async () => {
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('broken.skill', new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow('Invalid .skill archive');

    const archive = makeArchive({
      'SKILL.md': '# Missing manifest\n',
    });
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('missing.skill', archive)),
    ).rejects.toThrow('missing manifest.yaml');
  });

  it('rejects invalid skill names and existing destination directories', async () => {
    const invalidArchive = makeArchive({
      'manifest.yaml': 'skill: bad/name\nversion: 1.0.0\n',
    });
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('invalid.skill', invalidArchive)),
    ).rejects.toThrow('simple directory name');

    await fs.mkdir('/workspace/skills/existing', { recursive: true });
    const existingArchive = makeArchive({
      'manifest.yaml': 'skill: existing\nversion: 1.0.0\n',
    });
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('existing.skill', existingArchive)),
    ).rejects.toThrow('already exists');
  });
});