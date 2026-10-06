import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScoopCompletionService } from '../../src/scoops/scoop-completion-service.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { CURRENT_SCOOP_CONFIG_VERSION } from '../../src/scoops/types.js';

const scoop: RegisteredScoop = {
  jid: 'scoop_wait_unit_1',
  name: 'wait-unit',
  folder: 'wait-unit-scoop',
  parentJid: 'cone_main_1',
  requiresTrigger: false,
  assistantLabel: 'wait-unit-scoop',
  addedAt: '2026-01-01T00:00:00.000Z',
  configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
};

function makeService(known: RegisteredScoop[] = [scoop]): ScoopCompletionService {
  const map = new Map(known.map((s) => [s.jid, s]));
  return new ScoopCompletionService({
    getSharedFs: () => null,
    getScoop: (jid) => map.get(jid),
    findParent: () => undefined,
    hasScoop: (jid) => map.has(jid),
    notifyIncomingMessage: vi.fn(),
    handleMessage: async () => {},
    reportError: vi.fn(),
  });
}

describe('ScoopCompletionService.waitForScoops timeout 0', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves from microtasks alone without scheduling a timer', async () => {
    const service = makeService();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const resultsPromise = service.waitForScoops([scoop.jid], 0);
    await expect(resultsPromise).resolves.toEqual([
      { jid: scoop.jid, summary: null, timedOut: true },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still returns a pending completion that arrived before the wait', async () => {
    const service = makeService();
    service.muteScoops([scoop.jid]);
    service.setResponseFull(scoop.jid, 'already done');
    await service.notifyCompletion(scoop.jid);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const results = await service.waitForScoops([scoop.jid], 0);
    expect(results).toEqual([{ jid: scoop.jid, summary: 'already done', timedOut: false }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
