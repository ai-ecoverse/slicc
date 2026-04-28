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

describe('ChatPanel attachments', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let sendMessage: ReturnType<typeof vi.fn>;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter += 1;
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-attachments-${testCounter}`);
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
  });

  it('adds a text file attachment and sends it with the chat message', async () => {
    const file = new File(['hello from a file'], 'notes.txt', { type: 'text/plain' });

    await panel.addAttachmentsFromFiles([file]);

    expect(container.querySelector('.chat__attachments--visible')).not.toBeNull();
    expect(container.querySelector('.attachment-chip__name')?.textContent).toBe('notes.txt');

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'Use this file';
    textarea.dispatchEvent(new Event('input'));
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, _id, attachments] = sendMessage.mock.calls[0];
    expect(text).toBe('Use this file');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: 'notes.txt',
      mimeType: 'text/plain',
      kind: 'text',
      text: 'hello from a file',
    });
    expect(container.querySelector('.msg--user .attachment-chip__name')?.textContent).toBe(
      'notes.txt'
    );
  });

  it('off-loads oversized text files to /tmp via the attachment writer', async () => {
    const writer = vi.fn(async (file: File) => `/tmp/written-${file.name}`);
    panel.setAttachmentWriter(writer);

    // 600 KB text file — well above the 512 KB inline cap.
    const big = new File([new Uint8Array(600 * 1024).fill(65)], 'big.log', {
      type: 'text/plain',
    });

    await panel.addAttachmentsFromFiles([big]);

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(big);

    expect(container.querySelector('.attachment-chip__path')?.textContent).toBe(
      '/tmp/written-big.log'
    );

    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0]).toMatchObject({
      name: 'big.log',
      kind: 'text',
      path: '/tmp/written-big.log',
    });
    expect(attachments[0].text).toBeUndefined();
  });

  it('off-loads unsupported binaries to /tmp via the attachment writer', async () => {
    const writer = vi.fn(async () => '/tmp/written-archive.zip');
    panel.setAttachmentWriter(writer);

    const blob = new File([new Uint8Array([1, 2, 3, 4])], 'archive.zip', {
      type: 'application/zip',
    });

    await panel.addAttachmentsFromFiles([blob]);
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    const [, , attachments] = sendMessage.mock.calls[0];
    expect(attachments[0]).toMatchObject({
      name: 'archive.zip',
      kind: 'file',
      path: '/tmp/written-archive.zip',
    });
  });

  it('can send an image-only message', async () => {
    // Smallest valid 1x1 transparent PNG, expressed as raw bytes to avoid
    // tripping secret scanners on the base64 form.
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
      0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64,
      0x60, 0x00, 0x00, 0x00, 0x06, 0x00, 0x02, 0x30, 0x81, 0xd0, 0x2f, 0x00, 0x00, 0x00, 0x00,
      0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const file = new File([tinyPng], 'dot.png', { type: 'image/png' });

    await panel.addAttachmentsFromFiles([file]);
    (container.querySelector('.chat__send-btn') as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text, _id, attachments] = sendMessage.mock.calls[0];
    expect(text).toBe('');
    expect(attachments[0]).toMatchObject({
      name: 'dot.png',
      mimeType: 'image/png',
      kind: 'image',
    });
    expect(attachments[0].data).toBeTruthy();
    expect(container.querySelector('.msg--user .attachment-chip img')).not.toBeNull();
  });
});
