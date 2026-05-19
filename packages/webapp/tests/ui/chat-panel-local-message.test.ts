// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test the `onLocalUserMessage` hook that the standalone-leader boot
// path in `ui/main.ts:mainStandaloneWorker` wires to
// `pageLeaderTray.sync.broadcastUserMessage` so the leader's own chat
// input is forwarded over `user_message_echo` to followers. Without
// this hook the follower only sees the leader's input after a snapshot
// refresh — agent responses stream live but the prompt that triggered
// them doesn't, leaving the follower's chat looking like the assistant
// is talking to itself.

describe('ChatPanel — onLocalUserMessage hook (leader-tray broadcast wiring)', () => {
  beforeEach(() => {
    const store: Record<string, string> = { 'selected-model': 'claude-sonnet' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onLocalUserMessage with the same args as agent.sendMessage when the user submits chat', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    const agentSendMessage = vi.fn();
    const onLocalUserMessage = vi.fn();
    panel.setAgent({
      sendMessage: agentSendMessage,
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);
    panel.setOnLocalUserMessage(onLocalUserMessage);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'broadcast me';
    textarea.dispatchEvent(new Event('input'));
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(agentSendMessage).toHaveBeenCalledTimes(1);
    expect(onLocalUserMessage).toHaveBeenCalledTimes(1);
    const [agentText, agentMsgId] = agentSendMessage.mock.calls[0];
    const [hookText, hookMsgId, hookAttachments] = onLocalUserMessage.mock.calls[0];
    expect(hookText).toBe(agentText);
    expect(hookMsgId).toBe(agentMsgId);
    expect(hookText).toBe('broadcast me');
    expect(typeof hookMsgId).toBe('string');
    expect(hookMsgId.length).toBeGreaterThan(0);
    // No attachments → hook receives `undefined` (matches the wire
    // protocol's optional field — empty array would force the leader to
    // ship `attachments: []` over WebRTC for no reason).
    expect(hookAttachments).toBeUndefined();
  });

  it('does not fire when the chat send is suppressed (empty input)', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    const onLocalUserMessage = vi.fn();
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);
    panel.setOnLocalUserMessage(onLocalUserMessage);

    // Empty textarea — clicking send must short-circuit before reaching the hook.
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(onLocalUserMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when no hook has been wired (leader tray inactive)', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);
    // No setOnLocalUserMessage call.

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'hi';
    textarea.dispatchEvent(new Event('input'));
    const sendBtn = container.querySelector('.chat__send-btn')!;

    expect(() => (sendBtn as HTMLButtonElement).click()).not.toThrow();
  });

  it('hook exceptions do not skip agent.sendMessage or break the panel', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    const agentSendMessage = vi.fn();
    panel.setAgent({
      sendMessage: agentSendMessage,
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);
    panel.setOnLocalUserMessage(() => {
      throw new Error('broadcast bombed');
    });

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'still send to agent';
    textarea.dispatchEvent(new Event('input'));
    const sendBtn = container.querySelector('.chat__send-btn')!;

    expect(() => (sendBtn as HTMLButtonElement).click()).not.toThrow();
    expect(agentSendMessage).toHaveBeenCalledTimes(1);
  });

  it('passing undefined detaches the hook', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    const onLocalUserMessage = vi.fn();
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);
    panel.setOnLocalUserMessage(onLocalUserMessage);
    panel.setOnLocalUserMessage(undefined);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'detached';
    textarea.dispatchEvent(new Event('input'));
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(onLocalUserMessage).not.toHaveBeenCalled();
  });
});
