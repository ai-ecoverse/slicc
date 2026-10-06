import { describe, expect, it } from 'vitest';
import type { FrozenSessionIndexEntry } from '../../src/transcript/frozen-archive-format.js';
import {
  findFrozenRow,
  isSafeArchiveFilename,
  isSafeSessionKey,
  readIndexForPresence,
  trustedSessionId,
} from '../../src/transcript/frozen-session-identity.js';

const row = (filename: string, sessionId?: string): FrozenSessionIndexEntry => ({
  filename,
  title: filename,
  frozenAt: '2026-06-01T10:00:00.000Z',
  messageCount: 2,
  ...(sessionId ? { sessionId } : {}),
});

describe('isSafeArchiveFilename', () => {
  it('accepts the names the freezer writes', () => {
    for (const name of [
      '2026-06-01T10-00-00-000Z-fix-build.md',
      'pending-a1b2c3.md',
      'live-cone-x1.md',
    ]) {
      expect(isSafeArchiveFilename(name), name).toBe(true);
    }
  });

  it('rejects traversal, separators, NUL, hidden and non-archive names', () => {
    for (const name of [
      '../shared/CLAUDE.md',
      '/etc/passwd.md',
      'a/b.md',
      'a\\b.md',
      'a\u0000.md',
      '.md',
      '..md',
      '.hidden.md',
      'x..y.md',
      'notes.txt',
      '',
      42,
      undefined,
    ]) {
      expect(isSafeArchiveFilename(name), String(name)).toBe(false);
    }
  });
});

describe('isSafeSessionKey', () => {
  it('accepts UUIDs and archive bases', () => {
    expect(isSafeSessionKey('0b7e2a64-1d1f-4a63-9d5c-3c1f0f0e9a11')).toBe(true);
    expect(isSafeSessionKey('pending-a1b2c3')).toBe(true);
  });

  it('rejects empty, traversal, separators and hidden keys', () => {
    for (const key of ['', '.', '..', 'a/b', 'a\\b', '.tmp-x', 'a..b', undefined]) {
      expect(isSafeSessionKey(key), String(key)).toBe(false);
    }
  });
});

describe('trustedSessionId', () => {
  it('trusts a sessionId no other row shares', () => {
    const a = row('a.md', 'sid-a');
    expect(trustedSessionId([a, row('b.md', 'sid-b')], a)).toBe('sid-a');
  });

  it('distrusts a sessionId another row shares (#3807 collapsed rebuild)', () => {
    const a = row('a.md', 'dup');
    expect(trustedSessionId([a, row('b.md', 'dup')], a)).toBeUndefined();
  });

  it('has nothing to trust on a legacy row, an unsafe id, or a per-cone chat key', () => {
    const legacy = row('a.md');
    expect(trustedSessionId([legacy], legacy)).toBeUndefined();
    const bad = row('a.md', '../x');
    expect(trustedSessionId([bad], bad)).toBeUndefined();
    // Even when unique: `session-<folder>` is shared by every chat of a cone.
    const chatKey = row('a.md', 'session-cone');
    expect(trustedSessionId([chatKey], chatKey)).toBeUndefined();
  });
});

describe('findFrozenRow', () => {
  it('matches by filename first', () => {
    const a = row('a.md', 'sid');
    expect(findFrozenRow([a], { filename: 'a.md', sessionId: 'other' })).toBe(a);
  });

  it('follows an enrichment rename through a unique sessionId', () => {
    const renamed = row('2026-x-real.md', 'sid');
    expect(findFrozenRow([renamed], { filename: 'pending-x.md', sessionId: 'sid' })).toBe(renamed);
  });

  it('matches nothing on an ambiguous sessionId or a missing key', () => {
    const rows = [row('a.md', 'dup'), row('b.md', 'dup')];
    expect(findFrozenRow(rows, { filename: 'pending-gone.md', sessionId: 'dup' })).toBeUndefined();
    expect(findFrozenRow(rows, { filename: 'gone.md' })).toBeUndefined();
  });

  it('never follows a sessionId from a canonical (non-draft) name or through a chat key', () => {
    const b = row('2026-b.md', 'sid-b');
    // A stale card for a deleted canonical archive must not resolve to b.
    expect(findFrozenRow([b], { filename: '2026-a.md', sessionId: 'sid-b' })).toBeUndefined();
    const legacy = row('2026-c.md', 'session-cone');
    expect(
      findFrozenRow([legacy], { filename: 'pending-c.md', sessionId: 'session-cone' })
    ).toBeUndefined();
  });
});

describe('readIndexForPresence', () => {
  const reader = (result: string | Error) => ({
    readFile: async (): Promise<string> => {
      if (result instanceof Error) throw result;
      return result;
    },
  });

  it('returns the rows of a well-formed index', async () => {
    expect(await readIndexForPresence(reader(JSON.stringify([row('a.md')])))).toHaveLength(1);
  });

  it('cannot say (null) when the index is missing, unreadable or malformed', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    expect(await readIndexForPresence(reader(missing))).toBeNull();
    expect(await readIndexForPresence(reader('[{"filename": trunc'))).toBeNull();
    expect(await readIndexForPresence(reader('{"not":"an array"}'))).toBeNull();
  });
});
