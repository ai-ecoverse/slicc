// @vitest-environment jsdom
/**
 * Tests for the "Working" cluster's LLM-generated preview label.
 *
 * The preview row next to "Working" starts as a comma-joined fallback
 * (e.g. `bash, bash, bash`) and is replaced asynchronously by a short
 * LLM-suggested phrase. Two behaviors matter:
 *
 *   - The label must stay stable across re-renders. Once an LLM label
 *     has been shown for a cluster, growing the cluster by one tool
 *     call must not flicker back to the comma-joined fallback while
 *     the new signature's label is being fetched.
 *   - The LLM call must be debounced. A fast burst of tool calls
 *     adding to the same cluster should result in a single label
 *     request once the burst settles, not one per call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { ChatMessage, ToolCall } from '../../src/ui/types.js';

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

const quickLabelMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/ui/quick-llm.js', () => ({
  quickLabel: quickLabelMock,
}));

// Imported AFTER the mocks above so the chat panel binds the mocked
// `quickLabel` rather than the real one.
const { ChatPanel } = await import('../../src/ui/chat-panel.js');

const tc = (overrides: Partial<ToolCall> & { name: string; id: string }): ToolCall => ({
  id: overrides.id,
  name: overrides.name,
  input: overrides.input ?? { command: `echo ${overrides.id}` },
  result: overrides.result,
  isError: overrides.isError,
});

const assistantMsg = (id: string, toolCalls: ToolCall[], timestamp: number): ChatMessage => ({
  id,
  role: 'assistant',
  content: '',
  timestamp,
  toolCalls,
});

/** Resolve the next microtask queue plus any pending then-handlers so
 *  the `quickLabel` promise chain inside `fireClusterLabelRequest` has
 *  a chance to call `settle()` before assertions run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const DEBOUNCE_MS = 600;

let testCounter = 0;

describe('ChatPanel cluster-label LLM behavior', () => {
  let container: HTMLElement;
  let panel: InstanceType<typeof ChatPanel>;

  beforeEach(async () => {
    testCounter += 1;
    quickLabelMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    panel = new ChatPanel(container);
    await panel.initSession(`test-cluster-label-${testCounter}`);
    // Install fake timers AFTER initSession — fake-indexeddb's setup
    // path uses real setTimeout and would deadlock otherwise.
    vi.useFakeTimers();
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  const previewEl = (): HTMLElement | null =>
    container.querySelector('.tool-call-cluster .tool-call__preview');

  it('debounces a burst of tool calls into a single LLM request', async () => {
    quickLabelMock.mockResolvedValue('Run a burst of shell commands');

    // First render: three calls, just enough to form a cluster.
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash' })], 2200),
    ]);

    // Inside the debounce window: keep growing the cluster.
    vi.advanceTimersByTime(100);
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash' })], 2200),
      assistantMsg('a4', [tc({ id: 'tc-4', name: 'bash' })], 2300),
    ]);
    vi.advanceTimersByTime(100);
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash' })], 2200),
      assistantMsg('a4', [tc({ id: 'tc-4', name: 'bash' })], 2300),
      assistantMsg('a5', [tc({ id: 'tc-5', name: 'bash' })], 2400),
    ]);

    // Nothing fires while we're still inside the debounce window.
    expect(quickLabelMock).toHaveBeenCalledTimes(0);

    // Let the burst settle.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flushMicrotasks();

    // Exactly one LLM call for the whole burst.
    expect(quickLabelMock).toHaveBeenCalledTimes(1);

    // And the prompt covered the LATEST snapshot (all five calls), not
    // the original three.
    const callArg = quickLabelMock.mock.calls[0][0] as { prompt: string };
    expect(callArg.prompt).toMatch(/5\. bash:/);

    expect(previewEl()?.textContent).toBe('Run a burst of shell commands');
  });

  it('keeps the sticky LLM label across re-renders instead of flickering back to the comma-joined fallback', async () => {
    quickLabelMock.mockResolvedValue('Inspect repository files');

    // First render: 3-call cluster. Fire the LLM label.
    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash' })], 2200),
    ]);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flushMicrotasks();
    expect(previewEl()?.textContent).toBe('Inspect repository files');
    expect(quickLabelMock).toHaveBeenCalledTimes(1);

    // Now grow the cluster — new signature, no cache hit. The next
    // `quickLabel` resolves with a different label, but we won't let
    // it land yet; the assertion is about what the user sees in the
    // *meantime*.
    let resolveSecond: (v: string) => void = () => {};
    quickLabelMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSecond = resolve;
        })
    );

    panel.loadMessages([
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash' })], 2200),
      assistantMsg('a4', [tc({ id: 'tc-4', name: 'bash' })], 2300),
    ]);

    // Immediately after the re-render — before the debounce fires —
    // the preview must show the previously-shown LLM label, NOT the
    // comma-joined fallback "bash, bash, bash, bash".
    expect(previewEl()?.textContent).toBe('Inspect repository files');
    expect(previewEl()?.textContent ?? '').not.toMatch(/^bash, bash/);

    // Even after the debounce timer fires and the new request is in
    // flight, the sticky label still wins until the new label lands.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flushMicrotasks();
    expect(previewEl()?.textContent).toBe('Inspect repository files');

    // Once the new request resolves, the preview updates.
    resolveSecond('Inspect repository files and tests');
    await flushMicrotasks();
    expect(previewEl()?.textContent).toBe('Inspect repository files and tests');
  });

  it('reuses the cached label for an identical re-render without firing again', async () => {
    quickLabelMock.mockResolvedValue('Compare drafts against published files');

    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go', timestamp: 1000 },
      assistantMsg('a1', [tc({ id: 'tc-1', name: 'bash' })], 2000),
      assistantMsg('a2', [tc({ id: 'tc-2', name: 'bash' })], 2100),
      assistantMsg('a3', [tc({ id: 'tc-3', name: 'bash' })], 2200),
    ];
    panel.loadMessages(messages);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flushMicrotasks();
    expect(quickLabelMock).toHaveBeenCalledTimes(1);
    expect(previewEl()?.textContent).toBe('Compare drafts against published files');

    // Re-render with the exact same tool calls — cache hit, no new
    // request, label still shown.
    panel.loadMessages(messages);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flushMicrotasks();
    expect(quickLabelMock).toHaveBeenCalledTimes(1);
    expect(previewEl()?.textContent).toBe('Compare drafts against published files');
  });
});
