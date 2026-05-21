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

describe('ChatPanel image preview integration', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
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
    await panel.initSession(`test-preview-${testCounter}`);
    const handle: AgentHandle = {
      sendMessage: vi.fn(),
      onEvent(_cb: (event: AgentEvent) => void) {
        return () => {};
      },
      stop() {},
    };
    panel.setAgent(handle);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll('.image-preview-overlay').forEach((el) => el.remove());
    vi.unstubAllGlobals();
  });

  it('opens image preview when clicking an image attachment chip', async () => {
    const pngBytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ),
      (c) => c.charCodeAt(0)
    );
    const file = new File([pngBytes], 'screenshot.png', { type: 'image/png' });
    await panel.addAttachmentsFromFiles([file]);

    const chip = container.querySelector('.attachment-chip--image');
    expect(chip).toBeTruthy();

    chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const overlay = document.querySelector('.image-preview-overlay');
    expect(overlay).toBeTruthy();
  });

  it('does not open preview when clicking the remove button', async () => {
    const pngBytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      ),
      (c) => c.charCodeAt(0)
    );
    const file = new File([pngBytes], 'screenshot.png', { type: 'image/png' });
    await panel.addAttachmentsFromFiles([file]);

    const removeBtn = container.querySelector('.attachment-chip__remove');
    expect(removeBtn).toBeTruthy();

    removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const overlay = document.querySelector('.image-preview-overlay');
    expect(overlay).toBeFalsy();
  });
});
