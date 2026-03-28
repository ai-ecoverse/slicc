// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../../src/ui/chat-panel.js';

describe('ChatPanel pending handoff modal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the first pending handoff and shows the queue count', () => {
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
        sourceUrl: 'https://www.sliccy.ai/handoffs#one',
        receivedAt: new Date().toISOString(),
        payload: {
          title: 'Verify signup',
          instruction: 'Check whether signup works.',
          urls: ['https://example.com/signup'],
        },
      },
      {
        handoffId: 'handoff-2',
        sourceUrl: 'https://www.sliccy.ai/handoffs#two',
        receivedAt: new Date().toISOString(),
        payload: {
          instruction: 'Check a second task.',
        },
      },
    ]);

    const modal = container.querySelector('.chat__handoff-modal') as HTMLElement;
    expect(modal.hidden).toBe(false);
    expect(modal.textContent).toContain('Verify signup');
    expect(modal.textContent).toContain('Check whether signup works.');
    expect(modal.textContent).toContain('2 pending');
    expect(modal.textContent).toContain('https://example.com/signup');
  });

  it('invokes accept and dismiss callbacks for the current queued handoff', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    const onAccept = vi.fn();
    const onDismiss = vi.fn();

    panel.setPendingHandoffActions({ onAccept, onDismiss });
    panel.setPendingHandoffs([
      {
        handoffId: 'handoff-1',
        sourceUrl: 'https://www.sliccy.ai/handoffs#one',
        receivedAt: new Date().toISOString(),
        payload: {
          instruction: 'Continue this task in SLICC.',
          acceptanceCriteria: ['Summarize pass/fail'],
        },
      },
    ]);

    const acceptBtn = container.querySelector('[data-action="accept"]') as HTMLButtonElement;
    const dismissBtn = container.querySelector('[data-action="dismiss"]') as HTMLButtonElement;
    acceptBtn.click();
    dismissBtn.click();

    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ handoffId: 'handoff-1' })
    );
    expect(onDismiss).toHaveBeenCalledWith(
      expect.objectContaining({ handoffId: 'handoff-1' })
    );
  });
});
