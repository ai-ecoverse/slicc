import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { zipSync } from 'fflate';
import { VirtualFS } from '../../src/fs/index.js';
import {
  MAX_SKILL_ARCHIVE_ENTRY_COUNT,
  MAX_SKILL_ARCHIVE_UNCOMPRESSED_SIZE_BYTES,
} from '../../src/skills/constants.js';
import { installSkillFromDrop } from '../../src/skills/install-from-drop.js';

let dbCounter = 0;

function makeArchive(entries: Record<string, string | Uint8Array>): Uint8Array {
  const encoded = Object.fromEntries(
    Object.entries(entries).map(([path, content]) => [
      path,
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    ])
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

  it('installs an archive whose SKILL.md sits at the root using the file name as the skill name', async () => {
    const archive = makeArchive({
      'SKILL.md': '---\nname: hello\ndescription: hello\n---\n# Hello\n',
      'extra.txt': 'Hello drop!\n',
    });

    const result = await installSkillFromDrop(fs, makeDroppedFile('hello.skill', archive));

    expect(result.skillName).toBe('hello');
    expect(result.destinationPath).toBe('/workspace/skills/hello');
    expect(result.fileCount).toBe(2);
    await expect(fs.readTextFile('/workspace/skills/hello/SKILL.md')).resolves.toContain('# Hello');
    await expect(fs.readTextFile('/workspace/skills/hello/extra.txt')).resolves.toBe(
      'Hello drop!\n'
    );
  });

  it('uses the wrapping directory name when SKILL.md is nested and ignores side metadata outside it', async () => {
    const archive = makeArchive({
      '__MACOSX/ignored.txt': 'ignored',
      'wrapped/SKILL.md': '# Wrapped\n',
      'wrapped/notes.md': 'notes',
    });

    const result = await installSkillFromDrop(fs, makeDroppedFile('archive.skill', archive));

    expect(result.skillName).toBe('wrapped');
    await expect(fs.exists('/workspace/skills/wrapped/SKILL.md')).resolves.toBe(true);
    await expect(fs.exists('/workspace/skills/wrapped/notes.md')).resolves.toBe(true);
    await expect(fs.exists('/workspace/skills/wrapped/__MACOSX/ignored.txt')).resolves.toBe(false);
  });

  it('filters archive metadata side-cars even when SKILL.md is at the archive root', async () => {
    const archive = makeArchive({
      'SKILL.md': '# Root\n',
      'helper.txt': 'real content',
      '__MACOSX/foo': 'macos noise',
      '.DS_Store': 'finder noise',
      '._SKILL.md': 'apple-double',
      'nested/._helper.txt': 'apple-double nested',
      'nested/Thumbs.db': 'windows noise',
      'nested/desktop.ini': 'windows noise',
      'nested/keep.txt': 'real nested',
    });

    const result = await installSkillFromDrop(fs, makeDroppedFile('rooted.skill', archive));

    expect(result.skillName).toBe('rooted');
    expect(result.fileCount).toBe(3); // SKILL.md, helper.txt, nested/keep.txt
    await expect(fs.exists('/workspace/skills/rooted/SKILL.md')).resolves.toBe(true);
    await expect(fs.exists('/workspace/skills/rooted/helper.txt')).resolves.toBe(true);
    await expect(fs.exists('/workspace/skills/rooted/nested/keep.txt')).resolves.toBe(true);
    await expect(fs.exists('/workspace/skills/rooted/__MACOSX')).resolves.toBe(false);
    await expect(fs.exists('/workspace/skills/rooted/.DS_Store')).resolves.toBe(false);
    await expect(fs.exists('/workspace/skills/rooted/._SKILL.md')).resolves.toBe(false);
    await expect(fs.exists('/workspace/skills/rooted/nested/._helper.txt')).resolves.toBe(false);
    await expect(fs.exists('/workspace/skills/rooted/nested/Thumbs.db')).resolves.toBe(false);
    await expect(fs.exists('/workspace/skills/rooted/nested/desktop.ini')).resolves.toBe(false);
  });

  it('rejects archives larger than 50 MB', async () => {
    const archive = makeArchive({
      'SKILL.md': '# huge\n',
    });

    await expect(
      installSkillFromDrop(fs, makeDroppedFile('huge.skill', archive, 50 * 1024 * 1024 + 1))
    ).rejects.toThrow('50 MB or smaller');
  });

  it('rejects suspicious traversal paths in the archive', async () => {
    const archive = makeArchive({
      'SKILL.md': '# bad\n',
      '../escape.txt': 'nope',
    });

    await expect(installSkillFromDrop(fs, makeDroppedFile('bad.skill', archive))).rejects.toThrow(
      'Blocked suspicious path'
    );
  });

  it('rejects archives that exceed the extracted-size budget before install', async () => {
    const archive = makeArchive({
      'SKILL.md': '# too-big\n',
      'payload.txt': new Uint8Array(MAX_SKILL_ARCHIVE_UNCOMPRESSED_SIZE_BYTES + 1),
    });

    await expect(
      installSkillFromDrop(fs, makeDroppedFile('too-big.skill', archive))
    ).rejects.toThrow('expand to 50 MB or smaller');

    await expect(fs.exists('/workspace/skills/too-big')).resolves.toBe(false);
  });

  it('rejects archives that exceed the entry-count budget before install', async () => {
    const entries: Record<string, string> = {
      'SKILL.md': '# too-many\n',
    };
    for (let i = 0; i < MAX_SKILL_ARCHIVE_ENTRY_COUNT; i++) {
      entries[`files/${String(i).padStart(4, '0')}.txt`] = 'x';
    }

    const archive = makeArchive(entries);

    await expect(
      installSkillFromDrop(fs, makeDroppedFile('too-many.skill', archive))
    ).rejects.toThrow(`at most ${MAX_SKILL_ARCHIVE_ENTRY_COUNT} entries`);

    await expect(fs.exists('/workspace/skills/too-many')).resolves.toBe(false);
  });

  it('rejects corrupt archives or missing SKILL.md with clear errors', async () => {
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('broken.skill', new Uint8Array([1, 2, 3])))
    ).rejects.toThrow('Invalid .skill archive');

    const archive = makeArchive({
      'README.md': '# Missing SKILL.md\n',
    });
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('missing.skill', archive))
    ).rejects.toThrow('missing SKILL.md');
  });

  it('rejects invalid skill names and existing destination directories', async () => {
    const invalidArchive = makeArchive({
      'bad name/SKILL.md': '# bad\n',
    });
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('archive.skill', invalidArchive))
    ).rejects.toThrow('simple directory name');

    await fs.mkdir('/workspace/skills/existing', { recursive: true });
    const existingArchive = makeArchive({
      'existing/SKILL.md': '# existing\n',
    });
    await expect(
      installSkillFromDrop(fs, makeDroppedFile('existing.skill', existingArchive))
    ).rejects.toThrow('already exists');
  });

  it('cleans up temporary output after a write failure so retry can succeed', async () => {
    const archive = makeArchive({
      'retryable/SKILL.md': '# Retryable\n',
      'retryable/file.txt': 'hello\n',
    });

    const originalWriteFile = fs.writeFile.bind(fs);
    let writeAttempts = 0;
    fs.writeFile = (async (...args) => {
      writeAttempts++;
      if (writeAttempts === 2) {
        throw new Error('simulated write failure');
      }
      return originalWriteFile(...args);
    }) as typeof fs.writeFile;

    await expect(
      installSkillFromDrop(fs, makeDroppedFile('archive.skill', archive))
    ).rejects.toThrow('simulated write failure');

    await expect(fs.exists('/workspace/skills/retryable')).resolves.toBe(false);
    await expect(fs.readDir('/workspace/skills')).resolves.toEqual([]);

    fs.writeFile = originalWriteFile;

    const result = await installSkillFromDrop(fs, makeDroppedFile('archive.skill', archive));

    expect(result.skillName).toBe('retryable');
    await expect(fs.readTextFile('/workspace/skills/retryable/file.txt')).resolves.toBe('hello\n');
  });
});
