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

// Mock image-processor: passthrough processImageContent, real isSupportedImageFormat/getImageByteSize
vi.mock('../../src/core/image-processor.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    processImageContent: vi.fn(async (image: { type: string; mimeType: string; data: string }) => {
      return image;
    }),
  };
});

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

  it('adds a raw base64 image attachment with defaults', async () => {
    await panel.addImageAttachment('abc123');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('screenshot.jpg');
    expect(container.querySelector('.chat__attachments--visible')).not.toBeNull();
  });

  it('adds an attachment with custom name and mimeType', async () => {
    await panel.addImageAttachment('abc123', 'photo.png', 'image/png');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('photo.png');
  });

  it('extracts mime and data from a full data URL', async () => {
    await panel.addImageAttachment('data:image/png;base64,iVBORw==', 'snap.png');

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

  it('handles malformed data URL by stripping prefix at comma', async () => {
    await panel.addImageAttachment('data:weird;base64,QUJD');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].data).toBe('QUJD');
  });

  it('rejects empty base64 input', async () => {
    await panel.addImageAttachment('');

    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });

  it('rejects data URL with empty payload', async () => {
    await panel.addImageAttachment('data:image/png;base64,');

    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });

  it('rejects oversized images (>10MB decoded)', async () => {
    // ~14MB of base64 data (decodes to ~10.5MB)
    const huge = 'A'.repeat(14 * 1024 * 1024);
    await panel.addImageAttachment(huge);

    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });

  it('sanitizes name: strips control characters', async () => {
    await panel.addImageAttachment('abc123', 'evil\x00\x1f\x7fname.png');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('evilname.png');
  });

  it('sanitizes name: truncates at 200 characters', async () => {
    const longName = 'a'.repeat(250) + '.png';
    await panel.addImageAttachment('abc123', longName);

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent?.length).toBeLessThanOrEqual(200);
  });

  it('falls back to default name when sanitized name is empty', async () => {
    await panel.addImageAttachment('abc123', '\x00\x01\x02');

    const chip = container.querySelector('.attachment-chip__name');
    expect(chip?.textContent).toBe('screenshot.jpg');
  });

  it('rejects invalid mimeType and falls back to image/jpeg', async () => {
    await panel.addImageAttachment('abc123', 'test.jpg', 'text/html');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].mimeType).toBe('image/jpeg');
  });

  it('rejects image/svg+xml and falls back to image/jpeg', async () => {
    await panel.addImageAttachment('abc123', 'icon.svg', 'image/svg+xml');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].mimeType).toBe('image/jpeg');
  });

  it('accepts valid image mime types', async () => {
    await panel.addImageAttachment('abc123', 'test.webp', 'image/webp');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].mimeType).toBe('image/webp');
  });

  it('multiple calls add separate attachment chips', async () => {
    await panel.addImageAttachment('abc', 'first.png', 'image/png');
    await panel.addImageAttachment('def', 'second.jpg', 'image/jpeg');

    const chips = container.querySelectorAll('.attachment-chip__name');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('first.png');
    expect(chips[1].textContent).toBe('second.jpg');
  });

  it('uses getImageByteSize for accurate size estimation', async () => {
    // 12 base64 chars = 9 decoded bytes (no padding)
    await panel.addImageAttachment('YWJjZGVmZ2hp');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'go';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0].size).toBe(9);
  });

  it('drops attachment when processImageContent returns text (unsupported)', async () => {
    const { processImageContent } = await import('../../src/core/image-processor.js');
    const mock = processImageContent as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ type: 'text', text: '[Image removed]' });

    await panel.addImageAttachment('abc123', 'huge.png', 'image/png');

    expect(container.querySelector('.chat__attachments--visible')).toBeNull();
  });
});
