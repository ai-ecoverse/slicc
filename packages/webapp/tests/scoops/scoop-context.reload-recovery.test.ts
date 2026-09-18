/**
 * ScoopContext's side of reload recovery: the in-flight journal it keeps
 * while a turn runs, the eager persistence recovery relies on, and the two
 * entry points boot-time recovery calls (`resumeTurn`,
 * `settleInterruptedToolCalls`).
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnJournal } from '../../src/scoops/scoop-context/turn-journal.js';
import { ScoopContext, type ScoopContextCallbacks } from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const cone: RegisteredScoop = {
  jid: 'cone_1',
  name: 'cone',
  folder: 'cone',
  parentJid: null,
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: new Date().toISOString(),
};

function callbacks(): ScoopContextCallbacks {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    onToolEnd: vi.fn(),
    onToolStart: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({}) as never),
  };
}

function journalSpy() {
  return {
    begin: vi.fn(),
    toolStarted: vi.fn(),
    toolEnded: vi.fn(),
    setGuestGates: vi.fn(),
    end: vi.fn(),
  };
}

function canonicalSpy() {
  return {
    load: vi.fn().mockResolvedValue(null),
    syncAgentMessages: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

interface MockAgent {
  prompt: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  clearAllQueues: ReturnType<typeof vi.fn>;
  state: { isStreaming: boolean; messages: unknown[] };
}

function setup(opts: { prompt?: () => Promise<void>; messages?: unknown[] } = {}) {
  const cb = callbacks();
  const journal = journalSpy();
  const canonical = canonicalSpy();
  const ctx = new ScoopContext(
    cone,
    cb,
    {} as never,
    undefined,
    undefined,
    'cone_1',
    undefined,
    undefined,
    canonical as never,
    undefined,
    journal as unknown as TurnJournal
  );
  const agent: MockAgent = {
    prompt: vi.fn(opts.prompt ?? (async () => {})),
    continue: vi.fn(async () => {}),
    abort: vi.fn(),
    followUp: vi.fn(),
    steer: vi.fn(),
    clearAllQueues: vi.fn(),
    state: { isStreaming: false, messages: opts.messages ?? [] },
  };
  const internals = ctx as unknown as { agent: MockAgent; status: string };
  internals.agent = agent;
  internals.status = 'ready';
  const emit = (event: unknown) =>
    (ctx as unknown as { handleAgentEvent(e: unknown): void }).handleAgentEvent(event);
  return { ctx, cb, journal, canonical, agent, emit };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ScoopContext turn journal', () => {
  it('journals a turn from its start until it settles, with its guest gates', async () => {
    const { ctx, journal } = setup();
    const gates = [{ requester: 'guest-1' }];
    await ctx.prompt('hello', [], { guestGates: gates });
    expect(journal.begin).toHaveBeenCalledWith('cone_1', 'cone', 0, gates);
    expect(journal.end).toHaveBeenCalledWith('cone_1');
    expect(journal.begin.mock.invocationCallOrder[0]).toBeLessThan(
      journal.end.mock.invocationCallOrder[0]
    );
  });

  it('clears the record even when the turn fails', async () => {
    const { ctx, journal } = setup({
      prompt: async () => {
        throw new Error('401 Unauthorized');
      },
    });
    await ctx.prompt('hello');
    expect(journal.end).toHaveBeenCalledWith('cone_1');
  });

  it('widens the journaled gates when a guest prompt queues into the running turn', async () => {
    let release!: () => void;
    const { ctx, journal } = setup({
      prompt: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const running = ctx.prompt('owner');
    await vi.waitFor(() => expect(journal.begin).toHaveBeenCalled());
    await ctx.prompt('guest', [], { guestGates: [{ requester: 'guest-1' }] });
    expect(journal.setGuestGates).toHaveBeenCalledWith('cone_1', [{ requester: 'guest-1' }]);
    release();
    await running;
  });

  it('journals tool calls and makes the issuing message durable before the tool runs', () => {
    const { journal, canonical, emit, cb } = setup({
      messages: [{ role: 'user', content: 'go', timestamp: 1 }],
    });
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { c: 1 }, toolCallId: 'a' });
    expect(canonical.syncAgentMessages).toHaveBeenCalledTimes(1);
    expect(journal.toolStarted).toHaveBeenCalledWith('cone_1', 'a', 'bash', { c: 1 });
    expect(cb.onToolStart).toHaveBeenCalledWith('bash', { c: 1 }, 'a');

    emit({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'a',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    expect(journal.toolEnded).toHaveBeenCalledWith('cone_1', 'a');
    expect(cb.onToolEnd).toHaveBeenCalledWith('bash', 'ok', false, 'a');
  });

  it('tool events without a call id are surfaced but not journaled', () => {
    const { journal, emit } = setup();
    emit({ type: 'tool_execution_start', toolName: 'bash', args: {} });
    emit({ type: 'tool_execution_end', toolName: 'bash', isError: false, result: {} });
    expect(journal.toolStarted).not.toHaveBeenCalled();
    expect(journal.toolEnded).not.toHaveBeenCalled();
  });

  it('flushes a user message at once but debounces everything else', () => {
    vi.useFakeTimers();
    const { canonical, emit } = setup({ messages: [{ role: 'user', content: 'x', timestamp: 1 }] });
    emit({ type: 'message_end', message: { role: 'user', content: 'x', timestamp: 1 } });
    expect(canonical.syncAgentMessages).toHaveBeenCalledTimes(1);

    emit({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 'a', content: [], isError: false, timestamp: 2 },
    });
    expect(canonical.syncAgentMessages).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_500);
    expect(canonical.syncAgentMessages).toHaveBeenCalledTimes(2);
  });

  it('a deliberate dispose is not an interruption', () => {
    const { ctx, journal } = setup();
    ctx.dispose();
    expect(journal.end).toHaveBeenCalledWith('cone_1');
  });
});

describe('ScoopContext.resumeTurn', () => {
  it('continues from the restored history, journaled with the resume count and gates', async () => {
    const { ctx, agent, journal } = setup({
      messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    });
    const gates = [{ requester: 'guest-1' }];
    await ctx.resumeTurn(1, gates);
    expect(agent.continue).toHaveBeenCalledTimes(1);
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(journal.begin).toHaveBeenCalledWith('cone_1', 'cone', 1, gates);
    expect(journal.end).toHaveBeenCalledWith('cone_1');
  });

  it('drops an errored assistant tail before continuing (a failed attempt)', async () => {
    const { ctx, agent } = setup({
      messages: [
        { role: 'user', content: 'hi', timestamp: 1 },
        { role: 'assistant', content: [], stopReason: 'error', timestamp: 2 },
      ],
    });
    await ctx.resumeTurn(1);
    expect(agent.state.messages).toEqual([{ role: 'user', content: 'hi', timestamp: 1 }]);
    expect(agent.continue).toHaveBeenCalled();
  });

  it('does nothing when the unit is already busy', async () => {
    const { ctx, agent } = setup();
    agent.state.isStreaming = true;
    await ctx.resumeTurn(1);
    expect(agent.continue).not.toHaveBeenCalled();
  });
});

describe('ScoopContext.settleInterruptedToolCalls', () => {
  it('answers each call with an error result, persists, and surfaces it', () => {
    const { ctx, agent, canonical, cb } = setup({
      messages: [{ role: 'user', content: 'go', timestamp: 1 }],
    });
    ctx.settleInterruptedToolCalls([{ toolCallId: 'a', toolName: 'bash', text: 'Interrupted' }]);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'a',
      toolName: 'bash',
      isError: true,
      content: [{ type: 'text', text: 'Interrupted' }],
    });
    expect(canonical.syncAgentMessages).toHaveBeenCalledTimes(1);
    expect(cb.onToolEnd).toHaveBeenCalledWith('bash', 'Interrupted', true, 'a');
  });

  it('is a no-op for no calls or no agent', () => {
    const { ctx, canonical } = setup();
    ctx.settleInterruptedToolCalls([]);
    expect(canonical.syncAgentMessages).not.toHaveBeenCalled();
    (ctx as unknown as { agent: null }).agent = null;
    ctx.settleInterruptedToolCalls([{ toolCallId: 'a', toolName: 'bash', text: 'x' }]);
    expect(ctx.hasAgent()).toBe(false);
  });

  it('reportError goes to the error channel', () => {
    const { ctx, cb } = setup();
    ctx.reportError('lost');
    expect(cb.onError).toHaveBeenCalledWith('lost');
  });
});
