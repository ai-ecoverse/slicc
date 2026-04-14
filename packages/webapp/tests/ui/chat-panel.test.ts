// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../../src/ui/chat-panel.js';

function installMockLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

describe('ChatPanel pending handoffs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installMockLocalStorage();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders all pending handoffs and shows the queue count', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);

    panel.setPendingHandoffActions({
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
    });
    panel.setPendingHandoffs([
      {
        handoffId: 'handoff-1',
        sourceUrl: 'https://www.sliccy.ai/handoff#one',
        receivedAt: new Date().toISOString(),
        payload: {
          title: 'Verify signup',
          instruction: 'Check whether signup works.',
          urls: ['https://example.com/signup'],
        },
      },
      {
        handoffId: 'handoff-2',
        sourceUrl: 'https://www.sliccy.ai/handoff#two',
        receivedAt: new Date().toISOString(),
        payload: {
          title: 'Check a second task',
          instruction: 'Check a second task.',
        },
      },
    ]);

    const handoffs = container.querySelector('.chat__handoffs') as HTMLElement;
    const cards = container.querySelectorAll('.chat__handoff-card');
    expect(handoffs.hidden).toBe(false);
    expect(handoffs.textContent).toContain('2 pending handoffs');
    expect(cards).toHaveLength(2);
    expect(handoffs.textContent).toContain('Verify signup');
    expect(handoffs.textContent).toContain('Check whether signup works.');
    expect(handoffs.textContent).toContain('Check a second task');
    expect(handoffs.textContent).toContain('https://example.com/signup');
  });

  it('renders pending handoffs after the chat messages container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);

    panel.setPendingHandoffActions({
      onAccept: vi.fn(),
      onDismiss: vi.fn(),
    });
    panel.addUserMessage('Existing chat history');
    panel.setPendingHandoffs([
      {
        handoffId: 'handoff-1',
        sourceUrl: 'https://www.sliccy.ai/handoff#one',
        receivedAt: new Date().toISOString(),
        payload: {
          title: 'Later handoff',
          instruction: 'Show this after the chat history.',
        },
      },
    ]);

    const messagesInner = container.querySelector('.chat__messages-inner');
    const handoffs = container.querySelector('.chat__handoffs');
    expect(messagesInner?.nextElementSibling).toBe(handoffs);
  });

  it('invokes accept and dismiss callbacks for the selected handoff card', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    const onAccept = vi.fn();
    const onDismiss = vi.fn();

    panel.setPendingHandoffActions({ onAccept, onDismiss });
    panel.setPendingHandoffs([
      {
        handoffId: 'handoff-1',
        sourceUrl: 'https://www.sliccy.ai/handoff#one',
        receivedAt: new Date().toISOString(),
        payload: {
          instruction: 'Continue this task in SLICC.',
          acceptanceCriteria: ['Summarize pass/fail'],
        },
      },
      {
        handoffId: 'handoff-2',
        sourceUrl: 'https://www.sliccy.ai/handoff#two',
        receivedAt: new Date().toISOString(),
        payload: {
          instruction: 'Handle another task.',
        },
      },
    ]);

    const acceptBtn = container.querySelector(
      '[data-action="accept"][data-handoff-id="handoff-1"]'
    ) as HTMLButtonElement;
    const dismissBtn = container.querySelector(
      '[data-action="dismiss"][data-handoff-id="handoff-2"]'
    ) as HTMLButtonElement;
    acceptBtn.click();
    dismissBtn.click();

    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'handoff-1' }));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'handoff-2' }));
  });
});
