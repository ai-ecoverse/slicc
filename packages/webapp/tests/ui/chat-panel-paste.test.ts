// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel } from '../../src/ui/chat-panel.js';
import type { AgentHandle, AgentEvent } from '../../src/ui/types.js';

vi.mock('../../src/ui/voice-input.js', () => ({
  VoiceInput: class {
    destroy() {}
    start() {}
    stop() {}
    setAutoSend() {}
    setLang() {}
    isListening() {
      return false;
    }
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

/** Create a synthetic paste event with mocked clipboardData.items. */
function createPasteEvent(items: Array<{ kind: string; type: string; file: File | null }>) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file,
      })),
    },
  });
  return event;
}

describe('ChatPanel paste image from clipboard', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let sendMessage: ReturnType<typeof vi.fn>;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
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
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-paste-${testCounter}`);
    sendMessage = vi.fn();
    const handle: AgentHandle = {
      sendMessage,
      onEvent(_cb: (event: AgentEvent) => void) {
        return () => {};
      },
      stop() {},
    };
    panel.setAgent(handle);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  // Smallest valid 1x1 transparent PNG
  const tinyPng = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0x60, 0x00, 0x00,
    0x00, 0x06, 0x00, 0x02, 0x30, 0x81, 0xd0, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);

  it('adds an image attachment when pasting an image from clipboard', async () => {
    const textarea = container.querySelector('textarea')!;
    const file = new File([tinyPng], 'screenshot.png', { type: 'image/png' });

    const event = createPasteEvent([{ kind: 'file', type: 'image/png', file }]);
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      expect(container.querySelector('.chat__attachments--visible')).not.toBeNull();
    });

    expect(container.querySelector('.attachment-chip__name')?.textContent).toBe('screenshot.png');
  });

  it('sends pasted image attachment with the message', async () => {
    const textarea = container.querySelector('textarea')!;
    const file = new File([tinyPng], 'capture.png', { type: 'image/png' });

    const event = createPasteEvent([{ kind: 'file', type: 'image/png', file }]);
    textarea.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(container.querySelector('.chat__attachments--visible')).not.toBeNull();
    });

    textarea.value = 'What is in this screenshot?';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, _id, attachments] = sendMessage.mock.calls[0];
    expect(text).toBe('What is in this screenshot?');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: 'capture.png',
      mimeType: 'image/png',
      kind: 'image',
    });
    expect(attachments[0].data).toBeTruthy();
  });

  it('does not intercept text-only paste events', () => {
    const textarea = container.querySelector('textarea')!;
    const event = createPasteEvent([{ kind: 'string', type: 'text/plain', file: null }]);
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });

  it('handles multiple pasted images at once', async () => {
    const textarea = container.querySelector('textarea')!;
    const file1 = new File([tinyPng], 'screen1.png', { type: 'image/png' });
    const file2 = new File([tinyPng], 'screen2.png', { type: 'image/png' });

    const event = createPasteEvent([
      { kind: 'file', type: 'image/png', file: file1 },
      { kind: 'file', type: 'image/png', file: file2 },
    ]);
    textarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      const chips = container.querySelectorAll('.attachment-chip__name');
      expect(chips.length).toBe(2);
    });

    const names = Array.from(container.querySelectorAll('.attachment-chip__name')).map(
      (el) => el.textContent
    );
    expect(names).toContain('screen1.png');
    expect(names).toContain('screen2.png');
  });
});
