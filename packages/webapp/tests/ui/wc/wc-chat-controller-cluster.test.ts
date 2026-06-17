// @vitest-environment jsdom
/**
 * Cross-message tool-call clustering in `WcChatController`. Mirrors the
 * pre-merge `chat-panel-cluster.test.ts` + `chat-panel-cluster-label.test.ts`
 * behavioral contracts, ported onto the WC controller's load/append/rerender
 * paths. The single clustering authority is the controller's `#reflowToolClusters`
 * pass (driven by `wc-message-view.ts`'s `reflowToolClusters`), so per-message
 * runs and cross-message runs are the same code path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const quickLabelMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ui/quick-llm.js', () => ({
  quickLabel: quickLabelMock,
}));

import type { AgentEvent, AgentHandle, ChatMessage, ToolCall } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';

class FakeAgent implements AgentHandle {
  listeners = new Set<(event: AgentEvent) => void>();
  sendMessage(): void {}
  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  stop(): void {}
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

let testCounter = 0;
function uid(prefix: string): string {
  return `${prefix}-${++testCounter}`;
}

function tc(overrides: Partial<ToolCall> & { name: string; id: string }): ToolCall {
  return {
    id: overrides.id,
    name: overrides.name,
    input: overrides.input ?? { path: `/tmp/${overrides.id}.txt` },
    result: overrides.result,
    isError: overrides.isError,
  };
}

function assistantMsg(
  id: string,
  toolCalls: ToolCall[],
  timestamp: number,
  content = ''
): ChatMessage {
  return { id, role: 'assistant', content, timestamp, toolCalls };
}

interface Harness {
  thread: HTMLElement;
  agent: FakeAgent;
  controller: WcChatController;
}

function makeHarness(): Harness {
  document.body.replaceChildren();
  const thread = document.createElement('slicc-chat-thread');
  document.body.appendChild(thread);
  const agent = new FakeAgent();
  const controller = new WcChatController({ thread, agent });
  return { thread, agent, controller };
}

describe('WcChatController cross-message tool-call clustering', () => {
  beforeEach(() => {
    quickLabelMock.mockReset();
    // Default: never returns — keeps cluster `label` attr untouched so tests
    // that don't care about labels stay deterministic. Tests that care
    // override per-call with `mockResolvedValue` / `mockImplementationOnce`.
    quickLabelMock.mockImplementation(() => new Promise<string>(() => {}));
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('collapses three single-tool continuation messages into one cluster', () => {
    const { thread, controller } = makeHarness();
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'a' })], 2000),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'b' })], 2100),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'c' })], 2200),
    ]);
    const clusters = thread.querySelectorAll('slicc-tool-cluster');
    expect(clusters).toHaveLength(1);
    expect(clusters[0].getAttribute('count')).toBe('3');
    expect(clusters[0].querySelectorAll('slicc-action-row')).toHaveLength(3);
  });

  it('does not cluster a chain shorter than the threshold', () => {
    const { thread, controller } = makeHarness();
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'a' })], 2000),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'b' })], 2100),
    ]);
    expect(thread.querySelectorAll('slicc-tool-cluster')).toHaveLength(0);
    expect(thread.querySelectorAll('slicc-action-row')).toHaveLength(2);
  });

  it('breaks the chain on a real user turn so a new run starts fresh', () => {
    const { thread, controller } = makeHarness();
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'a' })], 2000),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'b' })], 2100),
      // User turn here breaks the assistant continuation chain.
      { id: uid('u'), role: 'user', content: 'and now', timestamp: 3000 },
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'c' })], 4000),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'd' })], 4100),
    ]);
    expect(thread.querySelectorAll('slicc-tool-cluster')).toHaveLength(0);
    expect(thread.querySelectorAll('slicc-action-row')).toHaveLength(4);
  });

  it('splits clusters when text in a continuation group sits between tool calls', () => {
    // Prose in the third message precedes its single tool call, so
    // collapsing all three calls would hoist that call above the
    // "done" text. Each side of the break is shorter than the
    // cluster threshold, so neither side clusters.
    const { thread, controller } = makeHarness();
    const a3Id = uid('a');
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'a' })], 2000),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'read_file', result: 'b' })], 2100),
      assistantMsg(a3Id, [tc({ id: uid('tc'), name: 'read_file', result: 'c' })], 2200, 'done'),
    ]);
    expect(thread.querySelectorAll('slicc-tool-cluster')).toHaveLength(0);
    expect(thread.querySelectorAll('slicc-action-row')).toHaveLength(3);
    const lastBubble = thread.querySelector(`slicc-agent-message[data-msg-id="${a3Id}"]`);
    expect(lastBubble?.textContent).toContain('done');
  });

  it('splits a chain into two clusters when a pure-text continuation lands between tool runs', () => {
    const { thread, controller } = makeHarness();
    const proseId = uid('a');
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(
        uid('a'),
        [
          tc({ id: uid('tc'), name: 'bash', result: 'a' }),
          tc({ id: uid('tc'), name: 'bash', result: 'b' }),
          tc({ id: uid('tc'), name: 'bash', result: 'c' }),
        ],
        2000
      ),
      assistantMsg(proseId, [], 2100, 'thinking…'),
      assistantMsg(
        uid('a'),
        [
          tc({ id: uid('tc'), name: 'bash', result: 'd' }),
          tc({ id: uid('tc'), name: 'bash', result: 'e' }),
          tc({ id: uid('tc'), name: 'bash', result: 'f' }),
        ],
        2200
      ),
    ]);
    const clusters = thread.querySelectorAll('slicc-tool-cluster');
    expect(clusters).toHaveLength(2);
    expect([...clusters].map((c) => c.getAttribute('count'))).toEqual(['3', '3']);
    const text = thread.querySelector(`slicc-agent-message[data-msg-id="${proseId}"]`);
    expect(text?.textContent).toContain('thinking');
    // First cluster precedes the prose; second cluster follows it.
    expect(
      clusters[0].compareDocumentPosition(text as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      (text as Node).compareDocumentPosition(clusters[1]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('does not merge two short tool runs across a pure-text continuation', () => {
    const { thread, controller } = makeHarness();
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(
        uid('a'),
        [
          tc({ id: uid('tc'), name: 'bash', result: 'a' }),
          tc({ id: uid('tc'), name: 'bash', result: 'b' }),
        ],
        2000
      ),
      assistantMsg(uid('a'), [], 2100, 'let me think'),
      assistantMsg(
        uid('a'),
        [
          tc({ id: uid('tc'), name: 'bash', result: 'c' }),
          tc({ id: uid('tc'), name: 'bash', result: 'd' }),
        ],
        2200
      ),
    ]);
    expect(thread.querySelectorAll('slicc-tool-cluster')).toHaveLength(0);
    expect(thread.querySelectorAll('slicc-action-row')).toHaveLength(4);
  });

  it('keeps preamble + trailing summary prose in chronological position around the cluster', () => {
    const { thread, controller } = makeHarness();
    const preambleId = uid('a');
    const summaryId = uid('a');
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(
        preambleId,
        [tc({ id: uid('tc'), name: 'bash', result: 'a' })],
        2000,
        'starting'
      ),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'bash', result: 'b' })], 2100),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'bash', result: 'c' })], 2200),
      assistantMsg(summaryId, [], 2300, 'all good'),
    ]);
    const cluster = thread.querySelector('slicc-tool-cluster');
    expect(cluster).not.toBeNull();
    const preamble = thread.querySelector(`slicc-agent-message[data-msg-id="${preambleId}"]`);
    const summary = thread.querySelector(`slicc-agent-message[data-msg-id="${summaryId}"]`);
    expect(preamble?.textContent).toContain('starting');
    expect(summary?.textContent).toContain('all good');
    // preamble → cluster → summary, in that order.
    expect(
      (preamble as Node).compareDocumentPosition(cluster as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      (cluster as Node).compareDocumentPosition(summary as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('rebuilds the cluster as new continuation messages stream in via append', () => {
    const { thread, agent } = makeHarness();
    // Seed with two single-tool continuations — short of the threshold.
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'read_file', toolInput: {} });
    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'read_file', result: 'a' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    agent.emit({ type: 'turn_end', messageId: 'm1' });
    agent.emit({ type: 'message_start', messageId: 'm2' });
    agent.emit({ type: 'tool_use_start', messageId: 'm2', toolName: 'read_file', toolInput: {} });
    agent.emit({ type: 'tool_result', messageId: 'm2', toolName: 'read_file', result: 'b' });
    agent.emit({ type: 'content_done', messageId: 'm2' });
    agent.emit({ type: 'turn_end', messageId: 'm2' });
    expect(thread.querySelectorAll('slicc-tool-cluster')).toHaveLength(0);

    // Streaming append crosses the threshold — cluster should appear.
    agent.emit({ type: 'message_start', messageId: 'm3' });
    agent.emit({ type: 'tool_use_start', messageId: 'm3', toolName: 'read_file', toolInput: {} });
    agent.emit({ type: 'tool_result', messageId: 'm3', toolName: 'read_file', result: 'c' });
    agent.emit({ type: 'content_done', messageId: 'm3' });
    agent.emit({ type: 'turn_end', messageId: 'm3' });
    const cluster = thread.querySelector('slicc-tool-cluster');
    expect(cluster).not.toBeNull();
    expect(cluster?.getAttribute('count')).toBe('3');

    // A fourth continuation message extends the cluster — still one cluster.
    agent.emit({ type: 'message_start', messageId: 'm4' });
    agent.emit({ type: 'tool_use_start', messageId: 'm4', toolName: 'bash', toolInput: {} });
    agent.emit({ type: 'tool_result', messageId: 'm4', toolName: 'bash', result: 'd' });
    agent.emit({ type: 'content_done', messageId: 'm4' });
    agent.emit({ type: 'turn_end', messageId: 'm4' });
    const extended = thread.querySelectorAll('slicc-tool-cluster');
    expect(extended).toHaveLength(1);
    expect(extended[0].getAttribute('count')).toBe('4');
    expect(extended[0].querySelectorAll('slicc-action-row')).toHaveLength(4);
  });

  it('reflects updated per-call result in the cluster rows after a message rebuild', () => {
    const { thread, controller } = makeHarness();
    const t1 = tc({ id: uid('tc'), name: 'read_file' });
    const t2 = tc({ id: uid('tc'), name: 'read_file' });
    const t3 = tc({ id: uid('tc'), name: 'read_file' });
    const a2Id = uid('a');
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(uid('a'), [t1], 2000),
      assistantMsg(a2Id, [t2], 2100),
      assistantMsg(uid('a'), [t3], 2200),
    ]);
    const cluster = thread.querySelector('slicc-tool-cluster');
    expect(cluster).not.toBeNull();
    const beforeResults = [...(cluster?.querySelectorAll('slicc-action-row') ?? [])].map((r) =>
      r.getAttribute('result')
    );
    expect(beforeResults).toEqual(['…', '…', '…']);

    // Result for a2's call lands — controller rerenders that message.
    t2.result = 'ok';
    // Reach into the controller's private rerender via the same path the
    // tool_result event uses: simulate by rerendering through the message
    // mutation pattern.
    controller.loadMessages([
      { id: 'u-result', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1-result', [t1], 2000),
      assistantMsg('a2-result', [t2], 2100),
      assistantMsg('a3-result', [t3], 2200),
    ]);
    const clusterAfter = thread.querySelector('slicc-tool-cluster');
    const rows = [...(clusterAfter?.querySelectorAll('slicc-action-row') ?? [])];
    const results = rows.map((r) => r.getAttribute('result'));
    expect(results).toEqual(['…', 'done', '…']);
  });

  it('keeps a user-expanded cluster open across the streaming-append rebuild', () => {
    // Exercises the `#openClusterAnchors` preservation path: stream three
    // single-tool turns so a cluster forms, mark it open, then stream a 4th
    // turn so `#appendMessage` runs unwrap+reflow. The rebuilt cluster must
    // still carry the `open` attribute (and the higher count) — a full
    // `loadMessages` reload would discard open state by design, so this test
    // deliberately stays on the streaming-append path.
    const { thread, agent } = makeHarness();
    for (const i of [1, 2, 3]) {
      agent.emit({ type: 'message_start', messageId: `open-m${i}` });
      agent.emit({
        type: 'tool_use_start',
        messageId: `open-m${i}`,
        toolName: 'read_file',
        toolInput: {},
      });
      agent.emit({
        type: 'tool_result',
        messageId: `open-m${i}`,
        toolName: 'read_file',
        result: String(i),
      });
      agent.emit({ type: 'content_done', messageId: `open-m${i}` });
      agent.emit({ type: 'turn_end', messageId: `open-m${i}` });
    }
    const cluster = thread.querySelector('slicc-tool-cluster') as HTMLElement;
    expect(cluster).not.toBeNull();
    expect(cluster.hasAttribute('open')).toBe(false);
    expect(cluster.getAttribute('count')).toBe('3');
    // User expands the cluster.
    cluster.setAttribute('open', '');

    // A fourth single-tool turn streams in — `#appendMessage`'s unwrap
    // captures the open anchor, then reflow rebuilds the cluster.
    agent.emit({ type: 'message_start', messageId: 'open-m4' });
    agent.emit({
      type: 'tool_use_start',
      messageId: 'open-m4',
      toolName: 'read_file',
      toolInput: {},
    });
    agent.emit({ type: 'tool_result', messageId: 'open-m4', toolName: 'read_file', result: '4' });
    agent.emit({ type: 'content_done', messageId: 'open-m4' });
    agent.emit({ type: 'turn_end', messageId: 'open-m4' });

    const rebuilt = thread.querySelector('slicc-tool-cluster') as HTMLElement;
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.getAttribute('count')).toBe('4');
    // The actual `#openClusterAnchors` invariant: the rebuilt cluster
    // preserves the user's expanded state across the streaming append.
    expect(rebuilt.hasAttribute('open')).toBe(true);
  });

  it('preserves chronological row order after a delayed middle-message tool_result', () => {
    // Codex P2 regression: stream three single-tool turns so they cluster
    // BEFORE any results land (all rows still `…`), then deliver a delayed
    // `tool_result` for the MIDDLE message. The resulting `#rerenderMessage`
    // unwraps the cluster and re-inserts m2's new row; the next reflow must
    // rebuild the cluster in m1→m2→m3 order, NOT m1→m3→m2.
    const { thread, agent } = makeHarness();
    for (const id of ['mid-m1', 'mid-m2', 'mid-m3']) {
      agent.emit({ type: 'message_start', messageId: id });
      agent.emit({ type: 'tool_use_start', messageId: id, toolName: 'read_file', toolInput: {} });
    }
    const initial = thread.querySelector('slicc-tool-cluster') as HTMLElement | null;
    expect(initial).not.toBeNull();
    expect(initial?.getAttribute('count')).toBe('3');

    // Delayed result for the MIDDLE message — triggers a rerender of m2
    // while m1/m2/m3 are clustered. The other two still have `…` rows.
    agent.emit({ type: 'tool_result', messageId: 'mid-m2', toolName: 'read_file', result: 'ok' });

    const cluster = thread.querySelector('slicc-tool-cluster') as HTMLElement | null;
    expect(cluster).not.toBeNull();
    const rows = Array.from(cluster?.querySelectorAll('slicc-action-row') ?? []) as HTMLElement[];
    expect(rows).toHaveLength(3);
    const msgIds = rows.map((r) => r.dataset.msgId);
    expect(msgIds).toEqual(['mid-m1', 'mid-m2', 'mid-m3']);
    // And the middle row is the one that flipped to `done`.
    expect(rows.map((r) => r.getAttribute('result'))).toEqual(['…', 'done', '…']);
  });

  it('lets the user re-collapse a cluster after streaming reflow', () => {
    const { thread, agent } = makeHarness();
    // Streaming-append seeds three single-tool turns.
    for (const i of [1, 2, 3]) {
      agent.emit({ type: 'message_start', messageId: `m${i}` });
      agent.emit({
        type: 'tool_use_start',
        messageId: `m${i}`,
        toolName: 'read_file',
        toolInput: {},
      });
      agent.emit({
        type: 'tool_result',
        messageId: `m${i}`,
        toolName: 'read_file',
        result: String(i),
      });
      agent.emit({ type: 'content_done', messageId: `m${i}` });
      agent.emit({ type: 'turn_end', messageId: `m${i}` });
    }
    const cluster = thread.querySelector('slicc-tool-cluster') as HTMLElement;
    expect(cluster).not.toBeNull();
    cluster.setAttribute('open', '');
    cluster.removeAttribute('open');

    // Append after collapse — must stay collapsed.
    agent.emit({ type: 'message_start', messageId: 'm4' });
    agent.emit({ type: 'tool_use_start', messageId: 'm4', toolName: 'read_file', toolInput: {} });
    agent.emit({
      type: 'tool_result',
      messageId: 'm4',
      toolName: 'read_file',
      result: '4',
    });
    agent.emit({ type: 'content_done', messageId: 'm4' });
    agent.emit({ type: 'turn_end', messageId: 'm4' });

    const rebuilt = thread.querySelector('slicc-tool-cluster') as HTMLElement;
    expect(rebuilt?.hasAttribute('open')).toBe(false);
  });

  it('does not double-cluster when a single message already has 3+ tool calls in the chain', () => {
    const { thread, controller } = makeHarness();
    controller.loadMessages([
      { id: uid('u'), role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(
        uid('a'),
        [
          tc({ id: uid('tc'), name: 'read_file', result: 'a' }),
          tc({ id: uid('tc'), name: 'read_file', result: 'b' }),
          tc({ id: uid('tc'), name: 'read_file', result: 'c' }),
        ],
        2000
      ),
      assistantMsg(uid('a'), [tc({ id: uid('tc'), name: 'bash', result: 'd' })], 2100),
    ]);
    const clusters = thread.querySelectorAll('slicc-tool-cluster');
    expect(clusters).toHaveLength(1);
    expect(clusters[0].getAttribute('count')).toBe('4');
    expect(clusters[0].querySelectorAll('slicc-action-row')).toHaveLength(4);
  });
});

describe('WcChatController cluster label (LLM purpose phrase)', () => {
  beforeEach(() => {
    quickLabelMock.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('paints the LLM purpose label on the cluster once quickLabel resolves', async () => {
    quickLabelMock.mockResolvedValue('Read repository files');
    const { thread, controller } = makeHarness();
    controller.loadMessages([
      { id: 'lbl-u', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg(
        'lbl-a',
        [
          tc({ id: 'lbl-tc-1', name: 'read_file', input: { path: '/a' }, result: 'a' }),
          tc({ id: 'lbl-tc-2', name: 'read_file', input: { path: '/b' }, result: 'b' }),
          tc({ id: 'lbl-tc-3', name: 'read_file', input: { path: '/c' }, result: 'c' }),
        ],
        2000
      ),
    ]);
    const cluster = thread.querySelector('slicc-tool-cluster');
    expect(cluster).not.toBeNull();
    await vi.waitFor(() => {
      expect(cluster?.getAttribute('label')).toBe('Read repository files');
    });
    // quickLabel was called with the call inputs (one per row).
    expect(quickLabelMock).toHaveBeenCalled();
    const callArg = quickLabelMock.mock.calls[0][0] as { prompt: string };
    expect(callArg.prompt).toMatch(/1\. read_file:/);
    expect(callArg.prompt).toMatch(/3\. read_file:/);
  });
});
