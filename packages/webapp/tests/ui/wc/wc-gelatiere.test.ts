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
    readFile: async (path: string) => {
      const text = map.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
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
