// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { AddItem } from '../../../src/ui/add-menu/add-item.js';
import { ChatPanel } from '../../../src/ui/chat-panel.js';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';

vi.mock('../../../src/ui/voice-input.js', () => ({
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

vi.mock('../../../src/ui/provider-settings.js', () => ({
  getApiKey: () => '',
  showProviderSettings: () => {},
  applyProviderDefaults: () => {},
  getAllAvailableModels: () => [],
  getSelectedModelId: () => '',
  getSelectedProvider: () => null,
  setSelectedModelId: () => {},
  getProviderConfig: () => null,
}));

function makeAgent() {
  const sent: { text: string; id: string }[] = [];
  let cb: ((e: AgentEvent) => void) | null = null;
  const handle: AgentHandle = {
    sendMessage: (text: string, id: string) => sent.push({ text, id }),
    onEvent: (handler: (e: AgentEvent) => void) => {
      cb = handler;
      return () => {
        cb = null;
      };
    },
    stop: () => {},
  };
  return { sent, cb, handle };
}

describe('ChatPanel add-menu integration', () => {
  let container: HTMLElement;
  let testCounter = 0;

  beforeEach(() => {
    testCounter += 1;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {};
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

  it('compiles references into the preamble on send, keeps content plain, stores references, renders a chip', async () => {
    const panel = new ChatPanel(container);
    await panel.initSession(`test-add-integration-${testCounter}`);
    const { sent, handle } = makeAgent();
    panel.setAgent(handle);

    const ref: AddItem = { kind: 'file', label: 'CLAUDE.md', locator: '/workspace/CLAUDE.md' };
    panel.addReferenceForTest(ref);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'explain this';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();

    expect(sent[0].text).toBe(
      '[context]\n- file: /workspace/CLAUDE.md (CLAUDE.md)\n\nexplain this'
    );
    const stored = panel.getMessagesForTest().find((m) => m.role === 'user');
    expect(stored?.content).toBe('explain this');
    expect(stored?.references?.[0].locator).toBe('/workspace/CLAUDE.md');
    expect(container.textContent).not.toContain('[context]');
    expect(container.querySelector('.chat__ref-chip')?.textContent).toContain('CLAUDE.md');
  });

  it('dedupes references by kind+locator', () => {
    const panel = new ChatPanel(container);
    const ref: AddItem = { kind: 'file', label: 'CLAUDE.md', locator: '/workspace/CLAUDE.md' };
    panel.addReferenceForTest(ref);
    panel.addReferenceForTest(ref);
    expect(panel.getMessagesForTest().length).toBe(0);
    const chips = container.querySelectorAll('.chat__ref-chip');
    expect(chips.length).toBe(1);
  });

  it('sends plain text when there are no references', async () => {
    const panel = new ChatPanel(container);
    await panel.initSession(`test-add-plain-${testCounter}`);
    const { sent, handle } = makeAgent();
    panel.setAgent(handle);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'hello';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();

    expect(sent[0].text).toBe('hello');
  });
});
