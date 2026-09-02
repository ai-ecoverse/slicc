/**
 * Compact-on-idle: the timer arms when a ROOT settles into `ready` with the
 * flag on, the round runs the ordinary forced compaction, and its result is
 * adopted only if the thread stood still the whole time.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ enabledFlags: new Set<string>() }));
vi.mock('../../src/core/feature-flags.js', () => ({
  isFeatureEnabled: (id: string) => mocks.enabledFlags.has(id),
}));

import {
  IDLE_COMPACTION_MIN_TOKENS_KEY,
  IDLE_COMPACTION_MINUTES_KEY,
} from '../../src/core/idle-compaction-settings.js';
import type { Agent, AgentMessage } from '../../src/core/index.js';
import {
  IdleCompaction,
  type IdleCompactionDeps,
} from '../../src/scoops/scoop-context/idle-compaction.js';
import { ScoopContext, type ScoopContextCallbacks } from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

/** The node test environment has no `localStorage`; the settings module wants a Map-backed one. */
const storage = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
});

const bigUser = (): AgentMessage =>
  ({
    role: 'user',
    content: [{ type: 'text', text: 'work '.repeat(2000) }],
    timestamp: 1,
  }) as AgentMessage;
const summary = (): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text: '[summary]' }], timestamp: 2 }) as AgentMessage;

function fakeAgent(messages: AgentMessage[]) {
  return {
    state: { messages, model: { contextWindow: 200_000 }, isStreaming: false },
    abort: vi.fn(),
    clearAllQueues: vi.fn(),
  } as unknown as Agent;
}

function deps(over: Partial<IdleCompactionDeps> = {}) {
  const agent = fakeAgent([bigUser(), bigUser()]);
  const compactFn = vi.fn(async () => [summary()]);
  const base: IdleCompactionDeps = {
    isEnabled: () => true,
    getSettings: () => ({ idleMinutes: 5, minTokens: 100 }),
    getAgent: () => agent,
    isDisposed: () => false,
    isBusy: () => false,
    getCompactFn: () => compactFn,
    getCompactionApiKey: () => 'key',
    estimateTokens: (messages) => messages.length * 1000,
    onCompacted: vi.fn(),
    folder: 'cone',
    ...over,
  };
  return { deps: base, agent, compactFn };
}

describe('IdleCompaction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('arms for the configured window and fires the round', async () => {
    const { deps: d, agent, compactFn } = deps();
    const idle = new IdleCompaction(d);
    idle.arm();
    expect(idle.isArmed).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(compactFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.isArmed).toBe(false);
    expect(compactFn).toHaveBeenCalledWith(expect.any(Array), expect.any(AbortSignal), {
      force: true,
      trigger: 'idle',
      deferMemoryExtraction: expect.any(Function),
    });
    expect(agent.state.messages).toEqual([summary()]);
    expect(d.onCompacted).toHaveBeenCalledWith({ before: 2, after: 1 });
  });

  it('cancel() aborts the round in flight and nothing is adopted', async () => {
    const { deps: d, agent } = deps();
    let seenSignal: AbortSignal | undefined;
    d.getCompactFn = () => (_messages, signal) =>
      new Promise((resolve, reject) => {
        seenSignal = signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const idle = new IdleCompaction(d);
    const round = idle.runNow();
    expect(idle.isRunning).toBe(true);
    idle.cancel();
    expect(seenSignal?.aborted).toBe(true);
    expect(await round).toBe('cancelled');
    expect(agent.state.messages).toHaveLength(2);
    expect(d.onCompacted).not.toHaveBeenCalled();
  });

  it('a round whose compactor ignored the abort is still not adopted', async () => {
    const { deps: d, agent } = deps();
    let release!: () => void;
    d.getCompactFn = () => () =>
      new Promise((resolve) => {
        release = () => resolve([summary()]);
      });
    const idle = new IdleCompaction(d);
    const round = idle.runNow();
    idle.cancel();
    release();
    expect(await round).toBe('cancelled');
    expect(agent.state.messages).toHaveLength(2);
  });

  it('runs the deferred memory extraction only after the result is adopted', async () => {
    const extract = vi.fn(async () => undefined);
    const adopted = deps();
    adopted.deps.getCompactFn = () => async (_messages, _signal, options) => {
      options?.deferMemoryExtraction?.(extract);
      return [summary()];
    };
    expect(await new IdleCompaction(adopted.deps).runNow()).toBe('compacted');
    await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);

    const moved = deps();
    moved.deps.getCompactFn = () => async (_messages, _signal, options) => {
      options?.deferMemoryExtraction?.(extract);
      moved.agent.state.messages.push(bigUser());
      return [summary()];
    };
    expect(await new IdleCompaction(moved.deps).runNow()).toBe('thread-moved');
    await Promise.resolve();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('does not arm when disabled, disposed or agent-less; disarm cancels', async () => {
    const { deps: d, compactFn } = deps({ isEnabled: () => false });
    const idle = new IdleCompaction(d);
    idle.arm();
    expect(idle.isArmed).toBe(false);
    const { deps: d2 } = deps({ getAgent: () => null });
    new IdleCompaction(d2).arm();
    const { deps: d3, compactFn: c3 } = deps();
    const armed = new IdleCompaction(d3);
    armed.arm();
    armed.disarm();
    expect(armed.isArmed).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(compactFn).not.toHaveBeenCalled();
    expect(c3).not.toHaveBeenCalled();
  });

  it('gates: busy, missing prerequisites, and a context below the minimum', async () => {
    expect(await new IdleCompaction(deps({ isBusy: () => true }).deps).runNow()).toBe('busy');
    expect(
      await new IdleCompaction(deps({ getCompactionApiKey: () => undefined }).deps).runNow()
    ).toBe('unavailable');
    expect(await new IdleCompaction(deps({ getCompactFn: () => null }).deps).runNow()).toBe(
      'unavailable'
    );
    const small = deps({ getSettings: () => ({ idleMinutes: 5, minTokens: 5_000 }) });
    expect(await new IdleCompaction(small.deps).runNow()).toBe('below-minimum');
    expect(small.compactFn).not.toHaveBeenCalled();
    expect(await new IdleCompaction(deps({ isDisposed: () => true }).deps).runNow()).toBe(
      'disabled'
    );
  });

  it('discards the result when the thread moved during the round (in-place push)', async () => {
    const { deps: d, agent } = deps();
    const original = agent.state.messages;
    d.getCompactFn = () => async () => {
      // pi-agent-core appends in place: same array reference, new length.
      agent.state.messages.push(bigUser());
      return [summary()];
    };
    const idle = new IdleCompaction(d);
    expect(await idle.runNow()).toBe('thread-moved');
    expect(agent.state.messages).toBe(original);
    expect(agent.state.messages).toHaveLength(3);
    expect(d.onCompacted).not.toHaveBeenCalled();
  });

  it('discards the result when the history was replaced or a prompt started', async () => {
    const replaced = deps();
    replaced.deps.getCompactFn = () => async () => {
      replaced.agent.state.messages = [];
      return [summary()];
    };
    expect(await new IdleCompaction(replaced.deps).runNow()).toBe('thread-moved');
    expect(replaced.agent.state.messages).toEqual([]);

    let busy = false;
    const prompted = deps({ isBusy: () => busy });
    prompted.deps.getCompactFn = () => async () => {
      busy = true;
      return [summary()];
    };
    expect(await new IdleCompaction(prompted.deps).runNow()).toBe('thread-moved');
    expect(prompted.agent.state.messages).toHaveLength(2);
  });

  it('reports no-progress and failure without touching the history', async () => {
    const same = deps();
    same.deps.getCompactFn = () => async (messages) => [...messages];
    expect(await new IdleCompaction(same.deps).runNow()).toBe('no-progress');
    expect(same.agent.state.messages).toHaveLength(2);

    const failing = deps();
    failing.deps.getCompactFn = () => async () => {
      throw new Error('summary failed');
    };
    const idle = new IdleCompaction(failing.deps);
    expect(await idle.runNow()).toBe('failed');
    expect(idle.isRunning).toBe(false);
    expect(failing.agent.state.messages).toHaveLength(2);
  });

  it('refuses to overlap rounds', async () => {
    const { deps: d } = deps();
    let release!: () => void;
    d.getCompactFn = () => () =>
      new Promise((resolve) => {
        release = () => resolve([summary()]);
      });
    const idle = new IdleCompaction(d);
    const first = idle.runNow();
    expect(idle.isRunning).toBe(true);
    expect(await idle.runNow()).toBe('already-running');
    release();
    expect(await first).toBe('compacted');
  });
});

describe('ScoopContext wiring', () => {
  const cone: RegisteredScoop = {
    jid: 'cone_1',
    name: 'cone',
    folder: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: new Date().toISOString(),
  };
  const scoop: RegisteredScoop = { ...cone, jid: 'scoop_1', folder: 'helper', parentJid: 'cone_1' };

  function callbacks(): ScoopContextCallbacks {
    return {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onError: vi.fn(),
      onStatusChange: vi.fn(),
      onSendMessage: vi.fn(),
      getScoops: vi.fn(() => []),
      getGlobalMemory: vi.fn(async () => ''),
      getBrowserAPI: vi.fn(() => ({}) as never),
    };
  }

  type Internals = {
    agent: Agent | null;
    compactFn: unknown;
    getCompactionApiKey: (() => string | undefined) | null;
    /** `null` until the first eligible `ready` lazy-loads the module. */
    idleCompaction: IdleCompaction | null;
    idleCompactionLoading: Promise<IdleCompaction> | null;
    setStatus(status: 'ready' | 'processing'): void;
  };

  /** Let the lazy module load settle (real promises, even under fake timers). */
  async function settled(internals: Internals): Promise<void> {
    await internals.idleCompactionLoading;
    await Promise.resolve();
  }

  function inject(
    ctx: ScoopContext,
    compactFn: (m: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  ) {
    const internals = ctx as unknown as Internals;
    const agent = fakeAgent([bigUser(), bigUser()]);
    internals.agent = agent;
    internals.compactFn = compactFn;
    internals.getCompactionApiKey = () => 'key';
    return { internals, agent };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.enabledFlags.clear();
    localStorage.setItem(IDLE_COMPACTION_MINUTES_KEY, '1');
    localStorage.setItem(IDLE_COMPACTION_MIN_TOKENS_KEY, '1000');
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(IDLE_COMPACTION_MINUTES_KEY);
    localStorage.removeItem(IDLE_COMPACTION_MIN_TOKENS_KEY);
  });

  it('arms on ready for a root with the flag on and adopts the compacted history', async () => {
    mocks.enabledFlags.add('compact-on-idle');
    const ctx = new ScoopContext(cone, callbacks(), {} as never);
    const compactFn = vi.fn(async () => [summary()]);
    const { internals, agent } = inject(ctx, compactFn);

    internals.setStatus('ready');
    await settled(internals);
    expect(internals.idleCompaction?.isArmed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(agent.state.messages).toEqual([summary()]);
  });

  it('never loads for a scoop or with the flag off; processing disarms; dispose disarms', async () => {
    mocks.enabledFlags.add('compact-on-idle');
    const child = new ScoopContext(scoop, callbacks(), {} as never);
    const childInternals = inject(child, async () => []).internals;
    childInternals.setStatus('ready');
    await settled(childInternals);
    expect(childInternals.idleCompaction).toBeNull();

    mocks.enabledFlags.clear();
    const off = new ScoopContext(cone, callbacks(), {} as never);
    const offInternals = inject(off, async () => []).internals;
    offInternals.setStatus('ready');
    await settled(offInternals);
    expect(offInternals.idleCompaction).toBeNull();

    mocks.enabledFlags.add('compact-on-idle');
    const ctx = new ScoopContext(cone, callbacks(), {} as never);
    const { internals } = inject(ctx, async () => []);
    internals.setStatus('ready');
    await settled(internals);
    expect(internals.idleCompaction?.isArmed).toBe(true);
    internals.setStatus('processing');
    expect(internals.idleCompaction?.isArmed).toBe(false);
    internals.setStatus('ready');
    expect(internals.idleCompaction?.isArmed).toBe(true);
    ctx.dispose();
    expect(internals.idleCompaction?.isArmed).toBe(false);
  });

  it('stop() and clearSession() cut off a round in flight', async () => {
    mocks.enabledFlags.add('compact-on-idle');
    const ctx = new ScoopContext(cone, callbacks(), {} as never);
    let seenSignal: AbortSignal | undefined;
    const { internals, agent } = inject(
      ctx,
      (_messages: AgentMessage[], signal?: AbortSignal) =>
        new Promise<AgentMessage[]>((_resolve, reject) => {
          seenSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }) as never
    );
    internals.setStatus('ready');
    await settled(internals);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(internals.idleCompaction?.isRunning).toBe(true);
    ctx.stop();
    expect(seenSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.idleCompaction?.isRunning).toBe(false);
    expect(agent.state.messages).toHaveLength(2);
  });

  it('does not arm a unit that stopped being ready while the module was loading', async () => {
    mocks.enabledFlags.add('compact-on-idle');
    const ctx = new ScoopContext(cone, callbacks(), {} as never);
    const { internals } = inject(ctx, async () => []);
    internals.setStatus('ready');
    internals.setStatus('processing');
    await settled(internals);
    expect(internals.idleCompaction?.isArmed).toBe(false);
  });
});
