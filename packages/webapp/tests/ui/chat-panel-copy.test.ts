// @vitest-environment jsdom
/**
 * Tests for the chat copy button on the assistant feedback row.
 *
 * Eric asked for a way to copy just the most recent assistant
 * response (the copy-all default produced very long blobs). David
 * proposed short-press = recent / long-press = all, re-using the
 * side-rail click-and-hold gesture. These tests pin both branches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ChatPanel, formatChatForClipboard } from '../../src/ui/chat-panel.js';
import type { ChatMessage } from '../../src/ui/types.js';
import { LONG_PRESS_MS } from '../../src/ui/long-press.js';

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

let testCounter = 0;

describe('ChatPanel copy button', () => {
  let container: HTMLElement;
  let panel: ChatPanel;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testCounter += 1;
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-copy-${testCounter}`);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  function loadConversation() {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'first question', timestamp: 1000 },
      { id: 'a1', role: 'assistant', content: 'first answer', timestamp: 2000 },
      { id: 'u2', role: 'user', content: 'second question', timestamp: 3000 },
      { id: 'a2', role: 'assistant', content: 'most recent answer', timestamp: 4000 },
    ];
    panel.loadMessages(messages);
  }

  function getCopyBtn(): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>('.msg__feedback-btn');
    if (!btn) throw new Error('copy button not rendered');
    return btn;
  }

  it('renders the feedback row only after the last assistant message', () => {
    loadConversation();
    const rows = container.querySelectorAll('.msg__feedback');
    expect(rows.length).toBe(1);
  });

  it('short click copies just the most recent assistant response', async () => {
    loadConversation();
    const btn = getCopyBtn();
    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('click'));

    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('most recent answer');
  });

  it('long press copies the entire chat in markdown form', async () => {
    vi.useFakeTimers();
    loadConversation();
    const btn = getCopyBtn();

    btn.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    // The trailing click event after the press should be suppressed
    // by the gesture helper.
    btn.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    btn.dispatchEvent(new MouseEvent('click'));

    // Flush microtasks (real timers again so awaits resolve).
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0];
    expect(payload).toContain('## User\nfirst question');
    expect(payload).toContain('## Assistant\nfirst answer');
    expect(payload).toContain('## User\nsecond question');
    expect(payload).toContain('## Assistant\nmost recent answer');
  });

  it('modifier-click is treated as a long-press (copies all)', async () => {
    loadConversation();
    const btn = getCopyBtn();

    btn.dispatchEvent(new MouseEvent('click', { metaKey: true }));

    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0];
    expect(payload).toContain('## User\nfirst question');
    expect(payload).toContain('## Assistant\nmost recent answer');
  });

  it('formatChatForClipboard includes attachments and tool calls', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'check this',
        timestamp: 1,
        attachments: [
          {
            id: 'att1',
            kind: 'text',
            name: 'note.txt',
            size: 12,
            mimeType: 'text/plain',
            text: 'hello',
          },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'ok',
        timestamp: 2,
        toolCalls: [
          {
            id: 'tc1',
            name: 'read_file',
            input: { path: '/tmp/note.txt' },
            result: 'hello',
          },
        ],
      },
    ];
    const formatted = formatChatForClipboard(messages);
    expect(formatted).toContain('## User\ncheck this');
    expect(formatted).toContain('Attachments:');
    expect(formatted).toContain('### Tool: read_file');
    expect(formatted).toContain('"path": "/tmp/note.txt"');
    expect(formatted).toContain('Result: hello');
  });
});
