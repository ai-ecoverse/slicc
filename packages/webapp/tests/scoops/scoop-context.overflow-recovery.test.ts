import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoopContext, type ScoopContextCallbacks } from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const scoop: RegisteredScoop = {
  jid: 'scoop_overflow',
  name: 'overflow-worker',
  folder: 'overflow-worker',
  parentJid: 'cone',
  requiresTrigger: false,
  assistantLabel: 'overflow-worker',
  addedAt: new Date().toISOString(),
};

const userMessage = () => ({
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'work '.repeat(100) }],
});
const overflowMessage = () => ({
  role: 'assistant' as const,
  content: [],
  stopReason: 'error' as const,
  errorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
  usage: { input: 250000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 250000 },
  timestamp: Date.now(),
});
const successMessage = () => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'done' }],
  stopReason: 'stop' as const,
  usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
  timestamp: Date.now(),
});
const assistantErrorMessage = (errorMessage: string) => ({
  role: 'assistant' as const,
  content: [],
  stopReason: 'error' as const,
  errorMessage,
  usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
  timestamp: Date.now(),
});

function callbacks(): ScoopContextCallbacks {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onFatalError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({}) as never),
  };
}

function injectAgent(
  ctx: ScoopContext,
  options: {
    secondOverflow?: boolean;
    compactionError?: Error;
    continueError?: Error;
    largerCompaction?: boolean;
    unchangedCompaction?: boolean;
    noApiKey?: boolean;
    noModel?: boolean;
  } = {}
) {
  const continueStatuses: string[] = [];
  const runAbortController = new AbortController();
  const compactedMessage = {
    role: 'user' as const,
    content: [
      {
        type: 'text' as const,
        text: options.largerCompaction
          ? 'natural-language summary '.repeat(100)
          : '[compacted history]',
      },
    ],
  };
  const emit = (
    message:
      | ReturnType<typeof overflowMessage>
      | ReturnType<typeof successMessage>
      | ReturnType<typeof assistantErrorMessage>
  ) => {
    agent.state.messages = [...agent.state.messages, message];
    const handler = (
      ctx as unknown as {
        handleAgentEvent: (event: unknown, signal?: AbortSignal) => void;
      }
    ).handleAgentEvent.bind(ctx);
    handler({ type: 'turn_end', message, toolResults: [] }, runAbortController.signal);
    handler({ type: 'agent_end', messages: agent.state.messages }, runAbortController.signal);
  };
  const agent = {
    prompt: vi.fn(async () => {
      agent.state.messages = [userMessage()];
      emit(overflowMessage());
    }),
    continue: vi.fn(async () => {
      if (options.continueError) throw options.continueError;
      continueStatuses.push((ctx as unknown as { status: string }).status);
      emit(options.secondOverflow ? overflowMessage() : successMessage());
    }),
    abort: vi.fn(),
    clearAllQueues: vi.fn(),
    state: {
      isStreaming: false,
      messages: [] as unknown[],
      model: options.noModel ? undefined : { contextWindow: 200_000 },
    },
  };
  const compactFn = vi.fn(async (messages: unknown[]) => {
    if (options.compactionError) throw options.compactionError;
    if (options.unchangedCompaction) return [...messages];
    return [compactedMessage];
  });
  (ctx as unknown as { agent: typeof agent }).agent = agent;
  (ctx as unknown as { compactFn: typeof compactFn }).compactFn = compactFn;
  (ctx as unknown as { getCompactionApiKey: () => string | undefined }).getCompactionApiKey = () =>
    options.noApiKey ? undefined : 'test-key';
  (ctx as unknown as { status: string }).status = 'ready';
  return { agent, compactFn, compactedMessage, continueStatuses, emit, runAbortController };
}

describe('ScoopContext overflow compaction recovery', () => {
  let cb: ScoopContextCallbacks;
  let ctx: ScoopContext;

  beforeEach(() => {
    cb = callbacks();
    ctx = new ScoopContext(scoop, cb, {} as never);
  });

  it('compacts in-turn and resumes once without an active prompt collision', async () => {
    const { agent, compactFn, compactedMessage, continueStatuses } = injectAgent(ctx);

    await ctx.prompt('work');

    expect(compactFn).toHaveBeenCalledWith([userMessage()], expect.any(AbortSignal), {
      force: true,
    });
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.continue).toHaveBeenCalledTimes(1);
    expect(continueStatuses).toEqual(['processing']);
    expect(agent.state.messages[0]).toEqual(compactedMessage);
    expect(cb.onResponseDone).toHaveBeenCalledTimes(1);
    expect(cb.onFatalError).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalledWith(expect.stringContaining('already processing'));
    expect((ctx as unknown as { overflow: { hasAttempted: boolean } }).overflow.hasAttempted).toBe(
      false
    );
  });

  it('escalates exactly once when the resumed run also overflows', async () => {
    const { agent, compactFn } = injectAgent(ctx, { secondOverflow: true });

    await ctx.prompt('work');

    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(agent.continue).toHaveBeenCalledTimes(1);
    expect(cb.onResponseDone).not.toHaveBeenCalled();
    expect(cb.onFatalError).toHaveBeenCalledTimes(1);
    expect(cb.onFatalError).toHaveBeenCalledWith(expect.stringContaining('overflow-worker'));
    expect(cb.onFatalError).toHaveBeenCalledWith(expect.stringContaining('could not be reduced'));
    expect((ctx as unknown as { status: string }).status).toBe('error');
  });

  it('escalates immediately when compaction throws', async () => {
    const { agent } = injectAgent(ctx, { compactionError: new Error('summary failed') });

    await ctx.prompt('work');

    expect(agent.continue).not.toHaveBeenCalled();
    expect(cb.onFatalError).toHaveBeenCalledTimes(1);
  });

  it('escalates instead of resuming when forced compaction makes no progress', async () => {
    const { agent } = injectAgent(ctx, { unchangedCompaction: true });

    await ctx.prompt('work');

    expect(agent.continue).not.toHaveBeenCalled();
    expect(cb.onFatalError).toHaveBeenCalledTimes(1);
  });

  it('resumes when changed compaction has a larger heuristic estimate', async () => {
    const { agent } = injectAgent(ctx, { largerCompaction: true });

    await ctx.prompt('work');

    expect(agent.continue).toHaveBeenCalledTimes(1);
    expect(cb.onFatalError).not.toHaveBeenCalled();
  });

  it.each([{ noApiKey: true }, { noModel: true }])(
    'escalates when compaction prerequisites are unavailable',
    async (options) => {
      const { agent, compactFn } = injectAgent(ctx, options);

      await ctx.prompt('work');

      expect(compactFn).not.toHaveBeenCalled();
      expect(agent.continue).not.toHaveBeenCalled();
      expect(cb.onFatalError).toHaveBeenCalledTimes(1);
      expect(agent.state.messages).toEqual([userMessage()]);
    }
  );

  it('does not start image recovery while overflow recovery is in flight', async () => {
    const { agent, emit } = injectAgent(ctx);

    agent.state.messages = [userMessage()];
    emit(overflowMessage());
    emit(assistantErrorMessage('invalid image format'));

    expect(agent.prompt).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith('invalid image format');
    expect((ctx as unknown as { overflow: { isActive: boolean } }).overflow.isActive).toBe(false);
    ctx.dispose();
    await Promise.resolve();
  });

  it('surfaces a non-overflow no-delta error during overflow recovery', async () => {
    const { emit } = injectAgent(ctx);
    (ctx as unknown as { isProcessing: boolean }).isProcessing = true;

    emit(overflowMessage());
    emit(assistantErrorMessage('stream aborted: upstream EOF'));

    expect(cb.onError).toHaveBeenCalledWith('stream aborted: upstream EOF');
    expect(
      (ctx as unknown as { promptStreamErrorMessage: string | null }).promptStreamErrorMessage
    ).toBeNull();
    expect((ctx as unknown as { overflow: { isActive: boolean } }).overflow.isActive).toBe(false);
    ctx.dispose();
    await Promise.resolve();
  });

  it('escalates when the delayed continuation throws', async () => {
    injectAgent(ctx, { continueError: new Error('recovery run failed') });

    await ctx.prompt('work');

    expect(cb.onFatalError).toHaveBeenCalledTimes(1);
    expect((ctx as unknown as { status: string }).status).toBe('error');
  });

  it.each(['stop', 'dispose'] as const)('exits cleanly when %s aborts recovery', async (action) => {
    const { agent, emit } = injectAgent(ctx);
    agent.prompt.mockImplementationOnce(async () => {
      agent.state.messages = [userMessage()];
      emit(overflowMessage());
      ctx[action]();
    });

    await ctx.prompt('work');

    expect(agent.continue).not.toHaveBeenCalled();
    expect(cb.onFatalError).not.toHaveBeenCalled();
  });

  it('does not continue when Stop aborts recovery during the resume delay', async () => {
    const { agent } = injectAgent(ctx);
    vi.mocked(cb.onResponse).mockImplementationOnce(() => ctx.stop());

    await ctx.prompt('work');

    expect(agent.continue).not.toHaveBeenCalled();
    expect(cb.onFatalError).not.toHaveBeenCalled();
  });

  it('keeps cone exhaustion human-facing instead of fatal', async () => {
    ctx = new ScoopContext({ ...scoop, parentJid: null }, cb, {} as never);
    injectAgent(ctx, { secondOverflow: true });

    await ctx.prompt('work');

    expect(cb.onFatalError).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith(expect.stringContaining('could not be reduced'));
  });
});
