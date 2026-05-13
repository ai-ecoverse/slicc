// @vitest-environment jsdom
/**
 * Regression tests for the empty msg-group gap bug.
 *
 * When a new assistant message starts streaming (message_start) but has no
 * text content yet, appendMessageEl used to inject an empty div.msg-group
 * into the flex container. Because the container uses gap: 16px, each empty
 * wrapper created a visible blank line that shifted earlier tool calls upward
 * on every new tool_use_start event.
 *
 * Fix: appendMessageEl skips the DOM append when the wrapper has no children,
 * and updateMessageEl inserts it at the correct position once content arrives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';
import type { ChatMessage } from '../../src/ui/types.js';

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

type ChatPanelInternals = {
  messages: ChatMessage[];
  appendMessageEl: (msg: ChatMessage) => void;
  updateMessageEl: (messageId: string) => void;
  messagesInner: HTMLElement;
};
const internals = (p: ChatPanel): ChatPanelInternals => p as unknown as ChatPanelInternals;

let testCounter = 0;

describe('ChatPanel empty msg-group gap fix', () => {
  let container: HTMLElement;
  let panel: ChatPanel;

  beforeEach(async () => {
    testCounter += 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-empty-group-${testCounter}`);
  });

  afterEach(() => {
    container.remove();
  });

  it('does not inject an empty msg-group when message has no content or tool calls', () => {
    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      toolCalls: [],
    };
    internals(panel).messages.push(msg);
    internals(panel).appendMessageEl(msg);

    const groups = container.querySelectorAll('.msg-group[data-msg-id="a1"]');
    expect(groups.length).toBe(0);
  });

  it('inserts the msg-group once a tool call arrives via updateMessageEl', () => {
    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      toolCalls: [],
    };
    internals(panel).messages.push(msg);
    internals(panel).appendMessageEl(msg);
    expect(container.querySelectorAll('.msg-group[data-msg-id="a1"]').length).toBe(0);

    msg.toolCalls = [{ id: 'tc-1', name: 'bash', input: { command: 'ls' } }];
    internals(panel).updateMessageEl('a1');

    expect(container.querySelectorAll('.msg-group[data-msg-id="a1"]').length).toBe(1);
    expect(container.querySelectorAll('.tool-call').length).toBe(1);
  });

  it('inserts the msg-group once text content arrives via updateMessageEl', () => {
    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      toolCalls: [],
    };
    internals(panel).messages.push(msg);
    internals(panel).appendMessageEl(msg);
    expect(container.querySelectorAll('.msg-group[data-msg-id="a1"]').length).toBe(0);

    msg.content = 'Hello world';
    internals(panel).updateMessageEl('a1');

    expect(container.querySelectorAll('.msg-group[data-msg-id="a1"]').length).toBe(1);
    expect(container.querySelector('.msg__content')?.textContent).toContain('Hello world');
  });

  it('inserts the late msg-group before the next message in the list', () => {
    const a1: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1000,
      isStreaming: true,
      toolCalls: [],
    };
    const u2: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: 'follow-up',
      timestamp: 2000,
    };
    const p = internals(panel);
    p.messages.push(a1);
    p.appendMessageEl(a1);
    p.messages.push(u2);
    p.appendMessageEl(u2);

    // a1 was empty — only u2 should be in the DOM
    expect(container.querySelectorAll('.msg-group').length).toBe(1);

    a1.content = 'Done';
    p.updateMessageEl('a1');

    const groups = container.querySelectorAll<HTMLElement>('.msg-group');
    expect(groups.length).toBe(2);
    // a1 must appear before u2
    expect(groups[0].dataset.msgId).toBe('a1');
    expect(groups[1].dataset.msgId).toBe('u2');
  });

  it('vacated msg-groups left after clustering have no visible size (display:none via CSS :empty)', () => {
    // After reflowToolClusters, continuation groups that had their tool calls
    // moved into a cluster become empty. They must not contribute to the
    // parent flex container gap. jsdom does not compute CSS, so we assert the
    // element is empty — the :empty { display:none } rule in chat.css handles
    // the visual suppression.
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2000,
        toolCalls: [{ id: 'tc-1', name: 'bash', input: {}, result: 'ok' }],
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '',
        timestamp: 2100,
        toolCalls: [{ id: 'tc-2', name: 'bash', input: {}, result: 'ok' }],
      },
      {
        id: 'a3',
        role: 'assistant',
        content: '',
        timestamp: 2200,
        toolCalls: [{ id: 'tc-3', name: 'bash', input: {}, result: 'ok' }],
      },
    ]);

    // All three tool calls should be clustered.
    expect(container.querySelectorAll('.tool-call-cluster').length).toBe(1);

    // Continuation groups that lost their tool calls to the cluster are empty
    // and must be marked data-empty so CSS suppresses them from the flex gap.
    const emptyGroups = [...container.querySelectorAll('.msg-group')].filter(
      (g) => g.childElementCount === 0
    );
    // They exist in the DOM (load-bearing for chain detection) but are hidden.
    expect(emptyGroups.length).toBeGreaterThan(0);
    emptyGroups.forEach((g) => expect((g as HTMLElement).dataset.empty).toBeDefined());
  });

  it('does not produce duplicate msg-groups when updateMessageEl is called on an existing element', () => {
    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'initial',
      timestamp: 1000,
      toolCalls: [],
    };
    internals(panel).messages.push(msg);
    internals(panel).appendMessageEl(msg);
    expect(container.querySelectorAll('.msg-group[data-msg-id="a1"]').length).toBe(1);

    msg.content = 'updated';
    internals(panel).updateMessageEl('a1');

    expect(container.querySelectorAll('.msg-group[data-msg-id="a1"]').length).toBe(1);
  });
});
