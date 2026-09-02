/**
 * The pre-compaction snapshot hook and the transcript pointer: every round
 * that changes the history first hands the untouched conversation to the
 * owner, then tells the model (and the UI) where it went.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestMessage = { role: string; content: { type: string; text?: string }[] | string };
type CompactionSettingsArg = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

const mockCompleteSimple = vi.fn();
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, completeSimple: (...args: unknown[]) => mockCompleteSimple(...args) };
});
vi.mock('@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', () => ({
  estimateTokens: (msg: TestMessage) => {
    let chars = 0;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content)
        if (block.type === 'text' && block.text) chars += block.text.length;
    }
    return Math.ceil(chars / 4);
  },
  shouldCompact: (tokens: number, window: number, settings: CompactionSettingsArg) =>
    settings.enabled && tokens > window - settings.reserveTokens,
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
}));

import {
  type CompactionStateDetail,
  createCompactContext,
  estimateConversationTokens,
} from '../../src/core/context-compaction.js';

const model = { id: 'm', provider: 'anthropic' } as unknown as Model<Api>;
const text = (role: 'user' | 'assistant', chars: number, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text: 'x'.repeat(chars) }], timestamp }) as AgentMessage;
/** Four ~3k-token messages against a 10k window / 1k reserve: over the threshold. */
const conversation = () => [
  text('user', 12_000, 1),
  text('assistant', 12_000, 2),
  text('user', 12_000, 3),
  text('assistant', 12_000, 4),
];
const config = (extra: Partial<Parameters<typeof createCompactContext>[0]> = {}) => ({
  model,
  getApiKey: () => 'key',
  contextWindow: 10_000,
  reserveTokens: 1_000,
  keepRecentTokens: 500,
  ...extra,
});
const textOf = (message: AgentMessage): string =>
  ((message as { content: { text: string }[] }).content[0] as { text: string }).text;

beforeEach(() => {
  mockCompleteSimple.mockReset();
  mockCompleteSimple.mockResolvedValue({
    stopReason: 'stop',
    content: [{ type: 'text', text: 'SUMMARY' }],
  });
});

describe('onBeforeCompaction', () => {
  it('receives the untouched conversation and the trigger, and the pointer lands in the summary', async () => {
    const seen: { count: number; trigger: string }[] = [];
    const states: [string, CompactionStateDetail][] = [];
    const compact = createCompactContext(
      config({
        onBeforeCompaction: async (messages, trigger) => {
          seen.push({ count: messages.length, trigger });
          return { transcriptPath: '/sessions/live-cone-1.md' };
        },
        onCompactionStateChange: (state, detail) => states.push([state, detail]),
      })
    );
    const input = conversation();
    const result = await compact(input);

    expect(seen).toEqual([{ count: 4, trigger: 'threshold' }]);
    expect(result).toHaveLength(2);
    expect(textOf(result[0])).toContain('<context-summary>\nSUMMARY\n</context-summary>');
    expect(textOf(result[0])).toContain('saved at /sessions/live-cone-1.md');
    expect(states).toEqual([
      ['summarizing', { trigger: 'threshold', transcriptPath: '/sessions/live-cone-1.md' }],
      ['idle', { trigger: 'threshold', transcriptPath: '/sessions/live-cone-1.md' }],
    ]);
  });

  it('is not consulted under the threshold', async () => {
    const hook = vi.fn();
    const compact = createCompactContext(config({ onBeforeCompaction: hook }));
    const small = [text('user', 100, 1)];
    expect(await compact(small)).toBe(small);
    expect(hook).not.toHaveBeenCalled();
  });

  it('names overflow for a forced round and idle when the caller says so', async () => {
    const triggers: string[] = [];
    const compact = createCompactContext(
      config({
        onBeforeCompaction: (_messages, trigger) => {
          triggers.push(trigger);
          return undefined;
        },
      })
    );
    await compact([text('user', 100, 1), text('assistant', 100, 2)], undefined, { force: true });
    await compact([text('user', 100, 1), text('assistant', 100, 2)], undefined, {
      force: true,
      trigger: 'idle',
    });
    expect(triggers).toEqual(['overflow', 'idle']);
  });

  it('survives a throwing hook and an empty answer — no pointer, compaction intact', async () => {
    const throwing = createCompactContext(
      config({
        onBeforeCompaction: async () => {
          throw new Error('disk on fire');
        },
      })
    );
    const result = await throwing(conversation());
    expect(result).toHaveLength(2);
    expect(textOf(result[0])).toBe('<context-summary>\nSUMMARY\n</context-summary>');

    const silent = createCompactContext(config({ onBeforeCompaction: () => undefined }));
    expect(textOf((await silent(conversation()))[0])).not.toContain('saved at');
  });

  it('puts the pointer on the naive-drop fallback too', async () => {
    mockCompleteSimple.mockResolvedValue({
      stopReason: 'error',
      errorMessage: 'down',
      content: [],
    });
    const states: [string, CompactionStateDetail][] = [];
    const compact = createCompactContext(
      config({
        onBeforeCompaction: () => ({ transcriptPath: '/sessions/live-cone-2.md' }),
        onCompactionStateChange: (state, detail) => states.push([state, detail]),
      })
    );
    const result = await compact(conversation());
    expect(textOf(result[0])).toContain('[Earlier conversation messages were compacted');
    expect(textOf(result[0])).toContain('/sessions/live-cone-2.md');
    expect(states.map(([state]) => state)).toEqual(['summarizing', 'fallback', 'idle']);
    expect(states.every(([, detail]) => detail.transcriptPath === '/sessions/live-cone-2.md')).toBe(
      true
    );
  });
});

describe('pointer hygiene on later rounds', () => {
  it('strips the previous round’s pointer before the conversation reaches the summary and memory prompts', async () => {
    const compact = createCompactContext(
      config({
        onBeforeCompaction: () => ({ transcriptPath: '/sessions/live-cone-3.md' }),
        onMemoryUpdates: async () => undefined,
      })
    );
    const first = await compact(conversation());
    expect(textOf(first[0])).toContain('/sessions/live-cone-3.md');
    mockCompleteSimple.mockClear();
    // Round two: the previous summary (with its pointer) heads the history.
    await compact([...first, text('user', 12_000, 5), text('assistant', 12_000, 6)]);
    const prompts = mockCompleteSimple.mock.calls.map(
      (call) => (call[1] as { systemPrompt: string }).systemPrompt
    );
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain('<context-summary>');
      expect(prompt).not.toContain('/sessions/live-cone-3.md');
      expect(prompt).not.toContain('The full transcript of the conversation');
    }
  });

  it('hands the memory pass to the caller when asked, without running it', async () => {
    const appended: string[] = [];
    mockCompleteSimple
      .mockResolvedValueOnce({ stopReason: 'stop', content: [{ type: 'text', text: 'SUMMARY' }] })
      .mockResolvedValueOnce({ stopReason: 'stop', content: [{ type: 'text', text: '- fact' }] });
    const compact = createCompactContext(
      config({
        onMemoryUpdates: async (bullets) => {
          appended.push(bullets);
        },
      })
    );
    let deferred: (() => Promise<void>) | undefined;
    const result = await compact(conversation(), undefined, {
      force: true,
      trigger: 'idle',
      deferMemoryExtraction: (extract) => {
        deferred = extract;
      },
    });
    expect(result).toHaveLength(2);
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    expect(appended).toEqual([]);
    await deferred?.();
    expect(mockCompleteSimple).toHaveBeenCalledTimes(2);
    expect(appended).toEqual(['- fact']);
  });
});

describe('estimateConversationTokens', () => {
  it('prices a conversation the way the trigger does', () => {
    expect(estimateConversationTokens([text('user', 400, 1), text('assistant', 400, 2)])).toBe(200);
    expect(estimateConversationTokens([])).toBe(0);
  });
});
