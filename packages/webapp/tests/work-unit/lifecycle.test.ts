import { describe, expect, it, type Mock, vi } from 'vitest';
import type { ScoopTabState } from '../../src/scoops/types.js';
import {
  LEGAL_TRANSITIONS,
  LiveWorkUnit,
  type LiveWorkUnitDeps,
  type UnitContext,
} from '../../src/work-unit/live-unit.js';
import { runWorkUnitConformance } from './conformance.js';
import { childRecord, rootRecord } from './fixtures.js';

type Status = ScoopTabState['status'];
const STATUSES: Status[] = ['initializing', 'ready', 'processing', 'error'];

function makeDeps(records = [rootRecord(), childRecord('cone_1')]) {
  const scoops = new Map(records.map((r) => [r.jid, r]));
  const deps: LiveWorkUnitDeps & {
    sendPrompt: ReturnType<typeof vi.fn<LiveWorkUnitDeps['sendPrompt']>>;
    clearIdleTimer: ReturnType<typeof vi.fn<LiveWorkUnitDeps['clearIdleTimer']>>;
    forgetCompletion: ReturnType<typeof vi.fn<LiveWorkUnitDeps['forgetCompletion']>>;
    unregister: ReturnType<typeof vi.fn<LiveWorkUnitDeps['unregister']>>;
  } = {
    getScoop: (jid) => scoops.get(jid),
    sendPrompt: vi.fn(async () => {}),
    clearIdleTimer: vi.fn(),
    forgetCompletion: vi.fn(),
    unregister: vi.fn(async () => {}),
  };
  return { deps, scoops };
}

function makeContext(): UnitContext & { stop: Mock<() => void>; dispose: Mock<() => void> } {
  return {
    init: vi.fn(async () => {}),
    stop: vi.fn(),
    dispose: vi.fn(),
    getAgentMessages: vi.fn(() => [{ role: 'user', content: 'hi' }]),
    getContextFill: vi.fn(() => 0.5),
  };
}

describe('LiveWorkUnit state machine', () => {
  it('starts as creating with no tab and no context', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('scoop_worker-scoop_1', deps);
    expect(unit.tab).toBeNull();
    expect(unit.context).toBeNull();
    expect(unit.status).toBe('creating');
    expect(unit.descriptor.status).toBe('creating');
  });

  it('accepts any first status on a unit without a tab', () => {
    for (const status of STATUSES) {
      const { deps } = makeDeps();
      const unit = new LiveWorkUnit('cone_1', deps);
      expect(unit.transition(status)).toBe(true);
      expect(unit.tab?.status).toBe(status);
      expect(unit.tab?.jid).toBe('cone_1');
    }
  });

  it('applies exactly the legal transition table', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const { deps } = makeDeps();
        const unit = new LiveWorkUnit('cone_1', deps);
        unit.transition(from);
        const ok = unit.transition(to);
        const expected = from === to || LEGAL_TRANSITIONS[from].has(to);
        expect(ok, `${from} → ${to}`).toBe(expected);
        expect(unit.tab?.status, `${from} → ${to}`).toBe(expected ? to : from);
      }
    }
  });

  it('encodes the lifecycle the runtime relies on', () => {
    // creating → ready ⇄ running; any → failed; failed → re-spawn / recover
    expect(LEGAL_TRANSITIONS.initializing.has('ready')).toBe(true);
    expect(LEGAL_TRANSITIONS.ready.has('processing')).toBe(true);
    expect(LEGAL_TRANSITIONS.processing.has('ready')).toBe(true);
    for (const from of STATUSES) {
      if (from !== 'error') expect(LEGAL_TRANSITIONS[from].has('error')).toBe(true);
    }
    expect(LEGAL_TRANSITIONS.error.has('initializing')).toBe(true);
    // a running turn cannot jump back to initializing
    expect(LEGAL_TRANSITIONS.processing.has('initializing')).toBe(false);
  });

  it('clears a stale error message when leaving error', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    unit.transition('error', { error: 'boom' });
    expect(unit.tab?.error).toBe('boom');
    unit.transition('ready');
    expect(unit.tab?.error).toBeUndefined();
  });

  it('maps tab status onto the descriptor lifecycle', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    unit.transition('initializing');
    expect(unit.status).toBe('creating');
    unit.transition('ready');
    expect(unit.status).toBe('ready');
    unit.transition('processing');
    expect(unit.status).toBe('running');
    unit.transition('error');
    expect(unit.status).toBe('failed');
  });

  it('touch updates lastActivity without changing status', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    unit.transition('ready', { lastActivity: '2020-01-01T00:00:00.000Z' });
    unit.touch();
    expect(unit.tab?.status).toBe('ready');
    expect(unit.tab?.lastActivity).not.toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('LiveWorkUnit context ownership', () => {
  it('attachContext starts the tab initializing under the given contextId', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    const ctx = makeContext();
    unit.attachContext(ctx, 'ctx-1');
    expect(unit.context).toBe(ctx);
    expect(unit.tab).toMatchObject({ jid: 'cone_1', contextId: 'ctx-1', status: 'initializing' });
  });

  it('disposeContext disposes and drops the tab but keeps observers (re-spawn)', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    const ctx = makeContext();
    unit.attachContext(ctx, 'ctx-1');
    const seen: string[] = [];
    unit.observe({ onStatusChange: (s) => seen.push(s) });
    unit.transition('error', { error: 'init failed' });

    unit.disposeContext();
    expect(ctx.dispose).toHaveBeenCalledOnce();
    expect(deps.clearIdleTimer).toHaveBeenCalledWith('cone_1');
    expect(unit.context).toBeNull();
    expect(unit.tab).toBeNull();
    expect(unit.observerCount).toBe(1);

    const fresh = makeContext();
    unit.attachContext(fresh, 'ctx-2');
    unit.transition('ready');
    unit.dispatch('onStatusChange', 'ready');
    expect(seen).toEqual(['ready']);
  });

  it('detachContext stops without disposing and keeps the tab (filesystem reset)', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    const ctx = makeContext();
    unit.attachContext(ctx, 'ctx-1');
    unit.transition('ready');
    unit.detachContext();
    expect(ctx.stop).toHaveBeenCalledOnce();
    expect(ctx.dispose).not.toHaveBeenCalled();
    expect(unit.context).toBeNull();
    expect(unit.tab?.status).toBe('ready');
    expect(unit.isClosed).toBe(false);
  });
});

describe('LiveWorkUnit.close() unregisters through the host', () => {
  it('routes to deps.unregister so the active-licks guard and record deletion apply', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('scoop_worker-scoop_1', deps);
    unit.attachContext(makeContext(), 'ctx-1');
    await unit.close();
    expect(deps.unregister).toHaveBeenCalledWith('scoop_worker-scoop_1');
    // teardown itself is the host's job (it ends in `teardown()`); close()
    // alone must not half-drop the unit.
    expect(unit.isClosed).toBe(false);
  });

  it('propagates the active-licks rejection unchanged and is a no-op once torn down', async () => {
    const { deps } = makeDeps();
    deps.unregister.mockRejectedValueOnce(new Error('has active licks'));
    const unit = new LiveWorkUnit('scoop_worker-scoop_1', deps);
    await expect(unit.close()).rejects.toThrow('has active licks');
    await unit.teardown();
    await unit.close();
    expect(deps.unregister).toHaveBeenCalledOnce();
  });
});

describe('LiveWorkUnit.teardown() is the single runtime teardown', () => {
  it('tears down idle timer, turn, context, observers and completion state in order', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('scoop_worker-scoop_1', deps);
    const ctx = makeContext();
    unit.attachContext(ctx, 'ctx-1');
    unit.transition('processing');
    const events: string[] = [];
    unit.observe({ onStatusChange: (s) => events.push(s) });

    const order: string[] = [];
    deps.clearIdleTimer.mockImplementation(() => order.push('idle'));
    ctx.stop.mockImplementation(() => order.push('stop'));
    ctx.dispose.mockImplementation(() => order.push('dispose'));
    deps.forgetCompletion.mockImplementation(() => order.push('forget'));

    await unit.teardown();

    expect(order).toEqual(['idle', 'stop', 'dispose', 'forget']);
    expect(deps.forgetCompletion).toHaveBeenCalledWith('scoop_worker-scoop_1', 'close');
    expect(unit.context).toBeNull();
    expect(unit.observerCount).toBe(0);
    expect(unit.isClosed).toBe(true);
    expect(unit.status).toBe('closed');
    expect(unit.descriptor.status).toBe('closed');

    // nothing reaches a closed unit
    unit.dispatch('onStatusChange', 'ready');
    expect(events).toEqual([]);
    expect(unit.transition('ready')).toBe(false);
    expect(unit.observe({})).toBeTypeOf('function');
    expect(unit.observerCount).toBe(0);
    await expect(unit.send({ text: 'x' })).rejects.toThrow(/closed/);
    expect(() => unit.attachContext(makeContext(), 'ctx-2')).toThrow(/closed/);
  });

  it('is idempotent and survives a throwing dispose', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    const ctx = makeContext();
    ctx.dispose.mockImplementation(() => {
      throw new Error('dispose exploded');
    });
    unit.attachContext(ctx, 'ctx-1');
    await expect(unit.teardown()).resolves.toBeUndefined();
    await unit.teardown();
    expect(ctx.dispose).toHaveBeenCalledOnce();
    expect(deps.forgetCompletion).toHaveBeenCalledOnce();
  });

  it('closes cleanly when no context was ever attached', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    await unit.teardown();
    expect(unit.isClosed).toBe(true);
    expect(deps.clearIdleTimer).toHaveBeenCalledWith('cone_1');
    expect(deps.forgetCompletion).toHaveBeenCalledWith('cone_1', 'close');
  });
});

describe('LiveWorkUnit runtime surface', () => {
  it('send routes through the host with sender defaults and steer passthrough', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('scoop_worker-scoop_1', deps);
    await unit.send({ text: 'go' });
    expect(deps.sendPrompt).toHaveBeenLastCalledWith(
      'scoop_worker-scoop_1',
      'go',
      'user',
      'worker-scoop',
      undefined
    );
    await unit.send({ text: 'now', senderId: 'cone', senderName: 'sliccy', steer: true });
    expect(deps.sendPrompt).toHaveBeenLastCalledWith(
      'scoop_worker-scoop_1',
      'now',
      'cone',
      'sliccy',
      {
        steer: true,
      }
    );
  });

  it('abort stops the running context only', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    await unit.abort();
    const ctx = makeContext();
    unit.attachContext(ctx, 'ctx-1');
    await unit.abort('user');
    expect(ctx.stop).toHaveBeenCalledOnce();
    expect(ctx.dispose).not.toHaveBeenCalled();
    expect(unit.isClosed).toBe(false);
  });

  it('snapshot reflects the live context', async () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    expect(await unit.snapshot()).toMatchObject({ messages: [], contextFill: 0 });
    unit.attachContext(makeContext(), 'ctx-1');
    const snap = await unit.snapshot();
    expect(snap.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(snap.contextFill).toBe(0.5);
  });

  it('a throwing observer does not break the others', () => {
    const { deps } = makeDeps();
    const unit = new LiveWorkUnit('cone_1', deps);
    const seen: string[] = [];
    unit.observe({
      onResponse: () => {
        throw new Error('observer bug');
      },
    });
    unit.observe({ onResponse: (t) => seen.push(t) });
    unit.dispatch('onResponse', 'hello', false);
    expect(seen).toEqual(['hello']);
  });

  it('throws a descriptor for an unregistered id', () => {
    const { deps } = makeDeps([]);
    const unit = new LiveWorkUnit('ghost', deps);
    expect(() => unit.descriptor).toThrow(/Work unit not found/);
  });

  runWorkUnitConformance('LiveWorkUnit (Phase 2 owner)', () => {
    const { deps } = makeDeps();
    const root = new LiveWorkUnit('cone_1', deps);
    const child = new LiveWorkUnit('scoop_worker-scoop_1', deps);
    const units = new Map([
      [root.id, root],
      [child.id, child],
    ]);
    return {
      root,
      child,
      emitStatus: (id, status) => {
        const unit = units.get(id)!;
        unit.transition(status);
        unit.dispatch('onStatusChange', status);
      },
    };
  });
});
