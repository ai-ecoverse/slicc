// @vitest-environment jsdom
/**
 * Drives the WC chat controller with a scripted fake `AgentHandle` and
 * asserts the thread DOM tracks the legacy ChatPanel streaming semantics:
 * message_start → deltas (rAF-batched) → tool rows → content_done/turn_end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';

class FakeAgent implements AgentHandle {
  listeners = new Set<(event: AgentEvent) => void>();
  sent: Array<{ text: string; messageId?: string }> = [];
  stopped = 0;

  sendMessage(text: string, messageId?: string): void {
    this.sent.push({ text, messageId });
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  stop(): void {
    this.stopped++;
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('WcChatController', () => {
  let thread: HTMLElement;
  let agent: FakeAgent;
  let controller: WcChatController;
  let processingStates: boolean[];

  beforeEach(() => {
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    processingStates = [];
    controller = new WcChatController({
      thread,
      agent,
      onProcessingChange: (processing) => processingStates.push(processing),
    });
  });

  it('sends user prompts to the agent and renders the bubble locally', () => {
    controller.sendUserMessage('  build me a shader  ');
    expect(agent.sent).toEqual([{ text: 'build me a shader', messageId: expect.any(String) }]);
    const bubble = thread.querySelector('slicc-user-message');
    expect(bubble?.shadowRoot?.textContent).toContain('build me a shader');
  });

  it('ignores empty prompts', () => {
    controller.sendUserMessage('   ');
    expect(agent.sent).toEqual([]);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);
  });

  it('streams an assistant message through start → delta → done', async () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    const streamingEl = thread.querySelector('slicc-agent-message');
    expect(streamingEl?.hasAttribute('streaming')).toBe(true);
    expect(controller.processing).toBe(true);

    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'Hello ' });
    agent.emit({ type: 'content_delta', messageId: 'm1', text: '**world**' });
    await nextFrame();
    const mid = thread.querySelector('slicc-agent-message');
    expect(mid?.textContent).toContain('Hello');
    expect(mid?.querySelector('strong')?.textContent).toBe('world');

    agent.emit({ type: 'content_done', messageId: 'm1' });
    agent.emit({ type: 'turn_end', messageId: 'm1' });
    const finalEl = thread.querySelector('slicc-agent-message');
    expect(finalEl?.hasAttribute('streaming')).toBe(false);
    expect(controller.processing).toBe(false);
    expect(processingStates).toEqual([true, false]);
  });

  it('folds un-flushed deltas into the final render on content_done', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'tail text' });
    // No rAF tick — content_done must still pick up the pending delta.
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.querySelector('slicc-agent-message')?.textContent).toContain('tail text');
  });

  it('renders tool calls as action rows and resolves their results', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'ls -la' });
    let row = thread.querySelector('slicc-action-row');
    // Tool titles are human phrases, never raw function names.
    expect(row?.getAttribute('label')).toBe("Use Sliccy's computer");
    expect(row?.getAttribute('icon')).toBe('folder-open');
    expect(row?.getAttribute('result')).toBe('…');

    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'total 42' });
    row = thread.querySelector('slicc-action-row');
    expect(row?.getAttribute('result')).toBe('done');
    expect(row?.textContent).toContain('total 42');

    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'boom',
      isError: true,
    });
    // Second result with no pending call of that name is dropped silently.
    expect(thread.querySelectorAll('slicc-action-row').length).toBe(1);
  });

  it('marks errored tool calls', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'rm /' });
    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'denied',
      isError: true,
    });
    expect(thread.querySelector('slicc-action-row')?.getAttribute('result')).toBe('error');
  });

  it('renders agent errors as an error bubble and clears processing', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'error', error: 'rate limited' });
    expect(controller.processing).toBe(false);
    const bubbles = thread.querySelectorAll('slicc-agent-message');
    expect(bubbles[bubbles.length - 1].textContent).toContain('rate limited');
  });

  it('replaces history wholesale on loadMessages', () => {
    controller.sendUserMessage('old');
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'restored prompt', timestamp: 1700000000000 },
      { id: 'h2', role: 'assistant', content: 'restored reply', timestamp: 1700000001000 },
    ]);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(1);
    expect(thread.querySelectorAll('slicc-agent-message').length).toBe(1);
    expect(thread.querySelector('slicc-day-separator')).toBeTruthy();
  });

  it('renders licks as lick cards', () => {
    controller.addLickMessage('l1', '[Webhook Event: deploy]\npayload', 'webhook', Date.now());
    const card = thread.querySelector('slicc-lick-card');
    expect(card?.getAttribute('kind')).toBe('webhook');
    expect(card?.getAttribute('event-label')).toBe('deploy');
  });

  it('collates consecutive same-channel licks into one counted card', () => {
    controller.addLickMessage('l1', '[Session Reload] one', 'session-reload', Date.now());
    controller.addLickMessage('l2', '[Session Reload] two', 'session-reload', Date.now());
    const cards = thread.querySelectorAll('slicc-lick-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('count')).toBe('2');
    // A different channel breaks the run and starts a fresh card.
    controller.addLickMessage('l3', '[Cron Event: tick]', 'cron', Date.now());
    expect(thread.querySelectorAll('slicc-lick-card')).toHaveLength(2);
  });

  it('collates lick runs arriving through loadMessages too', () => {
    controller.loadMessages([
      {
        id: 'a',
        role: 'user',
        content: 'r1',
        timestamp: 1,
        source: 'lick',
        channel: 'session-reload',
      },
      {
        id: 'b',
        role: 'user',
        content: 'r2',
        timestamp: 2,
        source: 'lick',
        channel: 'session-reload',
      },
    ]);
    const cards = thread.querySelectorAll('slicc-lick-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('count')).toBe('2');
  });

  it('flags prompts sent while processing as queued', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    controller.sendUserMessage('queued one');
    const bubble = [...thread.querySelectorAll('slicc-user-message')].at(-1);
    expect(bubble?.hasAttribute('queued')).toBe(true);
  });

  it('stops listening after dispose', () => {
    controller.dispose();
    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(thread.querySelector('slicc-agent-message')).toBeNull();
  });

  it('ignores events for unknown message ids', () => {
    agent.emit({ type: 'content_delta', messageId: 'nope', text: 'x' });
    agent.emit({ type: 'content_done', messageId: 'nope' });
    agent.emit({ type: 'tool_use_start', messageId: 'nope', toolName: 'bash', toolInput: '' });
    expect(thread.querySelectorAll('slicc-agent-message, slicc-action-row').length).toBe(0);
  });

  it('exposes external processing overrides without duplicate notifications', () => {
    controller.setProcessing(true);
    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(processingStates).toEqual([true, false]);
  });
});

describe('WcChatController render/dispose lifecycle hooks', () => {
  function makeTracked() {
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const rendered: string[] = [];
    const disposed: string[] = [];
    const controller = new WcChatController({
      thread,
      agent,
      onMessageRendered: (message) => rendered.push(message.id),
      onMessageDisposed: (messageId) => disposed.push(messageId),
    });
    return { thread, agent, controller, rendered, disposed };
  }

  it('fires rendered immediately for non-streaming appends', () => {
    const { controller, rendered } = makeTracked();
    controller.sendUserMessage('hello');
    controller.addLickMessage('l1', '[Webhook Event: x]', 'webhook', Date.now());
    expect(rendered).toHaveLength(2);
  });

  it('defers rendered until a streaming message finalizes', () => {
    const { agent, rendered, disposed } = makeTracked();
    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(rendered).toEqual([]);
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'x' });
    expect(rendered).toEqual([]);
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(rendered).toEqual(['m1']);
    // The final render replaced the streaming elements — disposal first.
    expect(disposed).toEqual(['m1']);
  });

  it('re-fires rendered (after disposed) for post-stream tool results', () => {
    const { agent, rendered, disposed } = makeTracked();
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'ls' });
    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'ok' });
    expect(rendered).toEqual(['m1', 'm1', 'm1']);
    expect(disposed).toEqual(['m1', 'm1', 'm1']);
  });

  it('disposes everything on loadMessages and renders the new history', () => {
    const { controller, rendered, disposed } = makeTracked();
    controller.sendUserMessage('old');
    rendered.length = 0;
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'a', timestamp: 1 },
      { id: 'h2', role: 'assistant', content: 'b', timestamp: 2 },
    ]);
    expect(disposed.length).toBeGreaterThan(0);
    expect(rendered).toEqual(['h1', 'h2']);
  });

  it('tracks loaded messages so post-load streaming updates replace in place', () => {
    const { thread, agent, controller } = makeTracked();
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'a', timestamp: 1 },
      { id: 'm1', role: 'assistant', content: 'partial', timestamp: 2, isStreaming: true },
    ]);
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
    expect(thread.querySelector('slicc-agent-message')?.hasAttribute('streaming')).toBe(false);
  });

  // Regression for #959: a canonical replay that lands mid-turn must leave the
  // stream machine pointed at the streaming tail so resumed deltas extend it
  // (and content_done folds the last un-flushed chunk) instead of the reply
  // hanging unrendered behind a stuck spinner.
  it('resumes a streaming tail after loadMessages: deltas extend it, content_done flushes', async () => {
    const { thread, agent, controller } = makeTracked();
    controller.loadMessages([
      { id: 'm1', role: 'assistant', content: 'before', timestamp: 2, isStreaming: true },
    ]);
    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' mid' });
    await nextFrame();
    expect(thread.querySelector('slicc-agent-message')?.textContent).toContain('before mid');

    // A delta with no rAF tick before content_done must still be folded in
    // (works because loadMessages restored #currentStreamId for the tail).
    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' end' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    const el = thread.querySelector('slicc-agent-message');
    expect(el?.textContent).toContain('before mid end');
    expect(el?.hasAttribute('streaming')).toBe(false);
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
  });
});

describe('WcChatController scroll pinning', () => {
  it('scrolls the thread to the bottom on append', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const setter = vi.fn();
    Object.defineProperty(thread, 'scrollHeight', { value: 1234 });
    Object.defineProperty(thread, 'scrollTop', { set: setter, get: () => 0 });
    const controller = new WcChatController({ thread, agent: new FakeAgent() });
    controller.sendUserMessage('scroll me');
    expect(setter).toHaveBeenCalledWith(1234);
  });

  it('agent-driven appends use the thread polite follow, user sends hard-scroll', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread') as HTMLElement & {
      requestFollow: ReturnType<typeof vi.fn>;
    };
    thread.requestFollow = vi.fn();
    document.body.appendChild(thread);
    const scrollSetter = vi.fn();
    Object.defineProperty(thread, 'scrollHeight', { value: 1234 });
    Object.defineProperty(thread, 'scrollTop', { set: scrollSetter, get: () => 0 });
    const agent = new FakeAgent();
    new WcChatController({ thread, agent });

    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(thread.requestFollow).toHaveBeenCalled();
    expect(scrollSetter).not.toHaveBeenCalled();

    // Streaming re-renders follow politely too (this is where the chip shows).
    const callsAfterStart = thread.requestFollow.mock.calls.length;
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'hi' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.requestFollow.mock.calls.length).toBeGreaterThan(callsAfterStart);
    expect(scrollSetter).not.toHaveBeenCalled();
  });
});

describe('WcChatController render-failure degradation', () => {
  it('degrades a message whose renderer throws to a plain bubble', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new WcChatController({ thread, agent: new FakeAgent() });
    // A lick whose content is a non-string used to throw deep inside
    // messageEls and wipe the whole thread render. Force the worst case with
    // a hostile payload: content as an object (seen after OPFS corruption).
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'fine', timestamp: 1 },
      {
        id: 'h2',
        role: 'assistant',
        content: { broken: true } as unknown as string,
        timestamp: 2,
        toolCalls: { not: 'an array' } as never,
      },
      { id: 'h3', role: 'assistant', content: 'also fine', timestamp: 3 },
    ]);
    // The renderer threw (logged), the broken message degraded to a plain
    // bubble, and the healthy neighbours rendered untouched.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('message render failed'),
      expect.anything()
    );
    expect(thread.querySelector('slicc-user-message')).toBeTruthy();
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(2);
    errSpy.mockRestore();
  });

  it('fires onTurnComplete with the final assistant message (the spoken-reply hook)', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const completed: Array<{ content: string; isStreaming?: boolean } | null> = [];
    const controller = new WcChatController({
      thread,
      agent,
      onTurnComplete: (message) => completed.push(message),
    });

    agent.emit({ type: 'message_start', messageId: 'm9' });
    agent.emit({ type: 'content_delta', messageId: 'm9', text: 'spoken reply' });
    agent.emit({ type: 'content_done', messageId: 'm9' });
    await nextFrame();
    agent.emit({ type: 'turn_end', messageId: 'm9' });

    expect(completed).toHaveLength(1);
    expect(completed[0]?.content).toBe('spoken reply');
    expect(completed[0]?.isStreaming).toBe(false);

    // THE LIVE-FLOAT SHAPE (regression): the chat wire never carries a
    // `turn_end` event — content events stream, then processing falls via a
    // scoop STATUS broadcast (`setProcessing`). The completion hook must
    // fire on that transition too, or the spoken-reply loop is dead outside
    // tests.
    agent.emit({ type: 'message_start', messageId: 'm10' });
    agent.emit({ type: 'content_delta', messageId: 'm10', text: 'live reply' });
    agent.emit({ type: 'content_done', messageId: 'm10' });
    await nextFrame();
    controller.setProcessing(false);
    expect(completed[1]?.content).toBe('live reply');

    // No transition (already idle) → no duplicate fire.
    controller.setProcessing(false);
    expect(completed).toHaveLength(2);
  });

  it('onTurnComplete is scoped to the turn — no stale reply, no historical fallback', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const completed: Array<{ content: string } | null> = [];
    const controller = new WcChatController({
      thread,
      agent,
      onTurnComplete: (message) => completed.push(message as { content: string } | null),
    });

    // Turn 1 streams a reply.
    agent.emit({ type: 'message_start', messageId: 't1' });
    agent.emit({ type: 'content_delta', messageId: 't1', text: 'earlier answer' });
    agent.emit({ type: 'content_done', messageId: 't1' });
    await nextFrame();
    agent.emit({ type: 'turn_end', messageId: 't1' });
    expect(completed[0]?.content).toBe('earlier answer');

    // A later turn that streams NOTHING (status-only cycle) must report null
    // — never re-surface turn 1's reply (the stale-speak review finding).
    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(completed[1]).toBeNull();

    // The error path: processing falls before the error bubble is appended.
    // The hook gets THIS turn's (empty) stream — not 'earlier answer'.
    agent.emit({ type: 'message_start', messageId: 't3' });
    agent.emit({ type: 'error', error: 'rate limited' });
    expect(completed[2]?.content).toBe('');
  });

  it('onTurnComplete reports null when no assistant message exists at all', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const completed: Array<unknown | null> = [];
    const controller = new WcChatController({
      thread,
      agent,
      onTurnComplete: (message) => completed.push(message),
    });

    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(completed).toEqual([null]);
  });
});
