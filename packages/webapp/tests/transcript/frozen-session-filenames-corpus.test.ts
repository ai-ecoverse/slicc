import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  frozenSessionRows,
  isAgentSessionArchiveFilename,
} from '../../src/transcript/frozen-archive-format.js';
import {
  rebuildSessionsIndexFromArchives,
  type SessionsIndexReadVfs,
} from '../../src/transcript/frozen-archive-writer.js';

interface FilenameCase {
  filename: string;
  session: boolean;
}

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/frozen-session-filenames.json'
);
const { cases } = JSON.parse(readFileSync(fixture, 'utf8')) as { cases: FilenameCase[] };
const sessions = cases
  .filter((c) => c.session)
  .map((c) => c.filename)
  .sort();

describe('frozen-session filename corpus', () => {
  it('covers both sides of the rule', () => {
    expect(cases.some((c) => c.session)).toBe(true);
    expect(cases.some((c) => !c.session)).toBe(true);
  });

  it.each(cases.map((c) => [c.filename, c] as const))(
    'classifies %s as the corpus claims',
    (_name, c) => {
      expect(isAgentSessionArchiveFilename(c.filename)).toBe(!c.session);
    }
  );

  it('keeps exactly the corpus sessions among index rows', () => {
    const rows = cases.map((c) => ({
      filename: c.filename,
      title: c.filename,
      frozenAt: '',
      messageCount: 0,
    }));
    expect(
      frozenSessionRows(rows)
        .map((e) => e.filename)
        .sort()
    ).toEqual(sessions);
  });

  it('rebuilds a corrupt index from exactly the corpus sessions', async () => {
    const vfs: SessionsIndexReadVfs = {
      readDir: async () => cases.map((c) => ({ name: c.filename, type: 'file' })),
      readFile: async () => '',
    };
    const rebuilt = await rebuildSessionsIndexFromArchives(vfs);
    expect(rebuilt.map((e) => e.filename).sort()).toEqual(sessions);
  });
});
