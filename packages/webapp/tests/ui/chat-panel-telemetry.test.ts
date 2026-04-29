// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn() };
});

import { trackChatSend } from '../../src/ui/telemetry.js';

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
