// @vitest-environment jsdom
/**
 * Freezer wiring tests: index → cards and archive → thawed messages, over a
 * real (fake-indexeddb) VirtualFS using the canonical archive format.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  type FrozenSessionIndexEntry,
  frozenCard,
  refreshFreezerCards,
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

describe('refreshFreezerCards', () => {
  it('replaces cards from the index, keeping other rail children', async () => {
    const fs = await seededFs();
    const freezer = document.createElement('slicc-freezer');
    const launcher = document.createElement('slicc-freezer-new');
    freezer.append(launcher);

    const entries = await refreshFreezerCards(freezer, fs);
    expect(entries).toHaveLength(1);
    expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(1);
    expect(freezer.contains(launcher)).toBe(true);

    // Re-running replaces rather than duplicates.
    await refreshFreezerCards(freezer, fs);
    expect(freezer.querySelectorAll('slicc-freezer-card')).toHaveLength(1);
  });

  it('returns empty on a missing index', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-noindex-${Math.random()}`, wipe: true });
    const freezer = document.createElement('slicc-freezer');
    expect(await refreshFreezerCards(freezer, fs)).toEqual([]);
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
