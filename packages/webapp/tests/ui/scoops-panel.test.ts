// @vitest-environment jsdom
/**
 * Tests for the standalone scoops-rail tooltip's scope-label wiring.
 *
 * Covers the gap that let `OffscreenClient`-as-Orchestrator slip through
 * unit tests: when a side-effect-free transcript source is injected via
 * `setScopeTranscriptSource`, the rail labeler MUST route through it
 * instead of `Orchestrator.getMessagesForScoop` (which the standalone
 * worker shim does not implement). Also asserts the fallback tooltip
 * line is extracted from the transcript string via
 * `extractLatestUserPrompt`, matching the dropdown switcher.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const quickLabelMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>());
vi.mock('../../src/ui/quick-llm.js', () => ({
  quickLabel: quickLabelMock,
}));

// jsdom doesn't expose `CSS.escape`; the panel uses it to safely quote
// jid values in DOM selectors. A minimal alphanumeric/dash passthrough is
// enough for the synthetic jids we use here.
if (typeof (globalThis as any).CSS === 'undefined') {
  (globalThis as any).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
}

const { ScoopsPanel } = await import('../../src/ui/scoops-panel.js');

import type { RegisteredScoop } from '../../src/scoops/types.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function makeCone(jid = 'cone-1'): RegisteredScoop {
  return {
    jid,
    name: 'sliccy',
    folder: 'sliccy',
    isCone: true,
    type: 'cone',
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: new Date().toISOString(),
  };
}

function makeOrchestrator(scoops: RegisteredScoop[]) {
  return {
    getScoops: vi.fn(() => scoops),
    // Spy that must NOT be called when a transcript source is wired.
    // Returns a rejected promise so any accidental call also fails fast.
    getMessagesForScoop: vi.fn(async () => {
      throw new Error('getMessagesForScoop must not be called when transcript source is wired');
    }),
  };
}

beforeEach(() => {
  quickLabelMock.mockReset();
  document.body.innerHTML = '';
});

describe('ScoopsPanel scope tooltip', () => {
  it('routes the rail labeler through the injected transcript source (not getMessagesForScoop)', async () => {
    quickLabelMock.mockResolvedValue('refactoring auth flow');
    const cone = makeCone('cone-1');
    const orch = makeOrchestrator([cone]);
    const fetchTranscript = vi.fn(async () => 'user: refactor auth\nassistant: starting');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ScoopsPanel(container, { onScoopSelect: () => {}, onSendMessage: () => {} });
    panel.setScopeTranscriptSource(fetchTranscript);
    // biome-ignore lint/suspicious/noExplicitAny: fake orchestrator covers only the surface the panel touches
    panel.setOrchestrator(orch as any);

    const item = container.querySelector<HTMLElement>('.scoop-item[data-jid="cone-1"]')!;
    expect(item).toBeTruthy();

    item.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    await flush();

    expect(fetchTranscript).toHaveBeenCalledWith('cone-1');
    expect(orch.getMessagesForScoop).not.toHaveBeenCalled();
    // Once the labeler resolves, it updates the active tooltip in place.
    const scope = document.querySelector<HTMLElement>('.scoop-fixed-tooltip__scope');
    expect(scope?.textContent).toBe('refactoring auth flow');
  });

  it('falls back to extractLatestUserPrompt of the transcript string when no LLM label is cached', async () => {
    // quickLabel returns null → no cached label → tooltip falls back to
    // the latest-user-prompt line populated from the transcript string.
    quickLabelMock.mockResolvedValue(null);
    const cone = makeCone('cone-1');
    const orch = makeOrchestrator([cone]);
    const fetchTranscript = vi.fn(
      async () => 'assistant: ok\nuser: please summarize the recent diff\nassistant: sure'
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ScoopsPanel(container, { onScoopSelect: () => {}, onSendMessage: () => {} });
    panel.setScopeTranscriptSource(fetchTranscript);
    // biome-ignore lint/suspicious/noExplicitAny: fake orchestrator covers only the surface the panel touches
    panel.setOrchestrator(orch as any);

    const item = container.querySelector<HTMLElement>('.scoop-item[data-jid="cone-1"]')!;

    // First hover: tooltip renders with no fallback yet (cache empty),
    // then the labeler resolves and populates `lastUserPrompts`.
    item.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    await flush();
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    expect(orch.getMessagesForScoop).not.toHaveBeenCalled();

    // Re-hover so the tooltip rebuilds and now reads the populated cache.
    item.dispatchEvent(new MouseEvent('mouseleave'));
    item.dispatchEvent(new MouseEvent('mouseenter'));
    const scope = document.querySelector<HTMLElement>('.scoop-fixed-tooltip__scope');
    expect(scope?.textContent).toBe('please summarize the recent diff');
    expect(scope?.style.display).not.toBe('none');
  });

  it('stores the cached fallback prompt truncated (injected source path)', async () => {
    quickLabelMock.mockResolvedValue(null);
    const cone = makeCone('cone-1');
    const orch = makeOrchestrator([cone]);
    const longPrompt = `please ${'really '.repeat(40)}summarize the recent diff`;
    expect(longPrompt.length).toBeGreaterThan(80);
    const fetchTranscript = vi.fn(async () => `user: ${longPrompt}\nassistant: ok`);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ScoopsPanel(container, { onScoopSelect: () => {}, onSendMessage: () => {} });
    panel.setScopeTranscriptSource(fetchTranscript);
    // biome-ignore lint/suspicious/noExplicitAny: fake orchestrator covers only the surface the panel touches
    panel.setOrchestrator(orch as any);

    const item = container.querySelector<HTMLElement>('.scoop-item[data-jid="cone-1"]')!;
    item.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    await flush();
    item.dispatchEvent(new MouseEvent('mouseleave'));
    item.dispatchEvent(new MouseEvent('mouseenter'));

    const scope = document.querySelector<HTMLElement>('.scoop-fixed-tooltip__scope');
    const text = scope?.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith('…')).toBe(true);
  });

  it('stores the cached fallback prompt truncated (orchestrator path)', async () => {
    quickLabelMock.mockResolvedValue(null);
    const cone = makeCone('cone-1');
    const longContent = `please ${'really '.repeat(40)}summarize the recent diff`;
    expect(longContent.length).toBeGreaterThan(80);
    const orch = {
      getScoops: vi.fn(() => [cone]),
      getMessagesForScoop: vi.fn(async () => [
        { fromAssistant: false, senderName: 'user', content: longContent },
      ]),
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ScoopsPanel(container, { onScoopSelect: () => {}, onSendMessage: () => {} });
    // No transcript source: orchestrator branch must run.
    // biome-ignore lint/suspicious/noExplicitAny: fake orchestrator covers only the surface the panel touches
    panel.setOrchestrator(orch as any);

    const item = container.querySelector<HTMLElement>('.scoop-item[data-jid="cone-1"]')!;
    item.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    await flush();
    expect(orch.getMessagesForScoop).toHaveBeenCalledWith('cone-1');
    item.dispatchEvent(new MouseEvent('mouseleave'));
    item.dispatchEvent(new MouseEvent('mouseenter'));

    const scope = document.querySelector<HTMLElement>('.scoop-fixed-tooltip__scope');
    const text = scope?.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith('…')).toBe(true);
  });

  it('hides the scope line when the transcript yields no user prompt and no label', async () => {
    quickLabelMock.mockResolvedValue(null);
    const cone = makeCone('cone-1');
    const orch = makeOrchestrator([cone]);
    const fetchTranscript = vi.fn(async () => 'assistant: just thinking');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ScoopsPanel(container, { onScoopSelect: () => {}, onSendMessage: () => {} });
    panel.setScopeTranscriptSource(fetchTranscript);
    // biome-ignore lint/suspicious/noExplicitAny: fake orchestrator covers only the surface the panel touches
    panel.setOrchestrator(orch as any);

    const item = container.querySelector<HTMLElement>('.scoop-item[data-jid="cone-1"]')!;
    item.dispatchEvent(new MouseEvent('mouseenter'));
    await flush();
    await flush();
    item.dispatchEvent(new MouseEvent('mouseleave'));
    item.dispatchEvent(new MouseEvent('mouseenter'));

    const scope = document.querySelector<HTMLElement>('.scoop-fixed-tooltip__scope');
    expect(scope?.style.display).toBe('none');
  });
});
