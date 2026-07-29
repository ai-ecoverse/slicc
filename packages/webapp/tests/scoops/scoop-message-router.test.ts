import { describe, expect, it } from 'vitest';
import type { ScoopMessageRouterDeps } from '../../src/scoops/scoop-message-router.js';
import { ScoopMessageRouter } from '../../src/scoops/scoop-message-router.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';

/** Yield to the microtask/timer queue so concurrent turns genuinely interleave. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeScoop(jid: string): RegisteredScoop {
  return {
    jid,
    name: jid,
    folder: jid,
    isCone: true,
    type: 'cone',
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: new Date().toISOString(),
  };
}

function makeMessage(jid: string, i: number): ChannelMessage {
  return {
    id: `id-${jid}-${i}`,
    chatJid: jid,
    senderId: 'user',
    senderName: 'user',
    content: `MSG_${String(i).padStart(3, '0')}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i).toISOString(),
    fromAssistant: false,
    channel: 'chat',
  };
}

interface Harness {
  router: ScoopMessageRouter;
  sends: string[];
  probe: { max: number };
}

function makeHarness(opts?: { failFirstSend?: boolean; jids?: string[] }): Harness {
  const jids = opts?.jids ?? ['cone'];
  const scoops = new Map<string, RegisteredScoop>();
  const tabs = new Map<string, ScoopTabState>();
  for (const jid of jids) {
    scoops.set(jid, makeScoop(jid));
    tabs.set(jid, { jid, contextId: jid, status: 'ready', lastActivity: '' });
  }

  const store: ChannelMessage[] = [];
  const sends: string[] = [];
  const probe = { max: 0 };
  let active = 0;
  let sendCount = 0;

  const deps: ScoopMessageRouterDeps = {
    getScoops: () => scoops,
    getTabs: () => tabs,
    getContexts: () => new Map(),
    createScoopTab: async () => {},
    sendPrompt: async (_jid, text) => {
      await tick();
      if (opts?.failFirstSend && sendCount++ === 0) throw new Error('boom');
      sends.push(text);
    },
    notifyIncomingMessage: () => {},
    onError: () => {},
    getSessionStore: () => null,
    resetCostTracker: () => {},
    db: {
      saveMessage: async (msg) => {
        await tick();
        store.push(msg);
      },
      deleteMessage: async () => {},
      clearMessagesForScoop: async () => {},
      clearAllMessages: async () => {},
      getMessagesSince: async (jid, since, excludeName) => {
        active += 1;
        probe.max = Math.max(probe.max, active);
        await tick();
        const result = store
          .filter((m) => m.chatJid === jid && m.timestamp > since && m.senderName !== excludeName)
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        active -= 1;
        return result;
      },
      setState: async () => {},
    },
    isExternalLickChannel: () => false,
  };

  const router = new ScoopMessageRouter(deps);
  for (const jid of jids) router.ensureQueue(jid);
  return { router, sends, probe };
}

describe('ScoopMessageRouter re-entrancy guard', () => {
  it('delivers each of 130 concurrent messages to exactly one sendPrompt payload', async () => {
    const { router, sends, probe } = makeHarness();
    const N = 130;
    const msgs = Array.from({ length: N }, (_, i) => makeMessage('cone', i));

    await Promise.all(msgs.map((m) => router.handleMessage(m)));

    // Serialized per jid: the read-modify-write of getMessagesSince never overlaps itself.
    expect(probe.max).toBe(1);
    for (let i = 0; i < N; i += 1) {
      const token = `MSG_${String(i).padStart(3, '0')}`;
      const count = sends.filter((p) => p.includes(token)).length;
      expect(count, `${token} appeared in ${count} payloads`).toBe(1);
    }
  });

  it('processes distinct scoops in parallel (guard is per-jid)', async () => {
    const { router, sends, probe } = makeHarness({ jids: ['coneA', 'coneB'] });

    await Promise.all([
      router.handleMessage(makeMessage('coneA', 0)),
      router.handleMessage(makeMessage('coneB', 1)),
    ]);

    expect(probe.max).toBe(2);
    expect(sends.some((p) => p.includes('MSG_000'))).toBe(true);
    expect(sends.some((p) => p.includes('MSG_001'))).toBe(true);
  });

  it('releases the guard when a turn throws so the queue is not wedged', async () => {
    const { router, sends } = makeHarness({ failFirstSend: true });

    await expect(router.handleMessage(makeMessage('cone', 0))).rejects.toThrow('boom');
    await router.handleMessage(makeMessage('cone', 1));

    expect(sends.some((p) => p.includes('MSG_001'))).toBe(true);
  });
});
