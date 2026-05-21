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

describe('ChatPanel.addImageAttachment', () => {
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
    await panel.initSession(`test-image-attach-${testCounter}`);
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

  it('adds a raw base64 image attachment with defaults', () => {
    panel.addImageAttachment('abc123');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('screenshot.jpg');
    expect(container.querySelector('.chat__attachments--visible')).not.toBeNull();
  });

  it('adds an attachment with custom name and mimeType', () => {
    panel.addImageAttachment('abc123', 'photo.png', 'image/png');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('photo.png');
  });

  it('extracts mime and data from a full data URL', () => {
    panel.addImageAttachment('data:image/png;base64,iVBORw==', 'snap.png');

    // Sends the extracted base64 data, not the full URL
    const textarea = container.querySelector('textarea')!;
    textarea.value = 'check this';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0]).toMatchObject({
      name: 'snap.png',
      mimeType: 'image/png',
      data: 'iVBORw==',
      kind: 'image',
    });
  });

  it('handles malformed data URL by stripping prefix at comma', () => {
    panel.addImageAttachment('data:weird;base64,QUJD');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].data).toBe('QUJD');
  });

  it('rejects empty base64 input', () => {
    panel.addImageAttachment('');

    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });

  it('rejects oversized images (>10MB decoded)', () => {
    // ~14MB of base64 data (decodes to ~10.5MB)
    const huge = 'A'.repeat(14 * 1024 * 1024);
    panel.addImageAttachment(huge);

    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });

  it('sanitizes name: strips control characters', () => {
    panel.addImageAttachment('abc123', 'evil\x00\x1f\x7fname.png');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('evilname.png');
  });

  it('sanitizes name: truncates at 200 characters', () => {
    const longName = 'a'.repeat(250) + '.png';
    panel.addImageAttachment('abc123', longName);

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent?.length).toBeLessThanOrEqual(200);
  });

  it('falls back to default name when sanitized name is empty', () => {
    panel.addImageAttachment('abc123', '\x00\x01\x02');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('screenshot.jpg');
  });

  it('rejects invalid mimeType and falls back to image/jpeg', () => {
    panel.addImageAttachment('abc123', 'test.jpg', 'text/html');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].mimeType).toBe('image/jpeg');
  });

  it('accepts valid image mime types', () => {
    panel.addImageAttachment('abc123', 'test.webp', 'image/webp');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].mimeType).toBe('image/webp');
  });

  it('multiple calls add separate attachment chips', () => {
    panel.addImageAttachment('abc', 'first.png', 'image/png');
    panel.addImageAttachment('def', 'second.jpg', 'image/jpeg');

    const chips = container.querySelectorAll('.attachment-chip__name');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('first.png');
    expect(chips[1].textContent).toBe('second.jpg');
  });

  it('estimates size from base64 length', () => {
    // 12 base64 chars = 9 decoded bytes
    panel.addImageAttachment('YWJjZGVmZ2hp');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].size).toBe(9);
  });
});
