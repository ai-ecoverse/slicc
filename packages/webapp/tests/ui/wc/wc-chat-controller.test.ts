// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

vi.mock('../../../src/kernel/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/kernel/telemetry.js')>(
    '../../../src/kernel/telemetry.js'
  );
  return {
    ...actual,
    trackChatSend: vi.fn(),
    trackError: vi.fn(),
    trackLickBackpressure: vi.fn(),
  };
});

import { trackChatSend, trackError, trackLickBackpressure } from '../../../src/kernel/telemetry.js';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';

class FakeAgent implements AgentHandle {
  listeners = new Set<(event: AgentEvent) => void>();
  sent: Array<{ text: string; messageId?: string; steer?: boolean }> = [];
  stopped = 0;

  sendMessage(
    text: string,
    messageId?: string,
    _attachments?: unknown,
    options?: { steer?: boolean }
  ): void {
    this.sent.push({ text, messageId, steer: options?.steer });
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  stop(): void {
    this.stopped++;
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('WcChatController', () => {
  let thread: HTMLElement;
  let agent: FakeAgent;
  let controller: WcChatController;
  let processingStates: boolean[];
  let busyPhases: Array<'thinking' | 'tool'>;

  beforeEach(() => {
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    processingStates = [];
    busyPhases = [];
    vi.mocked(trackChatSend).mockClear();
    vi.mocked(trackError).mockClear();
    vi.mocked(trackLickBackpressure).mockClear();
    controller = new WcChatController({
      thread,
      agent,
      onProcessingChange: (processing) => processingStates.push(processing),
      onBusyPhaseChange: (phase) => busyPhases.push(phase),
    });
  });

  it('sends user prompts to the agent and renders the bubble locally', () => {
    controller.sendUserMessage('  build me a shader  ');
    expect(agent.sent).toEqual([
      { text: 'build me a shader', messageId: expect.any(String), steer: undefined },
    ]);
    const bubble = thread.querySelector('slicc-user-message');
    expect(bubble?.shadowRoot?.textContent).toContain('build me a shader');
  });

  it('ignores empty prompts', () => {
    controller.sendUserMessage('   ');
    expect(agent.sent).toEqual([]);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);
  });

  it('strips dictation markers on the follower echo while the agent + history keep them', async () => {
    const { resetDictationPriming } = await import('../../../src/speech/dictation-priming.js');
    resetDictationPriming();
    const localEchoes: Array<{ text: string; messageId: string }> = [];
    controller.setOnLocalUserMessage((text, messageId) => {
      localEchoes.push({ text, messageId });
    });
    controller.sendUserMessage('hello there', undefined, { dictation: true });

    expect(agent.sent.length).toBe(1);
    expect(agent.sent[0].text).toContain('\uD83C\uDF99');
    expect(agent.sent[0].text).toMatch(/\u25C1[\s\S]*\u25B7/);
    const stored = controller.getMessages().find((m) => m.role === 'user');
    expect(stored?.content).toContain('\uD83C\uDF99');

    expect(localEchoes.length).toBe(1);
    expect(localEchoes[0].text).toBe('hello there');
    expect(localEchoes[0].text).not.toContain('\uD83C\uDF99');
    expect(localEchoes[0].text).not.toMatch(/\u25C1[\s\S]*\u25B7/);
    expect(localEchoes[0].messageId).toBe(stored?.id);
  });

  it('passes a non-dictated send unchanged to both the agent and the follower echo', () => {
    const localEchoes: Array<{ text: string; messageId: string }> = [];
    controller.setOnLocalUserMessage((text, messageId) => {
      localEchoes.push({ text, messageId });
    });
    controller.sendUserMessage('plain typed prompt');
    expect(agent.sent.map((s) => s.text)).toEqual(['plain typed prompt']);
    expect(localEchoes.map((e) => e.text)).toEqual(['plain typed prompt']);
  });

  describe('telemetry beacon (trackChatSend)', () => {
    it('fires once per user-initiated send with the resolved scoop + model', () => {
      const local = document.createElement('slicc-chat-thread');
      document.body.appendChild(local);
      const localAgent = new FakeAgent();
      const ctl = new WcChatController({
        thread: local,
        agent: localAgent,
        resolveTelemetryContext: () => ({ scoopName: 'cone', model: 'claude-sonnet-4-6' }),
      });
      ctl.sendUserMessage('hello world');
      expect(trackChatSend).toHaveBeenCalledTimes(1);
      expect(trackChatSend).toHaveBeenCalledWith('cone', 'claude-sonnet-4-6');
    });

    it('does not fire when the prompt is empty (no send happened)', () => {
      const local = document.createElement('slicc-chat-thread');
      document.body.appendChild(local);
      const localAgent = new FakeAgent();
      const ctl = new WcChatController({
        thread: local,
        agent: localAgent,
        resolveTelemetryContext: () => ({ scoopName: 'cone', model: 'm' }),
      });
      ctl.sendUserMessage('   ');
      expect(trackChatSend).not.toHaveBeenCalled();
    });

    it('skips the beacon when the context resolver returns null (boot race)', () => {
      const local = document.createElement('slicc-chat-thread');
      document.body.appendChild(local);
      const localAgent = new FakeAgent();
      const ctl = new WcChatController({
        thread: local,
        agent: localAgent,
        resolveTelemetryContext: () => null,
      });
      ctl.sendUserMessage('hello');
      expect(trackChatSend).not.toHaveBeenCalled();

      expect(localAgent.sent.map((s) => s.text)).toEqual(['hello']);
    });

    it('swallows resolver throws so a broken resolver cannot block the send', () => {
      const local = document.createElement('slicc-chat-thread');
      document.body.appendChild(local);
      const localAgent = new FakeAgent();
      const ctl = new WcChatController({
        thread: local,
        agent: localAgent,
        resolveTelemetryContext: () => {
          throw new Error('resolver blew up');
        },
      });
      expect(() => ctl.sendUserMessage('hello')).not.toThrow();
      expect(trackChatSend).not.toHaveBeenCalled();
      expect(localAgent.sent.map((s) => s.text)).toEqual(['hello']);
    });

    it('is a no-op when no resolveTelemetryContext is wired (default constructor)', () => {
      controller.sendUserMessage('hi');
      expect(trackChatSend).not.toHaveBeenCalled();
    });
  });

  it('streams an assistant message through start → delta → done', async () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    const streamingEl = thread.querySelector('slicc-agent-message');
    expect(streamingEl?.hasAttribute('streaming')).toBe(true);
    expect(controller.processing).toBe(true);

    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'Hello ' });
    agent.emit({ type: 'content_delta', messageId: 'm1', text: '**world**' });
    await nextFrame();
    const mid = thread.querySelector('slicc-agent-message');
    expect(mid?.textContent).toContain('Hello');
    expect(mid?.querySelector('strong')?.textContent).toBe('world');

    agent.emit({ type: 'content_done', messageId: 'm1' });
    agent.emit({ type: 'turn_end', messageId: 'm1' });
    const finalEl = thread.querySelector('slicc-agent-message');
    expect(finalEl?.hasAttribute('streaming')).toBe(false);
    expect(controller.processing).toBe(false);
    expect(processingStates).toEqual([true, false]);
  });

  it('retains final model and usage metadata on a live assistant message', () => {
    const usage = {
      input: 12,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
    };
    agent.emit({ type: 'message_start', messageId: 'm-cost' });
    agent.emit({
      type: 'content_done',
      messageId: 'm-cost',
      model: 'claude-haiku-4-5',
      usage,
    });

    expect(controller.getMessages().at(-1)).toMatchObject({
      id: 'm-cost',
      model: 'claude-haiku-4-5',
      usage,
    });
  });

  it('folds un-flushed deltas into the final render on content_done', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'tail text' });

    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.querySelector('slicc-agent-message')?.textContent).toContain('tail text');
  });

  it('renders tool calls as action rows and resolves their results', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'ls -la' });
    let row = thread.querySelector('slicc-action-row');

    expect(row?.getAttribute('label')).toBe("Use Sliccy's computer");
    expect(row?.getAttribute('icon')).toBe('folder-open');
    expect(row?.getAttribute('result')).toBe('…');

    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'total 42' });
    row = thread.querySelector('slicc-action-row');
    expect(row?.getAttribute('result')).toBe('done');
    expect(row?.textContent).toContain('total 42');

    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'boom',
      isError: true,
    });

    expect(thread.querySelectorAll('slicc-action-row').length).toBe(1);
  });

  it('marks errored tool calls', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'rm /' });
    agent.emit({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'denied',
      isError: true,
    });
    expect(thread.querySelector('slicc-action-row')?.getAttribute('result')).toBe('error');
  });

  it('drives the busy phase to tool while a call runs and back to thinking on its result', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });

    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'ls' });
    expect(busyPhases).toEqual(['tool']);
    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'ok' });
    expect(busyPhases).toEqual(['tool', 'thinking']);
  });

  it('holds the tool phase until every concurrent call resolves', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'a' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'read_file', toolInput: 'b' });
    expect(busyPhases).toEqual(['tool']);

    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'done' });
    expect(busyPhases).toEqual(['tool']);

    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'read_file', result: 'data' });
    expect(busyPhases).toEqual(['tool', 'thinking']);
  });

  it('resets to thinking on the next turn after one ends mid-tool', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'sleep' });
    expect(busyPhases).toEqual(['tool']);

    controller.setProcessing(false);

    agent.emit({ type: 'message_start', messageId: 'm2' });
    expect(busyPhases).toEqual(['tool', 'thinking']);
  });

  it('renders agent errors as a slicc-error-card and clears processing', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'error', error: 'rate limited' });
    expect(controller.processing).toBe(false);
    const card = thread.querySelector('slicc-error-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('message')).toBe('rate limited');
  });

  describe('lick backpressure notice', () => {
    function makeBackpressureController() {
      const queuedChanges: Array<readonly { id: string; text: string }[]> = [];
      const noticeChanges: Array<{ text: string } | null> = [];
      const states: boolean[] = [];
      const ctl = new WcChatController({
        thread,
        agent: new FakeAgent(),
        onProcessingChange: (processing) => states.push(processing),
        onQueuedChange: (items) => queuedChanges.push(items.slice()),
        onLickBackpressureChange: (notice) => noticeChanges.push(notice),
      });
      ctl.setProcessing(true);
      states.length = 0;
      return { ctl, queuedChanges, noticeChanges, states };
    }

    it('shows a non-error notice without changing processing or exposing an error card', () => {
      const { ctl, queuedChanges, noticeChanges, states } = makeBackpressureController();
      ctl.setLickBackpressure(3, 300_000, 'cone');

      expect(queuedChanges).toEqual([]);
      expect(noticeChanges.at(-1)?.text).toBe('3 events waiting for the current turn');
      expect(ctl.processing).toBe(true);
      expect(states).toEqual([]);
      expect(thread.querySelector('slicc-error-card')).toBeNull();
      expect(trackError).not.toHaveBeenCalled();
      expect(trackLickBackpressure).toHaveBeenCalledWith('cone', 300_000);
    });

    it('retracts the notice on count zero', () => {
      const { ctl, noticeChanges } = makeBackpressureController();
      ctl.setLickBackpressure(2, 300_000, 'cone');
      ctl.setLickBackpressure(0, 0, 'cone');
      expect(noticeChanges.at(-1)).toBeNull();
      expect(trackLickBackpressure).toHaveBeenCalledTimes(1);
    });

    it('retracts the notice when the current turn completes', () => {
      const { ctl, noticeChanges } = makeBackpressureController();
      ctl.setLickBackpressure(1, 300_000, 'researcher');
      ctl.setProcessing(false);
      expect(noticeChanges.at(-1)).toBeNull();
    });

    it('keeps the notice out of the queued badge total', () => {
      const badge = document.createElement('span');
      const noticeChip = document.createElement('div');
      const ctl = new WcChatController({
        thread,
        agent: new FakeAgent(),
        onQueuedChange: (items) => {
          badge.textContent = items.length > 0 ? `${items.length} queued` : '';
        },
        onLickBackpressureChange: (notice) => {
          noticeChip.textContent = notice?.text ?? '';
        },
      });
      ctl.setProcessing(true);
      ctl.setLickBackpressure(3, 300_000, 'cone');

      expect(noticeChip.textContent).toBe('3 events waiting for the current turn');
      expect(badge.textContent).toBe('');
      expect(noticeChip.textContent).not.toContain('1 queued');

      ctl.sendUserMessage('one real queued submission');
      expect(badge.textContent).toBe('1 queued');
      expect(noticeChip.textContent).toBe('3 events waiting for the current turn');
    });
  });

  describe('no-handler error-card RUM beacon (trackError)', () => {
    it('fires once with source=error-card for a generic error', () => {
      agent.emit({ type: 'error', error: 'rate limited' });
      expect(trackError).toHaveBeenCalledTimes(1);
      expect(trackError).toHaveBeenCalledWith('error-card', 'rate limited');
    });

    it('coerces object/Error details onto the card and still beacons (#3035)', () => {
      agent.emit({
        type: 'error',
        error: { message: 'bedrock returned 400' },
      } as unknown as AgentEvent);
      const card = thread.querySelector('slicc-error-card');
      expect(card?.getAttribute('message')).toBe('bedrock returned 400');
      expect(card?.getAttribute('message')).not.toBe('[object Object]');
      expect(trackError).toHaveBeenCalledWith('error-card', { message: 'bedrock returned 400' });

      vi.mocked(trackError).mockClear();
      agent.emit({ type: 'error', error: new TypeError('cannot read x') } as unknown as AgentEvent);
      const cards = thread.querySelectorAll('slicc-error-card');
      expect(cards[cards.length - 1]?.getAttribute('message')).toBe('TypeError: cannot read x');
      expect(trackError).toHaveBeenCalledWith('error-card', expect.any(TypeError));
    });

    it('keeps a quota envelope string so the card can detect the family', () => {
      agent.emit({
        type: 'error',
        error:
          '429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used. Resets on 2026-09-14.","resets_at":"2026-09-14T00:00:00.000Z"}}',
      });
      const card = thread.querySelector('slicc-error-card');
      expect(card?.getAttribute('label')).toBe('Out of AI budget');
      expect(card?.getAttribute('action')).toBe('settings');
      expect(trackError).not.toHaveBeenCalled();
    });

    it('does NOT fire for a no-api-key error (dedicated handler)', () => {
      agent.emit({ type: 'error', error: 'No API key configured for Anthropic' });
      expect(trackError).not.toHaveBeenCalled();
    });

    it('does NOT fire for an invalid-model error (dedicated handler)', () => {
      agent.emit({ type: 'error', error: 'The provided model identifier is invalid' });
      expect(trackError).not.toHaveBeenCalled();
    });

    it('does NOT fire for an auth-expired error (dedicated handler)', () => {
      agent.emit({
        type: 'error',
        error: 'Scoop cone failed with unrecoverable error: session expired, please log in again',
      });
      expect(trackError).not.toHaveBeenCalled();
    });

    it('still renders the error card when the beacon throws', () => {
      vi.mocked(trackError).mockImplementationOnce(() => {
        throw new Error('telemetry blew up');
      });
      expect(() => agent.emit({ type: 'error', error: 'rate limited' })).not.toThrow();
      expect(thread.querySelector('slicc-error-card')).not.toBeNull();
    });
  });

  it('retries the failed turn through the agent send path on slicc-error-retry', () => {
    controller.sendUserMessage('hello world');
    agent.sent.length = 0;
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    expect(errorId).not.toBeNull();
    card?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: errorId },
        bubbles: true,
        composed: true,
      })
    );
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('hello world');

    expect(thread.querySelectorAll('slicc-user-message')).toHaveLength(1);
  });

  it('binds retry to the failed turn even when a newer prompt was queued', () => {
    controller.sendUserMessage('prompt A');
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    expect(errorId).not.toBeNull();

    controller.sendUserMessage('prompt B (newer)');
    agent.sent.length = 0;
    card?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: errorId },
        bubbles: true,
        composed: true,
      })
    );
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('prompt A');
  });

  it('does nothing on retry while a turn is already in flight', () => {
    controller.sendUserMessage('hi');
    agent.sent.length = 0;
    agent.emit({ type: 'message_start', messageId: 'm1' });

    expect(controller.processing).toBe(true);
    thread.dispatchEvent(new CustomEvent('slicc-error-retry', { bubbles: true, composed: true }));
    expect(agent.sent).toHaveLength(0);
  });

  it('replays an immediately-preceding lick (welcome-lick onboarding case)', () => {
    controller.addLickMessage('l1', '[Welcome] hello', 'webhook', Date.now());
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    card?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: errorId },
        bubbles: true,
        composed: true,
      })
    );
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('[Welcome] hello');
  });

  it('replays the lick immediately before the error even when an older user turn exists', () => {
    controller.sendUserMessage('first');
    controller.addLickMessage('l1', '[Webhook Event: x]', 'webhook', Date.now());
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    card?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: errorId },
        bubbles: true,
        composed: true,
      })
    );
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('[Webhook Event: x]');
  });

  it('falls back to the last user turn when no lick sits directly above the error', () => {
    controller.addLickMessage('l1', '[Webhook Event: x]', 'webhook', Date.now());
    controller.sendUserMessage('after the lick');
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    card?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: errorId },
        bubbles: true,
        composed: true,
      })
    );
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('after the lick');
  });

  it('skips a lick that arrived mid-turn when scanning for the failed originator', () => {
    controller.sendUserMessage('prompt A');
    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(controller.processing).toBe(true);
    controller.addLickMessage('l1', '[Webhook Event: deploy]', 'webhook', Date.now());
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    card?.dispatchEvent(
      new CustomEvent('slicc-error-retry', {
        detail: { messageId: errorId },
        bubbles: true,
        composed: true,
      })
    );
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('prompt A');
  });

  it('falls back to the legacy whole-thread scan when detail.messageId is absent', () => {
    controller.sendUserMessage('hello world');
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });

    thread.dispatchEvent(new CustomEvent('slicc-error-retry', { bubbles: true, composed: true }));
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0].text).toBe('hello world');
  });

  it('no-ops a retry when there is no prior user turn', () => {
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    card?.dispatchEvent(new CustomEvent('slicc-error-retry', { bubbles: true, composed: true }));
    expect(agent.sent).toHaveLength(0);
  });

  it('stops listening for retry after dispose', () => {
    controller.sendUserMessage('hi');
    agent.sent.length = 0;
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    controller.dispose();
    card?.dispatchEvent(new CustomEvent('slicc-error-retry', { bubbles: true, composed: true }));
    expect(agent.sent).toHaveLength(0);
  });

  it('replaces history wholesale on loadMessages', () => {
    controller.sendUserMessage('old');
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'restored prompt', timestamp: 1700000000000 },
      { id: 'h2', role: 'assistant', content: 'restored reply', timestamp: 1700000001000 },
    ]);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(1);
    expect(thread.querySelectorAll('slicc-agent-message').length).toBe(1);
    expect(thread.querySelector('slicc-day-separator')).toBeTruthy();
  });

  it('renders licks as lick cards', () => {
    controller.addLickMessage('l1', '[Webhook Event: deploy]\npayload', 'webhook', Date.now());
    const card = thread.querySelector('slicc-lick-card');
    expect(card?.getAttribute('kind')).toBe('webhook');
    expect(card?.getAttribute('event-label')).toBe('deploy');
  });

  it('collates consecutive same-channel licks into one counted card', () => {
    controller.addLickMessage('l1', '[Session Reload] one', 'session-reload', Date.now());
    controller.addLickMessage('l2', '[Session Reload] two', 'session-reload', Date.now());
    const cards = thread.querySelectorAll('slicc-lick-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('count')).toBe('2');

    controller.addLickMessage('l3', '[Cron Event: tick]', 'cron', Date.now());
    expect(thread.querySelectorAll('slicc-lick-card')).toHaveLength(2);
  });

  it('collates lick runs arriving through loadMessages too', () => {
    controller.loadMessages([
      {
        id: 'a',
        role: 'user',
        content: 'r1',
        timestamp: 1,
        source: 'lick',
        channel: 'session-reload',
      },
      {
        id: 'b',
        role: 'user',
        content: 'r2',
        timestamp: 2,
        source: 'lick',
        channel: 'session-reload',
      },
    ]);
    const cards = thread.querySelectorAll('slicc-lick-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('count')).toBe('2');
  });

  it('carries an actionable lick id and starts pending, then flips state live', () => {
    controller.addLickMessage(
      'sudo-request-lick-1',
      '[@alpha-scoop sudo-request]\nKind: command\nDetail: git push',
      'sudo-request',
      Date.now(),
      'lick-1'
    );
    const card = thread.querySelector('slicc-lick-card');
    expect(card?.getAttribute('kind')).toBe('sudo-request');

    expect(card?.hasAttribute('state')).toBe(false);

    controller.updateLickState('lick-1', 'confirmed');
    expect(thread.querySelectorAll('slicc-lick-card')).toHaveLength(1);
    expect(thread.querySelector('slicc-lick-card')?.getAttribute('state')).toBe('confirmed');
  });

  it('never collates actionable licks — each same-channel card stands alone and flips', () => {
    controller.addLickMessage(
      'sudo-request-lick-a',
      '[@alpha-scoop sudo-request]\nKind: command\nDetail: git push',
      'sudo-request',
      Date.now(),
      'lick-a'
    );
    controller.addLickMessage(
      'sudo-request-lick-b',
      '[@alpha-scoop sudo-request]\nKind: command\nDetail: rm -rf /tmp/x',
      'sudo-request',
      Date.now(),
      'lick-b'
    );
    const cards = thread.querySelectorAll('slicc-lick-card');
    expect(cards).toHaveLength(2);
    expect([...cards].every((c) => !c.hasAttribute('count'))).toBe(true);

    controller.updateLickState('lick-a', 'confirmed');
    const after = thread.querySelectorAll('slicc-lick-card');
    expect(after).toHaveLength(2);
    expect(after[0].getAttribute('state')).toBe('confirmed');
    expect(after[1].hasAttribute('state')).toBe(false);
    controller.updateLickState('lick-b', 'dismissed');
    expect(thread.querySelectorAll('slicc-lick-card')[1].getAttribute('state')).toBe('dismissed');
  });

  it('updateLickState dismisses an actionable lick and no-ops unknown ids', () => {
    controller.addLickMessage(
      'sudo-request-lick-2',
      '[@beta-scoop sudo-request]\nKind: write\nDetail: /etc/hosts',
      'sudo-request',
      Date.now(),
      'lick-2'
    );
    controller.updateLickState('lick-2', 'dismissed');
    expect(thread.querySelector('slicc-lick-card')?.getAttribute('state')).toBe('dismissed');

    controller.updateLickState('does-not-exist', 'confirmed');
    expect(thread.querySelector('slicc-lick-card')?.getAttribute('state')).toBe('dismissed');
  });

  it('routes busy-submit prompts to the queued stack and skips the inline bubble', () => {
    const queuedChanges: Array<readonly { id: string; text: string; attachments?: number }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    const bubblesBefore = thread.querySelectorAll('slicc-user-message').length;
    localController.sendUserMessage('queued one');

    expect(agent.sent.at(-1)?.text).toBe('queued one');
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(bubblesBefore);
    expect(thread.querySelector('slicc-user-message[queued]')).toBeNull();

    expect(queuedChanges.length).toBe(1);
    expect(queuedChanges[0]).toHaveLength(1);
    expect(queuedChanges[0][0].text).toBe('queued one');
    expect(localController.getQueuedMessages()).toHaveLength(1);
  });

  it('forwards a steering submit straight into the thread instead of the queued stack', () => {
    const queuedChanges: Array<readonly { id: string }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    const bubblesBefore = thread.querySelectorAll('slicc-user-message').length;
    localController.sendUserMessage('steer me', undefined, { steer: true });

    expect(agent.sent.at(-1)).toMatchObject({ text: 'steer me', steer: true });

    expect(thread.querySelectorAll('slicc-user-message').length).toBe(bubblesBefore + 1);
    expect(localController.getQueuedMessages()).toHaveLength(0);
    expect(queuedChanges).toHaveLength(0);
  });

  it('flushes queued submissions into the thread at the next turn start', () => {
    const queuedChanges: Array<readonly { id: string }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });

    agent.emit({ type: 'message_start', messageId: 'm1' });
    localController.sendUserMessage('first queued');
    localController.sendUserMessage('second queued');
    agent.emit({ type: 'turn_end', messageId: 'm1' });
    expect(localController.getQueuedMessages()).toHaveLength(2);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);

    agent.emit({ type: 'message_start', messageId: 'm2' });
    const userBubbles = thread.querySelectorAll('slicc-user-message');
    expect(userBubbles).toHaveLength(2);
    expect(userBubbles[0].shadowRoot?.textContent).toContain('first queued');
    expect(userBubbles[1].shadowRoot?.textContent).toContain('second queued');
    expect([...userBubbles].some((b) => b.hasAttribute('queued'))).toBe(false);

    expect(localController.getQueuedMessages()).toHaveLength(0);
    expect(queuedChanges.at(-1)).toHaveLength(0);
  });

  it('flushes queued submissions when scoop status drives the rising edge BEFORE message_start (live ordering)', () => {
    const queuedChanges: Array<readonly { id: string }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });

    agent.emit({ type: 'message_start', messageId: 'm1' });
    localController.sendUserMessage('first queued');
    localController.sendUserMessage('second queued');
    agent.emit({ type: 'turn_end', messageId: 'm1' });
    expect(localController.getQueuedMessages()).toHaveLength(2);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);
    queuedChanges.length = 0;

    localController.setProcessing(true);
    const flushed = thread.querySelectorAll('slicc-user-message');
    expect(flushed).toHaveLength(2);
    expect(flushed[0].shadowRoot?.textContent).toContain('first queued');
    expect(flushed[1].shadowRoot?.textContent).toContain('second queued');
    expect([...flushed].some((b) => b.hasAttribute('queued'))).toBe(false);
    expect(localController.getQueuedMessages()).toHaveLength(0);
    expect(queuedChanges.at(-1)).toHaveLength(0);

    agent.emit({ type: 'message_start', messageId: 'm2' });
    expect(thread.querySelectorAll('slicc-user-message')).toHaveLength(2);
  });

  it('does not re-flush queued items on mid-turn second message_start (multi-message turn)', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    controller.sendUserMessage('queued mid-turn');
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);

    agent.emit({ type: 'message_start', messageId: 'm1b' });
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);
    expect(controller.getQueuedMessages()).toHaveLength(1);
  });

  it('removeQueuedMessage drops the item locally and re-fires onQueuedChange', () => {
    const queuedChanges: Array<readonly { id: string }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    localController.sendUserMessage('keep me');
    localController.sendUserMessage('drop me');
    const view = localController.getQueuedMessages();
    expect(view).toHaveLength(2);
    const dropId = view[1].id;
    queuedChanges.length = 0;
    localController.removeQueuedMessage(dropId);
    expect(localController.getQueuedMessages().map((m) => m.text)).toEqual(['keep me']);
    expect(queuedChanges.at(-1)).toHaveLength(1);

    queuedChanges.length = 0;
    localController.removeQueuedMessage('does-not-exist');
    expect(queuedChanges).toHaveLength(0);
  });

  it('loadMessages cancels every dropped queued id on the backend via onQueuedCancel', () => {
    const cancelled: string[] = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedCancel: (id) => cancelled.push(id),
    });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    localController.sendUserMessage('queued one');
    localController.sendUserMessage('queued two');
    const ids = localController.getQueuedMessages().map((m) => m.id);
    expect(ids).toHaveLength(2);

    localController.loadMessages([]);
    expect(cancelled).toEqual(ids);
    expect(localController.getQueuedMessages()).toHaveLength(0);
  });

  it('loadMessages does not fire onQueuedCancel when the queue is already empty', () => {
    const cancelled: string[] = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedCancel: (id) => cancelled.push(id),
    });
    localController.loadMessages([{ id: 'h1', role: 'user', content: 'historical', timestamp: 1 }]);
    expect(cancelled).toEqual([]);
  });

  it('loadMessages still clears #queued and notifies the host even when onQueuedCancel throws', () => {
    const queuedChanges: Array<readonly { id: string }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
      onQueuedCancel: () => {
        throw new Error('host blew up');
      },
    });
    agent.emit({ type: 'message_start', messageId: 'm1' });
    localController.sendUserMessage('queued one');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      localController.loadMessages([]);
    } finally {
      errSpy.mockRestore();
    }
    expect(localController.getQueuedMessages()).toHaveLength(0);
    expect(queuedChanges.at(-1)).toHaveLength(0);
  });

  it('idle submits append a plain user bubble (no stack routing)', () => {
    const queuedChanges: number[] = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.length),
    });
    localController.sendUserMessage('idle prompt');
    expect(thread.querySelectorAll('slicc-user-message')).toHaveLength(1);
    expect(thread.querySelector('slicc-user-message[queued]')).toBeNull();
    expect(localController.getQueuedMessages()).toHaveLength(0);
    expect(queuedChanges).toEqual([]);
  });

  it('stops listening after dispose', () => {
    controller.dispose();
    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(thread.querySelector('slicc-agent-message')).toBeNull();
  });

  it('ignores events for unknown message ids', () => {
    agent.emit({ type: 'content_delta', messageId: 'nope', text: 'x' });
    agent.emit({ type: 'content_done', messageId: 'nope' });
    agent.emit({ type: 'tool_use_start', messageId: 'nope', toolName: 'bash', toolInput: '' });
    expect(thread.querySelectorAll('slicc-agent-message, slicc-action-row').length).toBe(0);
  });

  it('exposes external processing overrides without duplicate notifications', () => {
    controller.setProcessing(true);
    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(processingStates).toEqual([true, false]);
  });

  describe('setOnLocalProcessingChange (leader status-broadcast hook)', () => {
    it('fires once per real processing transition, mirroring onProcessingChange', () => {
      const broadcasts: boolean[] = [];
      controller.setOnLocalProcessingChange((p) => broadcasts.push(p));
      controller.setProcessing(true);
      controller.setProcessing(true);
      controller.setProcessing(false);

      expect(broadcasts).toEqual([true, false]);
      expect(processingStates).toEqual([true, false]);
    });

    it('detaches when set to undefined', () => {
      const broadcasts: boolean[] = [];
      controller.setOnLocalProcessingChange((p) => broadcasts.push(p));
      controller.setProcessing(true);
      controller.setOnLocalProcessingChange(undefined);
      controller.setProcessing(false);
      expect(broadcasts).toEqual([true]);
    });

    it('swallows a throwing hook without disturbing local processing state', () => {
      const localStates: boolean[] = [];
      const local = new WcChatController({
        thread,
        agent,
        onProcessingChange: (p) => localStates.push(p),
      });
      local.setOnLocalProcessingChange(() => {
        throw new Error('broadcast channel dead');
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        local.setProcessing(true);
        local.setProcessing(false);
      } finally {
        errSpy.mockRestore();
      }

      expect(localStates).toEqual([true, false]);
    });

    it('mirrors the leader turn lifecycle to a follower so its spinner clears and queue flushes (F1+F2)', () => {
      const followerThread = document.createElement('slicc-chat-thread');
      document.body.appendChild(followerThread);
      const followerSpinner: boolean[] = [];
      const follower = new WcChatController({
        thread: followerThread,
        agent: new FakeAgent(),
        onProcessingChange: (p) => followerSpinner.push(p),
      });

      const leaderThread = document.createElement('slicc-chat-thread');
      document.body.appendChild(leaderThread);
      const leader = new WcChatController({ thread: leaderThread, agent: new FakeAgent() });
      leader.setOnLocalProcessingChange((p) => follower.setProcessing(p));

      leader.setProcessing(true);
      follower.sendUserMessage('queued while busy');
      expect(follower.getQueuedMessages()).toHaveLength(1);
      expect(followerThread.querySelectorAll('slicc-user-message')).toHaveLength(0);

      leader.setProcessing(false);
      expect(followerSpinner).toEqual([true, false]);

      expect(follower.getQueuedMessages()).toHaveLength(1);

      leader.setProcessing(true);
      expect(follower.getQueuedMessages()).toHaveLength(0);
      const bubbles = followerThread.querySelectorAll('slicc-user-message');
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0].hasAttribute('queued')).toBe(false);
    });
  });

  describe('stale-asset dropped-turn auto-resubmit (#1330 follow-on)', () => {
    const REPLAY_KEY = 'slicc:stale-asset-replay';
    beforeEach(() => {
      window.sessionStorage.removeItem(REPLAY_KEY);

      thread.setAttribute('context', 'cone');
    });
    afterEach(() => window.sessionStorage.removeItem(REPLAY_KEY));

    it('replays the dropped cone turn once when the flag is set and the thread ends in an unanswered user turn', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');
      controller.loadMessages([
        { id: 'u1', role: 'user', content: 'dropped prompt', timestamp: 1 },
      ]);
      expect(agent.sent).toHaveLength(1);
      expect(agent.sent[0].text).toBe('dropped prompt');

      expect(thread.querySelectorAll('slicc-user-message')).toHaveLength(1);
    });

    it('does NOT resend when the last message is an assistant reply (turn completed)', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');
      controller.loadMessages([
        { id: 'u1', role: 'user', content: 'answered', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'the reply', timestamp: 2 },
      ]);
      expect(agent.sent).toHaveLength(0);
    });

    it('does NOT resend when the flag is not set (ordinary scoop switch / reconnect)', () => {
      controller.loadMessages([
        { id: 'u1', role: 'user', content: 'dropped prompt', timestamp: 1 },
      ]);
      expect(agent.sent).toHaveLength(0);
    });

    it('does NOT resend while a turn is already running, but still consumes the flag', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');
      controller.setProcessing(true);
      controller.loadMessages([
        { id: 'u1', role: 'user', content: 'dropped prompt', timestamp: 1 },
      ]);
      expect(agent.sent).toHaveLength(0);

      expect(window.sessionStorage.getItem(REPLAY_KEY)).toBeNull();
    });

    it('does NOT resend when the last message is a lick-originated user turn', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');
      controller.loadMessages([
        {
          id: 'l1',
          role: 'user',
          content: '[Webhook Event: x]',
          timestamp: 1,
          source: 'lick',
          channel: 'webhook',
        },
      ]);
      expect(agent.sent).toHaveLength(0);
    });

    it('consume-once: two loadMessages calls resend only the first (scoop switches do not re-replay)', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');
      controller.loadMessages([{ id: 'u1', role: 'user', content: 'first', timestamp: 1 }]);
      expect(agent.sent).toHaveLength(1);
      expect(agent.sent[0].text).toBe('first');
      controller.loadMessages([{ id: 'u2', role: 'user', content: 'second', timestamp: 2 }]);

      expect(agent.sent).toHaveLength(1);
    });

    it('does NOT resend or consume the flag on a non-cone (scoop) load; the later cone load replays', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');

      thread.setAttribute('context', 'scoop:worker');
      controller.loadMessages([
        { id: 's1', role: 'user', content: 'delegated prompt', timestamp: 1 },
      ]);
      expect(agent.sent).toHaveLength(0);

      expect(window.sessionStorage.getItem(REPLAY_KEY)).toBe('1');

      thread.setAttribute('context', 'cone');
      controller.loadMessages([
        { id: 'u1', role: 'user', content: 'dropped cone prompt', timestamp: 2 },
      ]);
      expect(agent.sent).toHaveLength(1);
      expect(agent.sent[0].text).toBe('dropped cone prompt');
    });

    it('does NOT consume the flag on a transient empty cone load; the next real snapshot replays', () => {
      window.sessionStorage.setItem(REPLAY_KEY, '1');

      controller.loadMessages([]);
      expect(agent.sent).toHaveLength(0);
      expect(window.sessionStorage.getItem(REPLAY_KEY)).toBe('1');

      controller.loadMessages([
        { id: 'u1', role: 'user', content: 'dropped prompt', timestamp: 1 },
      ]);
      expect(agent.sent).toHaveLength(1);
      expect(agent.sent[0].text).toBe('dropped prompt');
    });
  });
});

describe('WcChatController render/dispose lifecycle hooks', () => {
  function makeTracked() {
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const rendered: string[] = [];
    const disposed: string[] = [];
    const controller = new WcChatController({
      thread,
      agent,
      onMessageRendered: (message) => rendered.push(message.id),
      onMessageDisposed: (messageId) => disposed.push(messageId),
    });
    return { thread, agent, controller, rendered, disposed };
  }

  it('fires rendered immediately for non-streaming appends', () => {
    const { controller, rendered } = makeTracked();
    controller.sendUserMessage('hello');
    controller.addLickMessage('l1', '[Webhook Event: x]', 'webhook', Date.now());
    expect(rendered).toHaveLength(2);
  });

  it('defers rendered until a streaming message finalizes', () => {
    const { agent, rendered, disposed } = makeTracked();
    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(rendered).toEqual([]);
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'x' });
    expect(rendered).toEqual([]);
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(rendered).toEqual(['m1']);

    expect(disposed).toEqual(['m1']);
  });

  it('re-fires rendered (after disposed) for post-stream tool results', () => {
    const { agent, rendered, disposed } = makeTracked();
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'ls' });
    agent.emit({ type: 'tool_result', messageId: 'm1', toolName: 'bash', result: 'ok' });
    expect(rendered).toEqual(['m1', 'm1', 'm1']);
    expect(disposed).toEqual(['m1', 'm1', 'm1']);
  });

  it('disposes everything on loadMessages and renders the new history', () => {
    const { controller, rendered, disposed } = makeTracked();
    controller.sendUserMessage('old');
    rendered.length = 0;
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'a', timestamp: 1 },
      { id: 'h2', role: 'assistant', content: 'b', timestamp: 2 },
    ]);
    expect(disposed.length).toBeGreaterThan(0);
    expect(rendered).toEqual(['h1', 'h2']);
  });

  it('tracks loaded messages so post-load streaming updates replace in place', () => {
    const { thread, agent, controller } = makeTracked();
    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'a', timestamp: 1 },
      { id: 'm1', role: 'assistant', content: 'partial', timestamp: 2, isStreaming: true },
    ]);
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
    expect(thread.querySelector('slicc-agent-message')?.hasAttribute('streaming')).toBe(false);
  });

  it('resumes a streaming tail after loadMessages: deltas extend it, content_done flushes', async () => {
    const { thread, agent, controller } = makeTracked();
    controller.loadMessages([
      { id: 'm1', role: 'assistant', content: 'before', timestamp: 2, isStreaming: true },
    ]);
    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' mid' });
    await nextFrame();
    expect(thread.querySelector('slicc-agent-message')?.textContent).toContain('before mid');

    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' end' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    const el = thread.querySelector('slicc-agent-message');
    expect(el?.textContent).toContain('before mid end');
    expect(el?.hasAttribute('streaming')).toBe(false);
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
  });

  it('resumes a streaming message even when a queued user message follows it', async () => {
    const { thread, agent, controller } = makeTracked();
    controller.loadMessages([
      { id: 'm1', role: 'assistant', content: 'before', timestamp: 2, isStreaming: true },
      { id: 'q1', role: 'user', content: 'queued', timestamp: 3 },
    ]);
    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' more' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    await nextFrame();
    const streamed = thread.querySelector('slicc-agent-message');
    expect(streamed?.textContent).toContain('before more');
    expect(streamed?.hasAttribute('streaming')).toBe(false);
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
  });
});

describe('WcChatController scroll pinning', () => {
  it('scrolls the thread to the bottom on append', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const setter = vi.fn();
    Object.defineProperty(thread, 'scrollHeight', { value: 1234 });
    Object.defineProperty(thread, 'scrollTop', { set: setter, get: () => 0 });
    const controller = new WcChatController({ thread, agent: new FakeAgent() });
    controller.sendUserMessage('scroll me');
    expect(setter).toHaveBeenCalledWith(1234);
  });

  it('agent-driven appends use the thread polite follow, user sends hard-scroll', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread') as unknown as HTMLElement & {
      requestFollow: ReturnType<typeof vi.fn>;
    };
    thread.requestFollow = vi.fn();
    document.body.appendChild(thread);
    const scrollSetter = vi.fn();
    Object.defineProperty(thread, 'scrollHeight', { value: 1234 });
    Object.defineProperty(thread, 'scrollTop', { set: scrollSetter, get: () => 0 });
    const agent = new FakeAgent();
    new WcChatController({ thread, agent });

    agent.emit({ type: 'message_start', messageId: 'm1' });
    expect(thread.requestFollow).toHaveBeenCalled();
    expect(scrollSetter).not.toHaveBeenCalled();

    const callsAfterStart = thread.requestFollow.mock.calls.length;
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'hi' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.requestFollow.mock.calls.length).toBeGreaterThan(callsAfterStart);
    expect(scrollSetter).not.toHaveBeenCalled();
  });
});

describe('WcChatController render-failure degradation', () => {
  it('degrades a message whose renderer throws to a plain bubble', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new WcChatController({ thread, agent: new FakeAgent() });

    controller.loadMessages([
      { id: 'h1', role: 'user', content: 'fine', timestamp: 1 },
      {
        id: 'h2',
        role: 'assistant',
        content: { broken: true } as unknown as string,
        timestamp: 2,
        toolCalls: { not: 'an array' } as never,
      },
      { id: 'h3', role: 'assistant', content: 'also fine', timestamp: 3 },
    ]);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('message render failed'),
      expect.anything()
    );
    expect(thread.querySelector('slicc-user-message')).toBeTruthy();
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(2);
    errSpy.mockRestore();
  });

  it('fires onTurnComplete with the final assistant message (the spoken-reply hook)', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const completed: Array<{ content: string; isStreaming?: boolean } | null> = [];
    const controller = new WcChatController({
      thread,
      agent,
      onTurnComplete: (message) => completed.push(message),
    });

    agent.emit({ type: 'message_start', messageId: 'm9' });
    agent.emit({ type: 'content_delta', messageId: 'm9', text: 'spoken reply' });
    agent.emit({ type: 'content_done', messageId: 'm9' });
    await nextFrame();
    agent.emit({ type: 'turn_end', messageId: 'm9' });

    expect(completed).toHaveLength(1);
    expect(completed[0]?.content).toBe('spoken reply');
    expect(completed[0]?.isStreaming).toBe(false);

    agent.emit({ type: 'message_start', messageId: 'm10' });
    agent.emit({ type: 'content_delta', messageId: 'm10', text: 'live reply' });
    agent.emit({ type: 'content_done', messageId: 'm10' });
    await nextFrame();
    controller.setProcessing(false);
    expect(completed[1]?.content).toBe('live reply');

    controller.setProcessing(false);
    expect(completed).toHaveLength(2);
  });

  it('onTurnComplete is scoped to the turn — no stale reply, no historical fallback', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const completed: Array<{ content: string } | null> = [];
    const controller = new WcChatController({
      thread,
      agent,
      onTurnComplete: (message) => completed.push(message as { content: string } | null),
    });

    agent.emit({ type: 'message_start', messageId: 't1' });
    agent.emit({ type: 'content_delta', messageId: 't1', text: 'earlier answer' });
    agent.emit({ type: 'content_done', messageId: 't1' });
    await nextFrame();
    agent.emit({ type: 'turn_end', messageId: 't1' });
    expect(completed[0]?.content).toBe('earlier answer');

    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(completed[1]).toBeNull();

    agent.emit({ type: 'message_start', messageId: 't3' });
    agent.emit({ type: 'error', error: 'rate limited' });
    expect(completed[2]?.content).toBe('');
  });

  it('onTurnComplete reports null when no assistant message exists at all', async () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const completed: Array<unknown | null> = [];
    const controller = new WcChatController({
      thread,
      agent,
      onTurnComplete: (message) => completed.push(message),
    });

    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(completed).toEqual([null]);
  });
});

describe('WcChatController readOnlyToolUi (tray follower tool_ui rendering)', () => {
  const MOUNT_APPROVAL_HTML = `
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">
        <div class="sprinkle-action-card__title-group">Mount local directory<div class="sprinkle-action-card__meta">Target: /workspace/mnt/docs</div></div>
        <span class="sprinkle-badge sprinkle-badge--notice">approval</span>
      </div>
      <div class="sprinkle-action-card__actions">
        <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
        <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="directory">Select directory</button>
      </div>
    </div>
  `;

  it('renders the interactive card with live buttons when readOnlyToolUi is unset (leader/standalone)', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const controller = new WcChatController({ thread, agent });

    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'bash',
      requestId: 'req-1',
      html: MOUNT_APPROVAL_HTML,
    });

    const iframe = thread.querySelector<HTMLIFrameElement>('[data-tool-ui-request="req-1"] iframe');
    expect(iframe?.srcdoc).toContain('data-action="approve"');
    expect(iframe?.srcdoc).toContain('Select directory');
  });

  it('renders a static, non-interactive "waiting on the leader" placeholder when readOnlyToolUi is set', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const onToolUiAction = vi.fn();
    const controller = new WcChatController({
      thread,
      agent,
      onToolUiAction,
      readOnlyToolUi: true,
    });

    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'bash',
      requestId: 'req-1',
      html: MOUNT_APPROVAL_HTML,
    });

    const container = thread.querySelector<HTMLElement>('[data-tool-ui-request="req-1"]');
    const iframe = container?.querySelector('iframe');
    expect(iframe?.srcdoc).toContain('Mount local directory');
    expect(iframe?.srcdoc).toContain('Waiting for approval on the leader');

    expect(iframe?.srcdoc).not.toContain('data-action="approve"');
    expect(iframe?.srcdoc).not.toContain('data-action="deny"');

    expect(iframe?.srcdoc).not.toContain('/workspace/mnt/docs');
    expect(iframe?.srcdoc).not.toContain('Mount local directoryTarget:');
    expect(onToolUiAction).not.toHaveBeenCalled();
  });

  it('disposes the placeholder on tool_ui_done, same as the interactive card', () => {
    installWcDomStubs();
    const thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    const agent = new FakeAgent();
    const controller = new WcChatController({ thread, agent, readOnlyToolUi: true });

    agent.emit({
      type: 'tool_ui',
      messageId: 'm1',
      toolName: 'bash',
      requestId: 'req-1',
      html: MOUNT_APPROVAL_HTML,
    });
    expect(thread.querySelector('[data-tool-ui-request="req-1"]')).toBeTruthy();

    agent.emit({ type: 'tool_ui_done', messageId: 'm1', requestId: 'req-1' });
    expect(thread.querySelector('[data-tool-ui-request="req-1"]')).toBeNull();
  });
});

describe('WcChatController compaction markers (#2843)', () => {
  let thread: HTMLElement;
  let agent: FakeAgent;
  let controller: WcChatController;
  let processingStates: boolean[];

  beforeEach(() => {
    installWcDomStubs();
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    processingStates = [];
    controller = new WcChatController({
      thread,
      agent,
      onProcessingChange: (processing) => processingStates.push(processing),
    });
  });

  const notice = (
    messageId: string,
    state: 'summarizing' | 'summarized' | 'fallback' | 'discarded',
    extra: { trigger?: 'idle' | 'threshold' | 'overflow'; transcriptPath?: string } = {}
  ): void => {
    agent.emit({
      type: 'compaction_notice',
      messageId,
      marker: { trigger: extra.trigger ?? 'idle', state, ...extra },
    });
  };

  const markers = () => Array.from(thread.querySelectorAll('slicc-compaction-marker'));

  it('renders a marker row without ever going busy', () => {
    notice('c1', 'summarizing');

    expect(markers()).toHaveLength(1);

    expect(processingStates).toEqual([]);
  });

  it('does not park a following send in the queued stack', () => {
    const queuedChanges: Array<readonly { id: string; text: string }[]> = [];
    const local = document.createElement('slicc-chat-thread');
    document.body.appendChild(local);
    const localAgent = new FakeAgent();
    const ctl = new WcChatController({
      thread: local,
      agent: localAgent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });

    localAgent.emit({
      type: 'compaction_notice',
      messageId: 'c1',
      marker: { trigger: 'idle', state: 'summarizing' },
    });
    ctl.sendUserMessage('are you still there?');

    expect(local.querySelectorAll('slicc-user-message')).toHaveLength(1);
    expect(queuedChanges).toEqual([]);
    expect(localAgent.sent.map((s) => s.text)).toEqual(['are you still there?']);
  });

  it('updates the row in place on the terminal state', () => {
    notice('c1', 'summarizing', { transcriptPath: '/sessions/live-cone-a.md' });
    notice('c1', 'summarized', { transcriptPath: '/sessions/live-cone-a.md' });

    expect(markers()).toHaveLength(1);
    expect(markers()[0].getAttribute('state')).toBe('summarized');
    expect(markers()[0].getAttribute('transcript')).toBe('/sessions/live-cone-a.md');
    expect(controller.getMessages().filter((m) => m.compaction)).toHaveLength(1);
  });

  it('carries the trigger and the transcript path onto the element', () => {
    notice('c1', 'summarizing', { trigger: 'overflow', transcriptPath: '/sessions/x.md' });

    expect(markers()[0].getAttribute('trigger')).toBe('overflow');
    expect(markers()[0].getAttribute('transcript')).toBe('/sessions/x.md');
  });

  it('omits the transcript attribute when the round wrote no snapshot', () => {
    notice('c1', 'fallback', { trigger: 'threshold' });

    expect(markers()[0].hasAttribute('transcript')).toBe(false);
  });

  it('retracts the row when the round is discarded', () => {
    notice('c1', 'summarizing');
    notice('c1', 'discarded');

    expect(markers()).toHaveLength(0);
    expect(controller.getMessages().some((m) => m.id === 'c1')).toBe(false);
  });

  it('is a no-op when a discarded notice arrives with no row open', () => {
    expect(() => notice('never-seen', 'discarded')).not.toThrow();
    expect(markers()).toHaveLength(0);
    expect(controller.getMessages()).toHaveLength(0);
  });

  it('keeps a real user bubble when a marker is retracted from between rows', () => {
    controller.sendUserMessage('before');
    notice('c1', 'summarizing');
    agent.emit({ type: 'message_start', messageId: 'a1' });
    agent.emit({ type: 'turn_end', messageId: 'a1' });
    notice('c1', 'discarded');

    expect(markers()).toHaveLength(0);
    expect(thread.querySelectorAll('slicc-user-message')).toHaveLength(1);
    expect(controller.getMessages().map((m) => m.id)).toContain('a1');
  });

  it('does not capture a real assistant stream that follows it', async () => {
    notice('c1', 'summarizing');
    agent.emit({ type: 'message_start', messageId: 'a1' });
    agent.emit({ type: 'content_delta', messageId: 'a1', text: 'hello' });
    await nextFrame();
    agent.emit({ type: 'turn_end', messageId: 'a1' });

    expect(processingStates).toEqual([true, false]);
    const assistant = controller.getMessages().find((m) => m.id === 'a1');
    expect(assistant?.content).toBe('hello');
    expect(assistant?.compaction).toBeUndefined();
    expect(markers()).toHaveLength(1);
  });

  it('gives each round its own row', () => {
    notice('c1', 'summarizing');
    notice('c1', 'summarized');
    notice('c2', 'summarizing', { trigger: 'threshold' });

    expect(markers().map((m) => m.getAttribute('state'))).toEqual(['summarized', 'summarizing']);
  });
});
