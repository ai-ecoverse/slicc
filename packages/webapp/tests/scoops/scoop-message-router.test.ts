import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAfterMessageWatermark, parseMessageWatermark } from '../../src/scoops/db.js';
import type { ScoopContext } from '../../src/scoops/scoop-context.js';
import type { ScoopMessageRouterDeps } from '../../src/scoops/scoop-message-router.js';
import {
  SCOOP_DEFERRAL_STARVATION_MS,
  SCOOP_QUEUE_DEBOUNCE_MS,
  SCOOP_QUEUE_MAX_COALESCE_MS,
  ScoopMessageRouter,
} from '../../src/scoops/scoop-message-router.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from '../../src/scoops/types.js';

/** Yield to the microtask/timer queue so concurrent turns genuinely interleave. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeScoop(jid: string): RegisteredScoop {
  return {
    jid,
    name: jid,
    folder: jid,
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: new Date().toISOString(),
  };
}

function makeMessage(jid: string, i: number, channel = 'chat'): ChannelMessage {
  return {
    id: `id-${jid}-${i}`,
    chatJid: jid,
    senderId: 'user',
    senderName: 'user',
    content: `MSG_${String(i).padStart(3, '0')}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i).toISOString(),
    fromAssistant: false,
    channel,
  };
}

interface Harness {
  router: ScoopMessageRouter;
  sends: string[];
  senders: string[];
  probe: { max: number };
  stateWrites: string[];
  store: ChannelMessage[];
  errors: string[];
  backpressure: Array<{ jid: string; count: number; waitingMs: number }>;
}

function makeHarness(opts?: {
  failFirstSend?: boolean;
  immediateIO?: boolean;
  jids?: string[];
  onSend?: () => Promise<void>;
  busy?: { value: boolean };
  tabStatus?: ScoopTabState['status'];
  store?: ChannelMessage[];
  lastAgentTimestamp?: string;
  onError?: (jid: string, error: string) => void;
  onLickBackpressure?: (jid: string, info: { count: number; waitingMs: number }) => void;
  scoop?: Partial<RegisteredScoop>;
}): Harness {
  const jids = opts?.jids ?? ['cone'];
  const scoops = new Map<string, RegisteredScoop>();
  const tabs = new Map<string, ScoopTabState>();
  for (const jid of jids) {
    scoops.set(jid, { ...makeScoop(jid), ...opts?.scoop });
    tabs.set(jid, { jid, contextId: jid, status: opts?.tabStatus ?? 'ready', lastActivity: '' });
  }

  const store = opts?.store ?? [];
  const sends: string[] = [];
  const senders: string[] = [];
  const stateWrites: string[] = [];
  const errors: string[] = [];
  const backpressure: Array<{ jid: string; count: number; waitingMs: number }> = [];
  const probe = { max: 0 };
  let active = 0;
  let sendCount = 0;
  const pause = opts?.immediateIO ? async () => {} : tick;

  const deps: ScoopMessageRouterDeps = {
    getScoops: () => scoops,
    getTabs: () => tabs,
    getContexts: () =>
      new Map(
        jids.map((jid) => [
          jid,
          {
            get isBusy() {
              return opts?.busy?.value ?? false;
            },
            clearMessages() {},
          } as ScoopContext,
        ])
      ),
    createScoopTab: async () => {},
    sendPrompt: async (_jid, text, senderId, senderName) => {
      await pause();
      if (opts?.onSend) await opts.onSend();
      if (opts?.failFirstSend && sendCount++ === 0) throw new Error('boom');
      sends.push(text);
      senders.push(`${senderId}:${senderName}`);
    },
    notifyIncomingMessage: () => {},
    onError: (jid, error) => {
      errors.push(error);
      opts?.onError?.(jid, error);
    },
    onLickBackpressure: (jid, info) => {
      backpressure.push({ jid, ...info });
      opts?.onLickBackpressure?.(jid, info);
    },
    getSessionStore: () => null,
    resetCostTracker: () => {},
    db: {
      saveMessage: async (msg) => {
        await pause();
        store.push(msg);
      },
      deleteMessage: async (id) => {
        const index = store.findIndex((message) => message.id === id);
        if (index !== -1) store.splice(index, 1);
      },
      clearMessagesForScoop: async (jid) => {
        for (let index = store.length - 1; index >= 0; index -= 1) {
          if (store[index].chatJid === jid) store.splice(index, 1);
        }
      },
      clearAllMessages: async () => {
        store.length = 0;
      },
      getMessagesSince: async (jid, since, excludeName) => {
        active += 1;
        probe.max = Math.max(probe.max, active);
        await pause();
        const wm = parseMessageWatermark(since);
        const result = store
          .filter(
            (m) =>
              m.chatJid === jid && isAfterMessageWatermark(m, wm) && m.senderName !== excludeName
          )
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
        active -= 1;
        return result;
      },
      setState: async (_key, value) => {
        stateWrites.push(value);
      },
    },
    isExternalLickChannel: (channel) =>
      new Set<ChannelMessage['channel']>([
        'webhook',
        'cron',
        'fswatch',
        'sprinkle',
        'navigate',
      ]).has(channel),
  };

  const router = new ScoopMessageRouter(deps);
  for (const jid of jids) router.ensureQueue(jid);
  if (opts?.lastAgentTimestamp) router.setLastAgentTimestamp(jids[0], opts.lastAgentTimestamp);
  return { router, sends, senders, probe, stateWrites, store, errors, backpressure };
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

  it('drains a rerun coalesced onto a turn that then throws', async () => {
    let coalesced: Promise<void> | undefined;
    // Enqueued from inside the failing turn — after `runScoopQueue` took its DB
    // snapshot and cleared the shared queue — so the rerun is the only thing
    // left that can deliver it.
    const harness: Harness = makeHarness({
      failFirstSend: true,
      onSend: async () => {
        coalesced ??= harness.router.handleMessage(makeMessage('cone', 1));
        await tick();
        await tick();
      },
    });

    await expect(harness.router.handleMessage(makeMessage('cone', 0))).rejects.toThrow('boom');
    // biome-ignore lint/nursery/noFloatingPromises: already awaited; biome 2.5.6 mis-infers the `??=` assignment as a nested promise and suggests `await await`
    await coalesced;

    expect(harness.sends.some((p) => p.includes('MSG_001'))).toBe(true);
  });
});

describe('ScoopMessageRouter same-millisecond high-water mark', () => {
  /** A message pinned to a shared millisecond; ids arrive in descending order so an id-ordered tie-break would drop siblings. */
  function makeSameMsMessage(jid: string, i: number, count: number): ChannelMessage {
    return {
      id: `same-${jid}-${String(count - i).padStart(3, '0')}`,
      chatJid: jid,
      senderId: 'user',
      senderName: 'user',
      content: `MSG_${String(i).padStart(3, '0')}`,
      timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      fromAssistant: false,
      channel: 'chat',
    };
  }

  it('delivers each of N same-millisecond messages exactly once across successive passes', async () => {
    const { router, sends } = makeHarness();
    const N = 8;

    // Awaited sequentially, so each handleMessage drains a separate
    // processScoopQueue pass — the watermark must carry enough state to skip
    // the already-delivered same-ms rows without dropping the new ones.
    for (let i = 0; i < N; i += 1) {
      await router.handleMessage(makeSameMsMessage('cone', i, N));
    }

    for (let i = 0; i < N; i += 1) {
      const token = `MSG_${String(i).padStart(3, '0')}`;
      const count = sends.filter((p) => p.includes(token)).length;
      expect(count, `${token} appeared in ${count} payloads`).toBe(1);
    }
  });
});

describe('ScoopMessageRouter trigger gate', () => {
  const triggerScoop: Partial<RegisteredScoop> = {
    parentJid: 'cone',
    requiresTrigger: true,
    trigger: '@scoop',
  };

  it('advances past a persisted rejected row without deferring or replaying it', async () => {
    const busy = { value: true };
    const { router, sends, stateWrites } = makeHarness({
      busy,
      jids: ['scoop'],
      scoop: triggerScoop,
      tabStatus: 'processing',
    });
    const rejected = { ...makeMessage('scoop', 0, 'navigate'), content: 'not for this scoop' };

    await router.handleMessage(rejected);
    await router.flushOnIdle('scoop');
    await router.flushOnIdle('scoop');

    expect(sends).toEqual([]);
    expect(stateWrites).toHaveLength(1);
  });

  it('delivers only eligible rows and uses the last eligible sender', async () => {
    const eligible = {
      ...makeMessage('scoop', 0),
      content: 'hello @scoop',
      senderId: 'eligible-id',
      senderName: 'eligible-name',
    };
    const rejected = {
      ...makeMessage('scoop', 1),
      content: 'not for this scoop',
      senderId: 'rejected-id',
      senderName: 'rejected-name',
    };
    const { router, sends, senders } = makeHarness({
      jids: ['scoop'],
      scoop: triggerScoop,
      store: [eligible, rejected],
    });

    await router.flushOnIdle('scoop');

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('hello @scoop');
    expect(sends[0]).not.toContain('not for this scoop');
    expect(senders).toEqual(['eligible-id:eligible-name']);
  });

  // `bash` is in this list because a detached job's completion is the result of
  // work the scoop itself started: gating it on the scoop's `@trigger` (which
  // nothing types into a machine-generated lick) would drop the result the bash
  // tool promised when it handed back a job id.
  it.each<ChannelMessage['channel']>(['webhook', 'cron', 'fswatch', 'sprinkle', 'bash'])(
    'lets %s rows bypass the trigger gate',
    async (channel) => {
      const message = { ...makeMessage('scoop', 0, channel), content: 'no trigger' };
      const { router, sends } = makeHarness({
        jids: ['scoop'],
        scoop: triggerScoop,
        store: [message],
      });

      await router.flushOnIdle('scoop');

      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain('no trigger');
    }
  );

  it('never gates a cone', async () => {
    const message = { ...makeMessage('cone', 0), content: 'no trigger' };
    const { router, sends } = makeHarness({
      scoop: { requiresTrigger: true, trigger: '@cone' },
      store: [message],
    });

    await router.flushOnIdle('cone');

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('no trigger');
  });
});

describe('ScoopMessageRouter debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function queueLicks(router: ScoopMessageRouter, messages: ChannelMessage[]) {
    const pending = Promise.all(messages.map((message) => router.handleMessage(message)));
    await vi.advanceTimersByTimeAsync(0);
    return { done: pending };
  }

  async function flushDebounce(): Promise<void> {
    await vi.advanceTimersByTimeAsync(SCOOP_QUEUE_DEBOUNCE_MS);
  }

  it('coalesces a burst into one trailing prompt', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage('cone', i, 'webhook'));

    const { done } = await queueLicks(router, messages);
    expect(sends).toEqual([]);

    await vi.advanceTimersByTimeAsync(SCOOP_QUEUE_DEBOUNCE_MS - 1);
    expect(sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(sends).toHaveLength(1);
    for (let i = 0; i < messages.length; i += 1) {
      expect(sends[0]).toContain(`MSG_${String(i).padStart(3, '0')}`);
    }
  });

  it('dispatches an isolated message after one window', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });

    const { done } = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    await flushDebounce();
    await done;

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_000');
  });

  it('keeps trailing windows isolated per scoop', async () => {
    const { router, sends } = makeHarness({ immediateIO: true, jids: ['coneA', 'coneB'] });

    const first = await queueLicks(router, [makeMessage('coneA', 0, 'webhook')]);
    await vi.advanceTimersByTimeAsync(500);
    const second = await queueLicks(router, [makeMessage('coneB', 1, 'webhook')]);
    await vi.advanceTimersByTimeAsync(400);
    const third = await queueLicks(router, [makeMessage('coneA', 2, 'webhook')]);
    await vi.advanceTimersByTimeAsync(600);
    await second.done;

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_001');
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([first.done, third.done]);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain('MSG_000');
    expect(sends[1]).toContain('MSG_002');
  });

  it('does not let the poll split an active trailing window', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });
    router.startMessageLoop();
    await vi.advanceTimersByTimeAsync(1500);
    const first = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);

    await vi.advanceTimersByTimeAsync(500);
    expect(sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    const second = await queueLicks(router, [makeMessage('cone', 1, 'webhook')]);
    await vi.advanceTimersByTimeAsync(SCOOP_QUEUE_DEBOUNCE_MS);
    await Promise.all([first.done, second.done]);

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_000');
    expect(sends[0]).toContain('MSG_001');
    router.stopMessageLoop();
  });

  it('bounds a sustained lick stream by the max-wait deadline', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });
    router.startMessageLoop();
    const pending = [await queueLicks(router, [makeMessage('cone', 0, 'webhook')])];
    await vi.advanceTimersByTimeAsync(800);
    pending.push(await queueLicks(router, [makeMessage('cone', 1, 'webhook')]));
    await vi.advanceTimersByTimeAsync(800);
    pending.push(await queueLicks(router, [makeMessage('cone', 2, 'webhook')]));
    await vi.advanceTimersByTimeAsync(800);
    pending.push(await queueLicks(router, [makeMessage('cone', 3, 'webhook')]));

    await vi.advanceTimersByTimeAsync(SCOOP_QUEUE_MAX_COALESCE_MS - 2401);
    expect(sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(pending.map(({ done }) => done));

    expect(sends).toHaveLength(1);
    router.stopMessageLoop();
  });

  it('delivers web messages immediately without a debounce timer', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });

    await router.handleMessage(makeMessage('cone', 0, 'web'));

    expect(sends).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an immediate web message flush a pending lick batch', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });
    const lick = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    await vi.advanceTimersByTimeAsync(500);

    await router.handleMessage(makeMessage('cone', 1, 'web'));
    await lick.done;

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_000');
    expect(sends[0]).toContain('MSG_001');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates immediate web-message send failures', async () => {
    const { router } = makeHarness({ failFirstSend: true, immediateIO: true });

    await expect(router.handleMessage(makeMessage('cone', 0, 'web'))).rejects.toThrow('boom');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps debounced delivery awaitable and propagates send failures', async () => {
    const { router } = makeHarness({ failFirstSend: true, immediateIO: true });
    const { done } = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    const rejected = expect(done).rejects.toThrow('boom');

    await flushDebounce();

    await rejected;
  });

  it('defers a pure lick batch while busy without advancing its watermark', async () => {
    const busy = { value: true };
    const { router, sends, stateWrites } = makeHarness({
      immediateIO: true,
      busy,
      tabStatus: 'processing',
    });
    const queued = await queueLicks(router, [
      makeMessage('cone', 0, 'webhook'),
      makeMessage('cone', 1, 'webhook'),
    ]);

    await flushDebounce();
    await expect(queued.done).resolves.toEqual([undefined, undefined]);
    expect(sends).toEqual([]);
    expect(stateWrites).toEqual([]);

    busy.value = false;
    await router.flushOnIdle('cone');

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_000');
    expect(sends[0]).toContain('MSG_001');
    expect(stateWrites).toHaveLength(1);
  });

  it('dispatches a mixed web-and-lick batch immediately while busy', async () => {
    const busy = { value: true };
    const { router, sends } = makeHarness({ immediateIO: true, busy, tabStatus: 'processing' });
    const lick = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);

    await router.handleMessage(makeMessage('cone', 1, 'web'));
    await lick.done;

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_000');
    expect(sends[0]).toContain('MSG_001');
  });

  it('preserves baseline guard ordering for an active-turn mixed batch', async () => {
    const busy = { value: false };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let sendCount = 0;
    const { router, sends } = makeHarness({
      immediateIO: true,
      busy,
      onSend: async () => {
        sendCount += 1;
        if (sendCount !== 1) return;
        busy.value = true;
        markStarted();
        await turnDone;
        busy.value = false;
      },
    });
    const activeTurn = router.handleMessage(makeMessage('cone', 0, 'web'));
    await started;
    const lick = await queueLicks(router, [makeMessage('cone', 1, 'webhook')]);
    let webSettled = false;

    const web = router.handleMessage(makeMessage('cone', 2, 'web')).then(() => {
      webSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(webSettled).toBe(false);
    expect(sends).toEqual([]);

    releaseTurn();
    await Promise.all([activeTurn, web, lick.done]);
    expect(sends).toHaveLength(2);
    for (const token of ['MSG_000', 'MSG_001', 'MSG_002']) {
      expect(sends.filter((prompt) => prompt.includes(token))).toHaveLength(1);
    }
  });

  it('settles lick waiters while an earlier queue drain is still mid-turn', async () => {
    const busy = { value: false };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let sendCount = 0;
    const { router, sends } = makeHarness({
      immediateIO: true,
      busy,
      onSend: async () => {
        sendCount += 1;
        if (sendCount !== 1) return;
        busy.value = true;
        markStarted();
        await turnDone;
        busy.value = false;
      },
    });
    const activeTurn = router.handleMessage(makeMessage('cone', 0, 'web'));
    await started;
    const lick = await queueLicks(router, [makeMessage('cone', 1, 'webhook')]);

    await flushDebounce();
    await expect(lick.done).resolves.toEqual([undefined]);
    expect(sends).toEqual([]);

    releaseTurn();
    await activeTurn;
    await router.flushOnIdle('cone');
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain('MSG_001');
  });

  it('settles a starved lick waiter when the backpressure callback throws during an active drain', async () => {
    const busy = { value: false };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const { router, errors, backpressure } = makeHarness({
      immediateIO: true,
      busy,
      onLickBackpressure: () => {
        throw new Error('backpressure callback failed');
      },
      onSend: async () => {
        busy.value = true;
        markStarted();
        await turnDone;
        busy.value = false;
      },
    });
    const activeTurn = router.handleMessage(makeMessage('cone', 0, 'web'));
    await started;
    const first = await queueLicks(router, [makeMessage('cone', 1, 'webhook')]);
    await flushDebounce();
    await first.done;
    await vi.advanceTimersByTimeAsync(SCOOP_DEFERRAL_STARVATION_MS);
    const starved = await queueLicks(router, [makeMessage('cone', 2, 'webhook')]);

    await flushDebounce();
    await expect(starved.done).resolves.toEqual([undefined]);
    expect(backpressure).toHaveLength(1);
    expect(errors).toEqual([]);

    releaseTurn();
    await activeTurn;
  });

  it('recovers deferred IDB messages through idle flush after router reconstruction', async () => {
    const busy = { value: false };
    const first = makeHarness({ immediateIO: true, busy });
    await first.router.handleMessage(makeMessage('cone', 0, 'web'));
    const restoredWatermark = first.stateWrites.at(-1);
    busy.value = true;
    const lick = await queueLicks(first.router, [makeMessage('cone', 1, 'webhook')]);
    await flushDebounce();
    await lick.done;

    const restored = makeHarness({
      immediateIO: true,
      store: first.store,
      lastAgentTimestamp: restoredWatermark,
    });
    await restored.router.flushOnIdle('cone');

    expect(restored.sends).toHaveLength(1);
    expect(restored.sends[0]).not.toContain('MSG_000');
    expect(restored.sends[0]).toContain('MSG_001');
  });

  it('delivers a reconstructed deferred row once across concurrent startup probes', async () => {
    const message = makeMessage('cone', 0, 'webhook');
    const restored = makeHarness({ immediateIO: true, store: [message] });

    await Promise.all([restored.router.flushOnIdle('cone'), restored.router.flushOnIdle('cone')]);

    expect(restored.sends).toHaveLength(1);
    expect(restored.sends[0]).toContain('MSG_000');
  });

  it('uses the poll loop as a safety-net flush after busy deferral', async () => {
    const busy = { value: true };
    const { router, sends } = makeHarness({ immediateIO: true, busy });
    router.startMessageLoop();
    const lick = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    await flushDebounce();
    await lick.done;

    busy.value = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('MSG_000');
    router.stopMessageLoop();
  });

  it('clears deferred IDB messages after router reconstruction', async () => {
    const busy = { value: true };
    const first = makeHarness({ immediateIO: true, busy });
    const lick = await queueLicks(first.router, [makeMessage('cone', 0, 'webhook')]);
    await flushDebounce();
    await lick.done;

    const restored = makeHarness({ immediateIO: true, store: first.store });
    await restored.router.clearQueuedMessages('cone');
    restored.router.startMessageLoop();
    await vi.advanceTimersByTimeAsync(2000);

    expect(restored.store).toEqual([]);
    expect(restored.sends).toEqual([]);
    restored.router.stopMessageLoop();
  });

  it('preserves protected IDB rows when clearing a reconstructed deferred queue', async () => {
    const busy = { value: false };
    const first = makeHarness({ immediateIO: true, busy });
    const processed = makeMessage('cone', 0, 'web');
    await first.router.handleMessage(processed);
    const restoredWatermark = first.stateWrites.at(-1);
    busy.value = true;
    const deferred = makeMessage('cone', 1, 'webhook');
    const lick = await queueLicks(first.router, [deferred]);
    await flushDebounce();
    await lick.done;
    const assistant = { ...makeMessage('cone', 2), senderName: 'sliccy', fromAssistant: true };
    const otherScoop = makeMessage('other', 3, 'webhook');
    first.store.push(assistant, otherScoop);

    const restored = makeHarness({
      immediateIO: true,
      jids: ['cone', 'other'],
      store: first.store,
      lastAgentTimestamp: restoredWatermark,
    });
    await restored.router.clearQueuedMessages('cone');

    expect(restored.store.map((message) => message.id)).toEqual([
      processed.id,
      assistant.id,
      otherScoop.id,
    ]);
  });

  it('reports a permanently busy deferred queue once without dispatching it', async () => {
    const busy = { value: true };
    const { router, sends, errors, backpressure } = makeHarness({
      immediateIO: true,
      busy,
      tabStatus: 'processing',
    });
    router.startMessageLoop();
    const lick = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    await flushDebounce();
    await lick.done;

    await vi.advanceTimersByTimeAsync(SCOOP_DEFERRAL_STARVATION_MS + 2000);

    expect(sends).toEqual([]);
    expect(errors).toEqual([]);
    expect(backpressure).toEqual([
      {
        jid: 'cone',
        count: 1,
        waitingMs: expect.any(Number),
      },
    ]);
    expect(backpressure[0].waitingMs).toBeGreaterThanOrEqual(SCOOP_DEFERRAL_STARVATION_MS);
    await vi.advanceTimersByTimeAsync(SCOOP_DEFERRAL_STARVATION_MS);
    expect(backpressure).toHaveLength(1);
    router.stopMessageLoop();
  });

  it('raises backpressure at the five-minute boundary but not one millisecond before', async () => {
    expect(SCOOP_DEFERRAL_STARVATION_MS).toBe(300_000);
    const busy = { value: true };
    const { router, backpressure } = makeHarness({
      immediateIO: true,
      busy,
      tabStatus: 'processing',
    });
    const lick = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    await flushDebounce();
    await lick.done;

    await vi.advanceTimersByTimeAsync(SCOOP_DEFERRAL_STARVATION_MS - 1);
    await router.processScoopQueue('cone');
    expect(backpressure).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await router.processScoopQueue('cone');
    expect(backpressure).toEqual([
      { jid: 'cone', count: 1, waitingMs: SCOOP_DEFERRAL_STARVATION_MS },
    ]);
  });

  it('retracts reported backpressure when the deferred queue drains', async () => {
    const busy = { value: true };
    const { router, sends, backpressure } = makeHarness({
      immediateIO: true,
      busy,
      tabStatus: 'processing',
    });
    const lick = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    await flushDebounce();
    await lick.done;
    await vi.advanceTimersByTimeAsync(SCOOP_DEFERRAL_STARVATION_MS);
    await router.processScoopQueue('cone');

    busy.value = false;
    await router.flushOnIdle('cone');

    expect(sends).toHaveLength(1);
    expect(backpressure.map(({ count }) => count)).toEqual([1, 0]);
    expect(backpressure[1]).toEqual({
      jid: 'cone',
      count: 0,
      waitingMs: SCOOP_DEFERRAL_STARVATION_MS,
    });
  });

  const cleanupCases: Array<[string, (router: ScoopMessageRouter) => void | Promise<void>]> = [
    ['forgetScoop', (router) => router.forgetScoop('cone')],
    ['clearScoopMessages', (router) => router.clearScoopMessages('cone', undefined)],
    ['clearAllMessages', (router) => router.clearAllMessages()],
    ['clearQueuedMessages', (router) => router.clearQueuedMessages('cone')],
    ['stopMessageLoop', (router) => router.stopMessageLoop()],
  ];

  it.each(cleanupCases)('cancels pending dispatch on %s', async (_name, cleanup) => {
    const { router, sends } = makeHarness({ immediateIO: true });
    const { done } = await queueLicks(router, [makeMessage('cone', 0, 'webhook')]);
    expect(vi.getTimerCount()).toBe(1);

    await cleanup(router);
    expect(vi.getTimerCount()).toBe(0);
    await done;
    await flushDebounce();

    expect(sends).toEqual([]);
  });

  it('cancels pending dispatch when the final queued message is deleted', async () => {
    const { router, sends } = makeHarness({ immediateIO: true });
    const message = makeMessage('cone', 0, 'webhook');
    const { done } = await queueLicks(router, [message]);
    expect(vi.getTimerCount()).toBe(1);

    await router.deleteQueuedMessage('cone', message.id);
    expect(vi.getTimerCount()).toBe(0);
    await done;
    await flushDebounce();

    expect(sends).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
