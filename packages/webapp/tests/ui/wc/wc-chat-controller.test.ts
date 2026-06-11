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
    expect(row?.getAttribute('label')).toBe('bash ls -la');
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

  it('flags prompts sent while processing as queued', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    controller.sendUserMessage('queued one');
    const bubble = [...thread.querySelectorAll('slicc-user-message')].at(-1);
    expect(bubble?.hasAttribute('data-queued')).toBe(true);
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
});
