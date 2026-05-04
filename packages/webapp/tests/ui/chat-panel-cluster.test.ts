// @vitest-environment jsdom
/**
 * Tests for cross-message tool-call clustering in ChatPanel.
 *
 * Per-message clustering already collapses runs of three or more tool
 * calls inside a single assistant message. In real conversations the
 * agent often emits each tool call as its own message (with continuation
 * grouping for layout), so a visually contiguous run never crosses the
 * `msg.toolCalls.length >= 3` threshold and the cluster never forms.
 *
 * The chain-level reflow extends clustering across consecutive
 * `msg-group--continuation` siblings: their tool calls are summed and
 * collapsed into a single "Working" cluster appended to the chain's last
 * msg-group. These tests pin that behavior end-to-end on the rendered
 * DOM, including the streaming append path and the per-message update
 * path that fires when tool results arrive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';
import type { ChatMessage, ToolCall } from '../../src/ui/types.js';

vi.mock('../../src/ui/voice-input.js', () => ({
  VoiceInput: class {
    destroy() {}
    start() {}
    stop() {}
    setAutoSend() {}
    setLang() {}
  },
  getVoiceAutoSend: () => false,
  getVoiceLang: () => 'en-US',
}));

vi.mock('../../src/ui/provider-settings.js', () => ({
  getApiKey: () => '',
  showProviderSettings: () => {},
  applyProviderDefaults: () => {},
  getAllAvailableModels: () => [],
  getSelectedModelId: () => '',
  getSelectedProvider: () => null,
  setSelectedModelId: () => {},
  getProviderConfig: () => null,
}));

const tc = (overrides: Partial<ToolCall> & { name: string; id: string }): ToolCall => ({
  id: overrides.id,
  name: overrides.name,
  input: overrides.input ?? { path: `/tmp/${overrides.id}.txt` },
  result: overrides.result,
  isError: overrides.isError,
});

const assistantMsg = (
  id: string,
  toolCalls: ToolCall[],
  timestamp: number,
  content = ''
): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp,
  toolCalls,
});

let testCounter = 0;

describe('ChatPanel cross-message tool-call clustering', () => {
  let container: HTMLElement;
  let panel: ChatPanel;

  beforeEach(async () => {
    testCounter += 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-cluster-${testCounter}`);
  });

  afterEach(() => {
    container.remove();
  });

  it('collapses three single-tool continuation messages into one cluster', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'read_file', result: 'a' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'read_file', result: 'b' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'read_file', result: 'c' })], 2200),
    ]);

    const clusters = container.querySelectorAll('.tool-call-cluster');
    expect(clusters.length).toBe(1);

    const dots = clusters[0].querySelectorAll('.tool-call-cluster__dot');
    expect(dots.length).toBe(3);

    const innerCalls = clusters[0].querySelectorAll('.tool-call-cluster__body > .tool-call');
    expect(innerCalls.length).toBe(3);

    // Every inner tool-call element keeps its `data-msg-id` so reflow
    // can return it home on the next pass.
    const msgIds = [...innerCalls].map((el) => (el as HTMLElement).dataset.msgId);
    expect(msgIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('does not cluster a chain shorter than the threshold', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'read_file', result: 'a' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'read_file', result: 'b' })], 2100),
    ]);

    expect(container.querySelectorAll('.tool-call-cluster').length).toBe(0);
    expect(container.querySelectorAll('.tool-call').length).toBe(2);
  });

  it('breaks the chain on a real user turn so a new run starts fresh', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'read_file', result: 'a' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'read_file', result: 'b' })], 2100),
      // User turn here breaks the assistant continuation chain.
      { id: 'u2', role: 'user', content: 'and now', timestamp: 3000 },
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'read_file', result: 'c' })], 4000),
      assistantMsg('a4', [tc({ id: 'tc-4', name: 'read_file', result: 'd' })], 4100),
    ]);

    // Neither sub-chain reaches the threshold on its own.
    expect(container.querySelectorAll('.tool-call-cluster').length).toBe(0);
    expect(container.querySelectorAll('.tool-call').length).toBe(4);
  });

  it('anchors the cluster at the chain’s first tool call so post-tool text renders below it', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'read_file', result: 'a' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'read_file', result: 'b' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'read_file', result: 'c' })], 2200, 'done'),
    ]);

    const firstGroup = container.querySelector('.msg-group[data-msg-id="a1"]');
    expect(firstGroup).not.toBeNull();
    const cluster = firstGroup!.querySelector(':scope > .tool-call-cluster');
    expect(cluster).not.toBeNull();

    const lastGroup = container.querySelector('.msg-group[data-msg-id="a3"]') as HTMLElement;
    expect(lastGroup.querySelector(':scope > .tool-call-cluster')).toBeNull();

    // The cluster must precede the assistant's post-tool text bubble in
    // document order — otherwise the reply visually jumps above the
    // tools that produced it.
    const summary = lastGroup.querySelector('.msg__content');
    expect(summary?.textContent ?? '').toContain('done');
    expect(cluster!.compareDocumentPosition(summary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('keeps a continuation summary message after the cluster when text follows the tools', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash', result: 'a' })], 2000, 'starting'),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash', result: 'b' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash', result: 'c' })], 2200),
      // A pure-text continuation that summarises what the tools did.
      assistantMsg('a4', [], 2300, 'all good'),
    ]);

    const cluster = container.querySelector('.tool-call-cluster');
    expect(cluster).not.toBeNull();

    const summary = container.querySelector('.msg-group[data-msg-id="a4"] .msg__content');
    expect(summary?.textContent ?? '').toContain('all good');

    expect(cluster!.compareDocumentPosition(summary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );

    // And the leading "starting" preamble in the same chain still
    // precedes the cluster — chronology preserved on both sides.
    const preamble = container.querySelector('.msg-group[data-msg-id="a1"] .msg__content');
    expect(preamble?.textContent ?? '').toContain('starting');
    expect(preamble!.compareDocumentPosition(cluster!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('rebuilds the cluster as new continuation messages stream in', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'read_file', result: 'a' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'read_file', result: 'b' })], 2100),
    ]);

    expect(container.querySelectorAll('.tool-call-cluster').length).toBe(0);

    // Streaming append crosses the threshold — cluster should appear.
    (panel as any).messages.push(
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'read_file', result: 'c' })], 2200)
    );
    (panel as any).appendMessageEl((panel as any).messages.at(-1));

    expect(container.querySelectorAll('.tool-call-cluster').length).toBe(1);
    expect(container.querySelectorAll('.tool-call-cluster .tool-call-cluster__dot').length).toBe(3);

    // A fourth continuation message extends the cluster — still one cluster.
    (panel as any).messages.push(
      assistantMsg('a4', [tc({ id: 'tc-4', name: 'bash', result: 'd' })], 2300)
    );
    (panel as any).appendMessageEl((panel as any).messages.at(-1));

    expect(container.querySelectorAll('.tool-call-cluster').length).toBe(1);
    expect(container.querySelectorAll('.tool-call-cluster .tool-call-cluster__dot').length).toBe(4);
  });

  it('reflects updated per-call status in the cluster dots after a message rebuild', () => {
    const t1 = tc({ id: 'tc-1', name: 'read_file' });
    const t2 = tc({ id: 'tc-2', name: 'read_file' });
    const t3 = tc({ id: 'tc-3', name: 'read_file' });
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [t1], 2000),
      assistantMsg('a2', [t2], 2100),
      assistantMsg('a3', [t3], 2200),
    ]);

    const beforeDots = [...container.querySelectorAll('.tool-call-cluster__dot')].map((d) =>
      [...d.classList].find((c) => c.startsWith('tool-call--'))
    );
    expect(beforeDots).toEqual(['tool-call--running', 'tool-call--running', 'tool-call--running']);

    // Tool result for a2 lands — its dot should flip to success after rebuild.
    t2.result = 'ok';
    (panel as any).updateMessageEl('a2');

    const afterDots = [...container.querySelectorAll('.tool-call-cluster__dot')].map((d) =>
      [...d.classList].find((c) => c.startsWith('tool-call--'))
    );
    expect(afterDots).toEqual(['tool-call--running', 'tool-call--success', 'tool-call--running']);

    // Cluster still anchors at the chain's first tool call.
    const firstGroup = container.querySelector('.msg-group[data-msg-id="a1"]');
    expect(firstGroup!.querySelector(':scope > .tool-call-cluster')).not.toBeNull();
  });

  it('does not double-cluster when a single message already has 3+ tool calls in the chain', () => {
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(
        'a1',
        [
          tc({ id: 'tc-1', name: 'read_file', result: 'a' }),
          tc({ id: 'tc-2', name: 'read_file', result: 'b' }),
          tc({ id: 'tc-3', name: 'read_file', result: 'c' }),
        ],
        2000
      ),
      assistantMsg('a2', [tc({ id: 'tc-4', name: 'bash', result: 'd' })], 2100),
    ]);

    const clusters = container.querySelectorAll('.tool-call-cluster');
    expect(clusters.length).toBe(1);
    expect(clusters[0].querySelectorAll('.tool-call-cluster__dot').length).toBe(4);
  });
});
