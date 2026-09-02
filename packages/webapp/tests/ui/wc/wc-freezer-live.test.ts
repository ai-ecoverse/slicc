// @vitest-environment jsdom
/**
 * Live compaction snapshots on the freezer rail: an index rebuild keeps the
 * `live` marker (and never hands a running session to the enrichment
 * catch-up), and the card says the chat is still in progress.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { frozenCard, rebuildFreezerIndexFromArchives } from '../../../src/ui/wc/wc-freezer.js';

function archive(live: boolean): string {
  return [
    '---',
    'title: "Still going"',
    'frozenAt: 2026-09-02T10:00:00.000Z',
    'messageCount: 1',
    'id: sid-1',
    'cone: cone',
    ...(live ? ['live: true', 'liveThrough: 42', 'compactions: 2'] : []),
    '---',
    '<!-- slicc:session-data',
    JSON.stringify([{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }]),
    '-->',
    '',
    '# Still going',
    '',
  ].join('\n');
}

describe('rebuildFreezerIndexFromArchives with live snapshots', () => {
  it('keeps a live archive live and treats a finalized live- file as a pending draft', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-freezer-live-${Math.random()}`, wipe: true });
    await fs.mkdir('/sessions');
    await fs.writeFile('/sessions/live-cone-aaa.md', archive(true));
    await fs.writeFile('/sessions/live-cone-bbb.md', archive(false));
    await fs.writeFile('/sessions/pending-ccc.md', archive(false));

    const entries = await rebuildFreezerIndexFromArchives(fs);
    const byName = Object.fromEntries(entries.map((e) => [e.filename, e]));

    expect(byName['live-cone-aaa.md']).toMatchObject({
      live: true,
      cone: 'cone',
      liveThrough: 42,
      compactions: 2,
      sessionId: 'sid-1',
    });
    expect(byName['live-cone-aaa.md'].pendingEnrichment).toBeUndefined();
    expect(byName['live-cone-bbb.md']).toMatchObject({ pendingEnrichment: true });
    expect(byName['live-cone-bbb.md'].live).toBeUndefined();
    expect(byName['live-cone-bbb.md'].liveThrough).toBeUndefined();
    expect(byName['pending-ccc.md']).toMatchObject({ pendingEnrichment: true });
  });
});

describe('frozenCard for a live snapshot', () => {
  it('marks the card as in progress', () => {
    const card = frozenCard({
      filename: 'live-cone-aaa.md',
      title: 'Still going',
      frozenAt: '2026-09-02T10:00:00.000Z',
      messageCount: 3,
      live: true,
    });
    expect(card.getAttribute('meta')).toMatch(/3 turns · in progress$/);
    const done = frozenCard({
      filename: 'x.md',
      title: 'Done',
      frozenAt: '2026-09-02T10:00:00.000Z',
      messageCount: 3,
    });
    expect(done.getAttribute('meta')).toMatch(/3 turns$/);
  });
});
