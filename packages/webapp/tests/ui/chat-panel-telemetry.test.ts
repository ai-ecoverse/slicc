// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn(), trackImageView: vi.fn() };
});

import { trackChatSend, trackImageView } from '../../src/ui/telemetry.js';

describe('ChatPanel — trackChatSend wiring', () => {
  beforeEach(() => {
    vi.mocked(trackChatSend).mockClear();
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

  // Type-only assist for poking private state in tests. The real public path
  // is `await panel.switchToContext(id, false, scoopName?)`, which loads from
  // SessionStore — overkill for these wiring tests. The cast below is a
  // narrow, explicit test seam; it does NOT change production code.
  type ChatPanelInternals = { currentScoopName: string | null };
  function setScoopForTest(panel: unknown, scoopName: string | null) {
    (panel as unknown as ChatPanelInternals).currentScoopName = scoopName;
  }

  it('fires trackChatSend with "cone" when currentScoopName is null', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    setScoopForTest(panel, null); // null = cone (matches ChatPanel's state model)
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'hello';
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(trackChatSend).toHaveBeenCalledWith('cone', 'claude-sonnet');
  });

  it('fires trackChatSend with the scoop name when currentScoopName is set', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    setScoopForTest(panel, 'researcher');
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'do thing';
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(trackChatSend).toHaveBeenCalledWith('researcher', 'claude-sonnet');
  });

  it('does not fire on empty input', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    setScoopForTest(panel, null);
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);

    const textarea = container.querySelector('textarea')!;
    textarea.value = '   ';
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(trackChatSend).not.toHaveBeenCalled();
  });
});

describe('ChatPanel — trackImageView wiring', () => {
  beforeEach(() => {
    vi.mocked(trackImageView).mockClear();
  });

  it('fires trackImageView("chat") for each <img> appended to messagesEl', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    new ChatPanel(container);

    const messagesEl = container.querySelector('.chat__messages')!;
    const img1 = document.createElement('img');
    img1.src = 'data:image/png;base64,iVBORw0KGgo=';
    messagesEl.appendChild(img1);
    const img2 = document.createElement('img');
    img2.src = 'https://example.test/x.png';
    messagesEl.appendChild(img2);

    // MutationObserver delivers asynchronously — yield a microtask.
    await new Promise((r) => setTimeout(r, 0));

    expect(trackImageView).toHaveBeenCalledTimes(2);
    expect(trackImageView).toHaveBeenCalledWith('chat');

    container.remove();
  });

  it('fires once per <img> even when nested inside other elements', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    new ChatPanel(container);

    const messagesEl = container.querySelector('.chat__messages')!;
    // Build the wrapper without innerHTML — explicit DOM construction.
    const wrapper = document.createElement('p');
    wrapper.append('text ');
    const img1 = document.createElement('img');
    img1.src = 'x.png';
    wrapper.appendChild(img1);
    wrapper.append(' middle ');
    const img2 = document.createElement('img');
    img2.src = 'y.png';
    wrapper.appendChild(img2);
    wrapper.append(' end');
    messagesEl.appendChild(wrapper);

    await new Promise((r) => setTimeout(r, 0));
    expect(trackImageView).toHaveBeenCalledTimes(2);

    container.remove();
  });
});
