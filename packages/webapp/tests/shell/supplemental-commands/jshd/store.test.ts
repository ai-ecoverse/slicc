import { describe, expect, it } from 'vitest';
import {
  deleteUnitRecord,
  listUnitRecords,
  readUnitRecord,
  writeUnitRecord,
} from '../../../../src/shell/supplemental-commands/jshd/store.js';
import type { JshdUnitRecord } from '../../../../src/shell/supplemental-commands/jshd/types.js';

function memoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    async exists(path: string) {
      if (path === '/workspace/.jshd' || path === '/workspace/.jshd/log') return true;
      return files.has(path);
    },
    async readFile(path: string) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async mkdir() {
      /* noop */
    },
    async rm(path: string) {
      files.delete(path);
    },
    async readdir(path: string) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
  };
}

const sample = (name: string, enabled = false): JshdUnitRecord => ({
  name,
  argv: [`/workspace/${name}.jsh`],
  cwd: '/workspace',
  env: { K: 'V' },
  restart: 'always',
  enabled,
  createdAt: '2026-09-17T00:00:00.000Z',
});

describe('jshd store', () => {
  it('round-trips unit records and lists them by name', async () => {
    const fs = memoryFs();
    await writeUnitRecord(fs, sample('b'));
    await writeUnitRecord(fs, sample('a', true));
    const listed = await listUnitRecords(fs);
    expect(listed.map((row) => row.name)).toEqual(['a', 'b']);
    expect((await readUnitRecord(fs, 'a'))?.enabled).toBe(true);
    await deleteUnitRecord(fs, 'a');
    expect(await readUnitRecord(fs, 'a')).toBeNull();
    expect((await listUnitRecords(fs)).map((row) => row.name)).toEqual(['b']);
  });

  it('ignores malformed json instead of throwing', async () => {
    const fs = memoryFs();
    fs.files.set('/workspace/.jshd/bad.json', '{not json');
    expect(await readUnitRecord(fs, 'bad')).toBeNull();
    expect(await listUnitRecords(fs)).toEqual([]);
  });
});
