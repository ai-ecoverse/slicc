// @vitest-environment jsdom
/**
 * Freezer wiring tests: index → cards and archive → thawed messages, over a
 * real (fake-indexeddb) VirtualFS using the canonical archive format.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { FsError } from '../../../src/fs/types.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  enrichFreezerIcons,
  type FrozenSessionIndexEntry,
  frozenCard,
  readFreezerEntries,
  readFreezerIndexState,
  rebuildFreezerIndexFromArchives,
  renderFreezerCards,
  thawFrozenSession,
} from '../../../src/ui/wc/wc-freezer.js';

const ENTRY: FrozenSessionIndexEntry = {
  filename: '2026-06-01T10-00-00Z-fix-build.md',
  title: 'Fix the build',
  frozenAt: '2026-06-01T10:00:00Z',
  messageCount: 2,
};

const ARCHIVE = [
  '---',
  'title: "Fix the build"',
  '---',
  '<!-- slicc:session-data',
  JSON.stringify([
    { id: 'u1', role: 'user', content: 'fix the build', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'done — green again', timestamp: 2 },
  ]),
  '-->',
  '',
  '# Fix the build',
  '',
].join('\n');

async function seededFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `wc-freezer-${Math.random()}`, wipe: true });
  await fs.mkdir('/sessions');
  await fs.writeFile('/sessions/index.json', JSON.stringify([ENTRY]));
  await fs.writeFile(`/sessions/${ENTRY.filename}`, ARCHIVE);
  return fs;
}

describe('frozenCard', () => {
  it('maps an index entry onto a freezer card', () => {
    const card = frozenCard(ENTRY);
    expect(card.tagName.toLowerCase()).toBe('slicc-freezer-card');
    expect(card.getAttribute('title')).toBe('Fix the build');
    expect(card.getAttribute('slug')).toBe(ENTRY.filename);
    expect(card.getAttribute('meta')).toContain('2 turns');
  });
});

describe('readFreezerEntries + renderFreezerCards', () => {
  it('reads the index and replaces cards, keeping other rail children', async () => {
    const fs = await seededFs();
    const freezer = document.createElement('slicc-freezer');
    const launcher = document.createElement('slicc-freezer-new');
    freezer.append(launcher);

    const entries = await readFreezerEntries(fs);
    expect(entries).toHaveLength(1);
    renderFreezerCards(freezer, entries ?? []);
    expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(1);
    expect(freezer.contains(launcher)).toBe(true);

    // Re-rendering replaces rather than duplicates.
    renderFreezerCards(freezer, entries ?? []);
    expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(1);
  });

  it('treats a MISSING index as genuinely empty', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-noindex-${Math.random()}`, wipe: true });
    expect(await readFreezerEntries(fs)).toEqual([]);
  });

  it('reports transport faults as null so the caller preserves the rail', async () => {
    // The regression: a boot-time RPC lost before the worker's VFS host
    // attached fails ~30s later with EIO — readSessionsIndex swallowed it
    // into [], and the late failure WIPED the cards a successful refresh had
    // already painted.
    const faulty = {
      readFile: async () => {
        throw new FsError('EIO', 'request timed out');
      },
    } as never;
    expect(await readFreezerEntries(faulty)).toBeNull();
  });
});

describe('thawFrozenSession', () => {
  it('parses the archive back into title + messages', async () => {
    const fs = await seededFs();
    const { title, messages } = await thawFrozenSession(fs, ENTRY);
    expect(title).toBe('Fix the build');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'done — green again' });
  });
});

describe('freezer thread icons', () => {
  it('frozenCard forwards a stored entry icon (default stays the snowflake)', () => {
    expect(frozenCard(ENTRY).hasAttribute('icon')).toBe(false);
    const card = frozenCard({ ...ENTRY, icon: 'wrench' });
    expect(card.getAttribute('icon')).toBe('wrench');
  });

  it('enrichFreezerIcons backfills icon-less entries: index rewritten, live card stamped', async () => {
    const fs = await seededFs();
    const freezer = document.createElement('slicc-freezer');
    const entries = (await readFreezerEntries(fs)) ?? [];
    renderFreezerCards(freezer, entries);

    const pickIcon = vi.fn(async (subject: string) =>
      subject.includes('Fix the build') ? 'wrench' : null
    );
    await enrichFreezerIcons({ reader: fs, writer: fs, freezer, entries, pickIcon });

    // The pick is persisted into the index (thread metadata)…
    const after = (await readFreezerEntries(fs)) ?? [];
    expect(after[0]?.icon).toBe('wrench');
    // …and stamped onto the already-rendered card.
    expect(freezer.querySelector('slicc-freezer-card')?.getAttribute('icon')).toBe('wrench');

    // A second pass has nothing left to label.
    pickIcon.mockClear();
    await enrichFreezerIcons({ reader: fs, writer: fs, freezer, entries: after, pickIcon });
    expect(pickIcon).not.toHaveBeenCalled();
  });

  it('enrichFreezerIcons skips pending-enrichment entries and survives failed picks', async () => {
    const fs = await seededFs();
    const pending: FrozenSessionIndexEntry = {
      ...ENTRY,
      filename: 'pending-abc.md',
      pendingEnrichment: true,
    };
    await fs.writeFile('/sessions/index.json', JSON.stringify([pending, ENTRY]));
    const entries = (await readFreezerEntries(fs)) ?? [];
    const freezer = document.createElement('slicc-freezer');
    renderFreezerCards(freezer, entries);

    const pickIcon = vi.fn(async () => null);
    await enrichFreezerIcons({ reader: fs, writer: fs, freezer, entries, pickIcon });
    // Only the settled entry was attempted; a null pick leaves the index alone.
    expect(pickIcon).toHaveBeenCalledTimes(1);
    const after = (await readFreezerEntries(fs)) ?? [];
    expect(after.every((e) => !e.icon)).toBe(true);
  });
});

describe('corrupt-index recovery', () => {
  it('treats a truncated index as a FAULT, never as empty (the rail-wipe trap)', async () => {
    const fs = await seededFs();
    // Simulate a write cut off mid-file by a reload killing the worker.
    const full = JSON.stringify([ENTRY], null, 2);
    await fs.writeFile('/sessions/index.json', full.slice(0, Math.floor(full.length / 2)));
    expect(await readFreezerEntries(fs)).toBeNull();
    expect((await readFreezerIndexState(fs)).kind).toBe('corrupt');
  });

  it('rebuilds the index from the archives (titles, timestamps, pending markers)', async () => {
    const fs = await seededFs();
    await fs.writeFile(
      '/sessions/pending-xyz.md',
      [
        '---',
        'title: "quick one"',
        'frozenAt: "2026-06-02T09:00:00Z"',
        'messageCount: 3',
        '---',
        '',
      ].join('\n')
    );
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');

    const rebuilt = await rebuildFreezerIndexFromArchives(fs);
    expect(rebuilt).toHaveLength(2);
    // Newest first.
    expect(rebuilt[0]).toMatchObject({
      filename: 'pending-xyz.md',
      title: 'quick one',
      messageCount: 3,
      pendingEnrichment: true,
    });
    expect(rebuilt[1]).toMatchObject({ filename: ENTRY.filename, title: 'Fix the build' });
  });

  it('enrichFreezerIcons refuses to write over a corrupt or empty re-read', async () => {
    const fs = await seededFs();
    const entries = (await readFreezerEntries(fs)) ?? [];
    // Corrupt the index AFTER the entries were read (mid-enrichment race).
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');
    const writes: string[] = [];
    const writer = {
      writeFile: async (_p: string, content: string) => {
        writes.push(content);
      },
    };
    await enrichFreezerIcons({
      reader: fs,
      writer,
      freezer: document.createElement('slicc-freezer'),
      entries,
      pickIcon: async () => 'wrench',
    });
    expect(writes).toEqual([]);
  });
});
