// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { FsError } from '../../../src/fs/types.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { readSessionCount } from '../../../src/scoops/cone-memory-budget.js';
import { serializeIndexWrite } from '../../../src/transcript/frozen-archive-writer.js';
import {
  coneBadgeFor,
  enrichFreezerIcons,
  type FrozenSessionIndexEntry,
  frozenCard,
  readFreezerEntries,
  readFreezerIndexState,
  rebuildFreezerIndexFromArchives,
  recoverCorruptFreezerIndex,
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

  it('marks finished chats deletable only when asked, never a live snapshot', () => {
    expect(frozenCard(ENTRY).hasAttribute('deletable')).toBe(false);
    expect(frozenCard(ENTRY, { deletable: true }).hasAttribute('deletable')).toBe(true);
    expect(
      frozenCard({ ...ENTRY, live: true }, { deletable: true }).hasAttribute('deletable')
    ).toBe(false);
  });
});

describe('cone provenance (#2272)', () => {
  it('shows no cone badge for the primary cone or a legacy archive', () => {
    expect(coneBadgeFor(ENTRY)).toBeUndefined();
    expect(coneBadgeFor({ ...ENTRY, cone: 'cone' })).toBeUndefined();
  });

  it('names the extra cone an archive came from, but never on the rail card', () => {
    const entry = { ...ENTRY, cone: 'cone-research', coneLabel: 'Research' };
    expect(coneBadgeFor(entry)).toBe('Research');

    expect(frozenCard(entry).getAttribute('meta')).toBe(frozenCard(ENTRY).getAttribute('meta'));
  });

  it('falls back to the folder slug when no label was recorded', () => {
    expect(coneBadgeFor({ ...ENTRY, cone: 'cone-side-quest' })).toBe('side-quest');
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

    renderFreezerCards(freezer, entries ?? []);
    expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(1);
  });

  it('treats a MISSING index as genuinely empty', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-noindex-${Math.random()}`, wipe: true });
    expect(await readFreezerEntries(fs)).toEqual([]);
  });

  it('reports transport faults as null so the caller preserves the rail', async () => {
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

    const after = (await readFreezerEntries(fs)) ?? [];
    expect(after[0]?.icon).toBe('wrench');

    expect(freezer.querySelector('slicc-freezer-card')?.getAttribute('icon')).toBe('wrench');

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

    expect(pickIcon).toHaveBeenCalledTimes(1);
    const after = (await readFreezerEntries(fs)) ?? [];
    expect(after.every((e) => !e.icon)).toBe(true);
  });
});

describe('corrupt-index recovery', () => {
  it('treats a truncated index as a FAULT, never as empty (the rail-wipe trap)', async () => {
    const fs = await seededFs();

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
        'cost: {"total":0.25,"input":0.1,"output":0.15,"cacheRead":0,"cacheWrite":0}',
        'models: [{"model":"model-a","cost":0.25,"turns":2,"tokens":300}]',
        'cone: cone-research',
        'coneLabel: "Research"',
        '---',
        '',
      ].join('\n')
    );
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');

    const rebuilt = await rebuildFreezerIndexFromArchives(fs);
    expect(rebuilt).toHaveLength(2);

    expect(rebuilt[0]).toMatchObject({
      filename: 'pending-xyz.md',
      title: 'quick one',
      messageCount: 3,
      pendingEnrichment: true,
      cost: { total: 0.25, input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0 },
      models: [{ model: 'model-a', cost: 0.25, turns: 2, tokens: 300 }],

      cone: 'cone-research',
      coneLabel: 'Research',
    });
    expect(rebuilt[1]).toMatchObject({ filename: ENTRY.filename, title: 'Fix the build' });
    expect(rebuilt[1].cone).toBeUndefined();

    expect(rebuilt[0].memorySkipped).toBeUndefined();
  });

  it('rebuilds sessionId from frontmatter sessionId, never from the cone chat id', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-sessionid-${Math.random()}`, wipe: true });
    await fs.mkdir('/sessions');
    await fs.writeFile(
      '/sessions/one.md',
      [
        '---',
        'id: session-cone',
        'sessionId: freeze-aaaa',
        'title: "first"',
        'frozenAt: "2026-06-04T09:00:00Z"',
        'messageCount: 2',
        'cone: cone',
        '---',
        '',
      ].join('\n')
    );
    await fs.writeFile(
      '/sessions/two.md',
      [
        '---',
        'id: session-cone',
        'sessionId: freeze-bbbb',
        'title: "second"',
        'frozenAt: "2026-06-04T10:00:00Z"',
        'messageCount: 2',
        'cone: cone',
        '---',
        '',
      ].join('\n')
    );
    await fs.writeFile(
      '/sessions/legacy.md',
      [
        '---',
        'id: session-cone',
        'title: "legacy"',
        'frozenAt: "2026-06-03T09:00:00Z"',
        'messageCount: 1',
        '---',
        '',
      ].join('\n')
    );

    const rebuilt = await rebuildFreezerIndexFromArchives(fs);
    expect(rebuilt.map((e) => [e.filename, e.sessionId])).toEqual([
      ['two.md', 'freeze-bbbb'],
      ['one.md', 'freeze-aaaa'],
      ['legacy.md', undefined],
    ]);
  });

  it('a memorySkipped archive keeps its opt-out through a rebuild (Codex P2)', async () => {
    const fs = await seededFs();
    await fs.writeFile(
      '/sessions/pending-dropped.md',
      [
        '---',
        'title: "dropped cone chat"',
        'frozenAt: "2026-06-03T09:00:00Z"',
        'messageCount: 4',
        'cone: cone-research',
        'coneLabel: "Research"',
        'memorySkipped: true',
        '---',
        '',
      ].join('\n')
    );
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');

    const rebuilt = await rebuildFreezerIndexFromArchives(fs);
    expect(rebuilt[0]).toMatchObject({
      filename: 'pending-dropped.md',
      pendingEnrichment: true,
      memorySkipped: true,
    });
  });

  it('keeps readSessionCount compatible with cost-bearing index entries', async () => {
    const fs = await seededFs();
    await fs.writeFile(
      '/sessions/index.json',
      JSON.stringify([
        ENTRY,
        {
          ...ENTRY,
          filename: 'cost-bearing.md',
          cost: { total: 0.25, input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0 },
          models: [{ model: 'model-a', cost: 0.25, turns: 2, tokens: 300 }],
        },
      ])
    );
    expect(await readSessionCount(fs)).toBe(2);
  });

  it('enrichFreezerIcons refuses to write over a corrupt or empty re-read', async () => {
    const fs = await seededFs();
    const entries = (await readFreezerEntries(fs)) ?? [];

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

  it('rebuilds sessionId from the sessionId frontmatter, never from a per-cone chat key (#3807)', async () => {
    const fs = await seededFs();
    const archive = (title: string, frozenAt: string, extra: string[]) =>
      [
        '---',
        'id: session-cone',
        ...extra,
        `title: "${title}"`,
        `frozenAt: "${frozenAt}"`,
        'messageCount: 2',
        '---',
        '',
      ].join('\n');
    await fs.writeFile(
      '/sessions/2026-06-04T09-00-00Z-a.md',
      archive('a', '2026-06-04T09:00:00Z', ['sessionId: sid-a'])
    );
    await fs.writeFile(
      '/sessions/2026-06-05T09-00-00Z-b.md',
      archive('b', '2026-06-05T09:00:00Z', [])
    );
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');

    const rebuilt = await rebuildFreezerIndexFromArchives(fs);
    const byName = new Map(rebuilt.map((entry) => [entry.filename, entry]));
    expect(byName.get('2026-06-04T09-00-00Z-a.md')?.sessionId).toBe('sid-a');

    expect(byName.get('2026-06-05T09-00-00Z-b.md')?.sessionId).toBeUndefined();
  });
});

function holdIndexLock(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  void serializeIndexWrite(async () => {
    entered();
    await gate;
  });
  return { held, release };
}

describe('index writers never resurrect a deleted row', () => {
  it('recoverCorruptFreezerIndex rebuilds and publishes a corrupt index', async () => {
    const fs = await seededFs();
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');
    const entries = await recoverCorruptFreezerIndex(fs, fs);
    expect(entries?.map((entry) => entry.filename)).toEqual([ENTRY.filename]);
    expect((await readFreezerEntries(fs))?.map((entry) => entry.filename)).toEqual([
      ENTRY.filename,
    ]);
  });

  it('recoverCorruptFreezerIndex re-checks inside the lock: a delete that landed first wins', async () => {
    const fs = await seededFs();
    await fs.writeFile('/sessions/index.json', '[{"filename": "trunca');
    const lock = holdIndexLock();
    await lock.held;
    const recovering = recoverCorruptFreezerIndex(fs, fs);

    await fs.rm(`/sessions/${ENTRY.filename}`);
    await fs.writeFile('/sessions/index.json', '[]');
    lock.release();

    expect(await recovering).toEqual([]);
    expect(await readFreezerEntries(fs)).toEqual([]);
  });

  it('enrichFreezerIcons stamps only rows still present when its write runs', async () => {
    const fs = await seededFs();
    const entries = (await readFreezerEntries(fs)) ?? [];
    const other: FrozenSessionIndexEntry = { ...ENTRY, filename: 'other.md', title: 'Other' };
    const lock = holdIndexLock();
    await lock.held;
    const enriching = enrichFreezerIcons({
      reader: fs,
      writer: fs,
      freezer: document.createElement('slicc-freezer'),
      entries,
      pickIcon: async () => 'wrench',
    });

    await fs.writeFile('/sessions/index.json', JSON.stringify([other]));
    lock.release();
    await enriching;

    const after = (await readFreezerEntries(fs)) ?? [];
    expect(after.map((entry) => entry.filename)).toEqual(['other.md']);
    expect(after[0]?.icon).toBeUndefined();
  });
});
