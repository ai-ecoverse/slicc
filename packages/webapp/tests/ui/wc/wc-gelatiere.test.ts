import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsFeatureEnabled = vi.fn();
vi.mock('../../../src/core/feature-flags.js', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

import {
  GELATIERE_INSTRUCTIONS_PATH,
  GELATIERE_STATE_PATH,
} from '../../../src/base/gelatiere-store.js';
import { resetLoggerDedupForTests } from '../../../src/base/logger.js';
import {
  notifyGelatiereOfSessionEnd,
  type WcGelatiereDeps,
} from '../../../src/ui/wc/wc-gelatiere.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-09-09T12:00:00.000Z');

function makeVfs(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    readFile: async (path: string) => {
      const text = map.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (path: string, content: string) => {
      map.set(path, content);
    },
    mkdir: async () => {},
  };
}

function makeClient(scoops: Array<{ jid: string; folder: string; parentJid: string | null }>) {
  const client = {
    sendSprinkleLick: vi.fn(),
    getScoops: () => scoops.map((s) => ({ ...s, addedAt: '2026-01-01', name: s.folder })),
  };
  return client as unknown as WcGelatiereDeps['client'] & typeof client;
}

const WITH_UNIT = [
  { jid: 'cone_a', folder: 'cone', parentJid: null },
  { jid: 'scoop_gelatiere_1', folder: 'gelatiere', parentJid: 'system:gelatiere' },
];

describe('notifyGelatiereOfSessionEnd', () => {
  beforeEach(() => {
    resetLoggerDedupForTests();
    mockIsFeatureEnabled.mockReset().mockReturnValue(true);
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('does nothing when the flag is off', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const client = makeClient(WITH_UNIT);
    expect(await notifyGelatiereOfSessionEnd({ client, vfs: makeVfs(), log })).toBe(false);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('memory-v2');
    expect(client.sendSprinkleLick).not.toHaveBeenCalled();
  });

  it('does nothing when only a cone-owned scoop (or a cone) happens to be called gelatiere', async () => {
    const client = makeClient([
      { jid: 'cone_a', folder: 'cone', parentJid: null },
      { jid: 'cone_g', folder: 'gelatiere', parentJid: null },
      { jid: 'scoop_x', folder: 'gelatiere', parentJid: 'cone_a' },
    ]);
    expect(await notifyGelatiereOfSessionEnd({ client, vfs: makeVfs(), log })).toBe(false);
    expect(client.sendSprinkleLick).not.toHaveBeenCalled();
  });

  it('licks the unit with the cone and archive when a pass is due', async () => {
    const client = makeClient(WITH_UNIT);
    expect(
      await notifyGelatiereOfSessionEnd({
        client,
        vfs: makeVfs(),
        log,
        cone: { folder: 'cone-research', jid: 'cone_r' },
        archive: '2026-09-09-thing.md',
        now: () => NOW,
      })
    ).toBe(true);
    expect(client.sendSprinkleLick).toHaveBeenCalledWith(
      'gelatiere',
      {
        action: 'session-settled',
        data: { cone: 'cone-research', archive: '2026-09-09-thing.md' },
      },
      'gelatiere'
    );
  });

  it('stamps lastTriggeredAt when the lick is sent, so an empty pass still holds the interval', async () => {
    const client = makeClient(WITH_UNIT);
    const vfs = makeVfs();
    expect(await notifyGelatiereOfSessionEnd({ client, vfs, log, now: () => NOW })).toBe(true);
    const state = JSON.parse(vfs.files.get(GELATIERE_STATE_PATH) ?? '{}');
    expect(state.lastTriggeredAt).toBe(NOW.toISOString());
    // The pass the lick asked for suggested nothing (no `gelatiere suggest`,
    // so no lastPassAt) — the next "New chat" inside the interval must NOT
    // re-lick a billable pass.
    const soon = new Date(NOW.getTime() + 60_000);
    expect(await notifyGelatiereOfSessionEnd({ client, vfs, log, now: () => soon })).toBe(false);
    expect(client.sendSprinkleLick).toHaveBeenCalledTimes(1);
  });

  // Two cones settling in the same tick both read the state file before
  // either stamps it — without serialization both pass the gate and two
  // billable passes start for one interval.
  it('serializes concurrent session ends so only one passes the interval gate', async () => {
    const client = makeClient(WITH_UNIT);
    const vfs = makeVfs();
    const results = await Promise.all([
      notifyGelatiereOfSessionEnd({
        client,
        vfs,
        log,
        cone: { folder: 'cone' },
        now: () => NOW,
      }),
      notifyGelatiereOfSessionEnd({
        client,
        vfs,
        log,
        cone: { folder: 'cone-research' },
        now: () => NOW,
      }),
    ]);
    expect(results).toEqual([true, false]);
    expect(client.sendSprinkleLick).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vfs.files.get(GELATIERE_STATE_PATH) ?? '{}').lastTriggeredAt).toBe(
      NOW.toISOString()
    );
  });

  it('respects the interval from the instruction file', async () => {
    const client = makeClient(WITH_UNIT);
    const vfs = makeVfs({
      [GELATIERE_INSTRUCTIONS_PATH]: '---\nintervalHours: 6\n---\nbody',
      [GELATIERE_STATE_PATH]: JSON.stringify({ passes: 1, lastPassAt: '2026-09-09T08:00:00.000Z' }),
    });
    expect(await notifyGelatiereOfSessionEnd({ client, vfs, log, now: () => NOW })).toBe(false);
    expect(client.sendSprinkleLick).not.toHaveBeenCalled();
    const later = new Date('2026-09-09T15:00:00.000Z');
    expect(await notifyGelatiereOfSessionEnd({ client, vfs, log, now: () => later })).toBe(true);
  });

  it('never throws when the roster read fails', async () => {
    const client = {
      sendSprinkleLick: vi.fn(),
      getScoops: () => {
        throw new Error('roster gone');
      },
    } as unknown as WcGelatiereDeps['client'];
    expect(await notifyGelatiereOfSessionEnd({ client, vfs: makeVfs(), log })).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'gelatiere session-end notification failed',
      expect.any(Error)
    );
  });
});
