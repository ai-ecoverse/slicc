// @vitest-environment jsdom
/**
 * Drives the WC chat controller with a scripted fake `AgentHandle` and
 * asserts the thread DOM tracks the legacy ChatPanel streaming semantics:
 * message_start → deltas (rAF-batched) → tool rows → content_done/turn_end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

vi.mock('../../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/ui/telemetry.js')>(
    '../../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn() };
});

import { trackChatSend } from '../../../src/ui/telemetry.js';
import type { AgentEvent, AgentHandle } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';

class FakeAgent implements AgentHandle {
  listeners = new Set<(event: AgentEvent) => void>();
  sent: Array<{ text: string; messageId?: string }> = [];
  stopped = 0;

  sendMessage(text: string, messageId?: string): void {
    this.sent.push({ text, messageId });
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

  beforeEach(() => {
    document.body.replaceChildren();
    thread = document.createElement('slicc-chat-thread');
    document.body.appendChild(thread);
    agent = new FakeAgent();
    processingStates = [];
    vi.mocked(trackChatSend).mockClear();
    controller = new WcChatController({
      thread,
      agent,
      onProcessingChange: (processing) => processingStates.push(processing),
    });
  });

  it('sends user prompts to the agent and renders the bubble locally', () => {
    controller.sendUserMessage('  build me a shader  ');
    expect(agent.sent).toEqual([{ text: 'build me a shader', messageId: expect.any(String) }]);
    const bubble = thread.querySelector('slicc-user-message');
    expect(bubble?.shadowRoot?.textContent).toContain('build me a shader');
  });

  it('ignores empty prompts', () => {
    controller.sendUserMessage('   ');
    expect(agent.sent).toEqual([]);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);
  });

  it('strips dictation markers on the follower echo while the agent + history keep them', async () => {
    // Reset the per-session priming flag so this test is hermetic (other
    // tests in the suite may have consumed the first-message slot already).
    const { resetDictationPriming } = await import('../../../src/speech/dictation-priming.js');
    resetDictationPriming();
    const localEchoes: Array<{ text: string; messageId: string }> = [];
    controller.setOnLocalUserMessage((text, messageId) => {
      localEchoes.push({ text, messageId });
    });
    controller.sendUserMessage('hello there', undefined, { dictation: true });
    // The agent (and the locally-stored ChatMessage) see the marked text so
    // replay / compaction keep the priming context.
    expect(agent.sent.length).toBe(1);
    expect(agent.sent[0].text).toContain('\uD83C\uDF99');
    expect(agent.sent[0].text).toMatch(/\u25C1[\s\S]*\u25B7/);
    const stored = controller.getMessages().find((m) => m.role === 'user');
    expect(stored?.content).toContain('\uD83C\uDF99');
    // The follower echo is display-clean — iOS renders message.content verbatim
    // and must not see the AI-only priming note.
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
      // The send itself must still go through — telemetry never blocks send.
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
      // The default `controller` from beforeEach has no resolver wired.
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

  it('folds un-flushed deltas into the final render on content_done', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'content_delta', messageId: 'm1', text: 'tail text' });
    // No rAF tick — content_done must still pick up the pending delta.
    agent.emit({ type: 'content_done', messageId: 'm1' });
    expect(thread.querySelector('slicc-agent-message')?.textContent).toContain('tail text');
  });

  it('renders tool calls as action rows and resolves their results', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'tool_use_start', messageId: 'm1', toolName: 'bash', toolInput: 'ls -la' });
    let row = thread.querySelector('slicc-action-row');
    // Tool titles are human phrases, never raw function names.
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
    // Second result with no pending call of that name is dropped silently.
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

  it('renders agent errors as a slicc-error-card and clears processing', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'error', error: 'rate limited' });
    expect(controller.processing).toBe(false);
    const card = thread.querySelector('slicc-error-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('message')).toBe('rate limited');
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
    // No duplicate user bubble — retry routes through `#agent.sendMessage`
    // directly, not `sendUserMessage`.
    expect(thread.querySelectorAll('slicc-user-message')).toHaveLength(1);
  });

  it('binds retry to the failed turn even when a newer prompt was queued', () => {
    // Turn A: user prompt + agent error. The user then queues prompt B while
    // the (no-longer-)in-flight controller is still settling. Retry must
    // resubmit A — the prompt that actually failed — not the newest user row.
    controller.sendUserMessage('prompt A');
    agent.emit({ type: 'message_start', messageId: 'm1' });
    agent.emit({ type: 'error', error: 'rate limited' });
    const card = thread.querySelector('slicc-error-card');
    const errorId = card?.getAttribute('message-id') ?? null;
    expect(errorId).not.toBeNull();
    // Newer user prompt queued AFTER the error card.
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
    // No content_done / turn_end / error — controller is still processing.
    expect(controller.processing).toBe(true);
    thread.dispatchEvent(new CustomEvent('slicc-error-retry', { bubbles: true, composed: true }));
    expect(agent.sent).toHaveLength(0);
  });

  it('replays an immediately-preceding lick (welcome-lick onboarding case)', () => {
    // The onboarding welcome lick is the very first input the cone sees;
    // an invalid-model fail on that turn leaves no user-typed message to
    // replay. The retry handler must resubmit the lick body so the cone
    // gets context (else the user sees "I don't have any context").
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
    // Lick directly above the error is the originating turn; the older
    // user message is not what produced this error.
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
    // Sequence: lick → user → error. The user message is the originating
    // turn; licks further up the thread are skipped.
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
    // Sequence: user prompt (turn A in flight) → lick arrives mid-turn →
    // error fires. The lick sits directly above the error but it was
    // queued AFTER the originator, so retry must resubmit the user prompt
    // — not the queued lick.
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
    // No detail on the event — older callers / non-card dispatchers.
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
    // A different channel breaks the run and starts a fresh card.
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
    // Pending on arrival — no result glyph yet.
    expect(card?.hasAttribute('state')).toBe(false);

    // The cone confirms: the rendered card flips in place (no new row).
    controller.updateLickState('lick-1', 'confirmed');
    expect(thread.querySelectorAll('slicc-lick-card')).toHaveLength(1);
    expect(thread.querySelector('slicc-lick-card')?.getAttribute('state')).toBe('confirmed');
  });

  it('never collates actionable licks — each same-channel card stands alone and flips', () => {
    // Two consecutive same-channel actionable licks must NOT merge into a
    // counted card — each needs its own row so exactly one flips per resolve.
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

    // Each resolves independently — confirming the first leaves the second pending.
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
    // Unknown lick id leaves the rendered card untouched.
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
    // Delivery still fires immediately (agent received it; orchestrator owns
    // turn batching). The thread DOM is untouched — no inline bubble.
    expect(agent.sent.at(-1)?.text).toBe('queued one');
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(bubblesBefore);
    expect(thread.querySelector('slicc-user-message[queued]')).toBeNull();
    // The host-render hook fired with the queued view (id + text only).
    expect(queuedChanges.length).toBe(1);
    expect(queuedChanges[0]).toHaveLength(1);
    expect(queuedChanges[0][0].text).toBe('queued one');
    expect(localController.getQueuedMessages()).toHaveLength(1);
  });

  it('flushes queued submissions into the thread at the next turn start', () => {
    const queuedChanges: Array<readonly { id: string }[]> = [];
    const localController = new WcChatController({
      thread,
      agent,
      onQueuedChange: (items) => queuedChanges.push(items.slice()),
    });
    // Turn 1 starts, two prompts queue mid-turn, turn 1 ends.
    agent.emit({ type: 'message_start', messageId: 'm1' });
    localController.sendUserMessage('first queued');
    localController.sendUserMessage('second queued');
    agent.emit({ type: 'turn_end', messageId: 'm1' });
    expect(localController.getQueuedMessages()).toHaveLength(2);
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);

    // Turn 2's first message_start consumes the queue: both bubbles flush
    // into the thread in enqueue order — first queued first — BEFORE the
    // streaming assistant bubble. No `queued` attribute on either.
    agent.emit({ type: 'message_start', messageId: 'm2' });
    const userBubbles = thread.querySelectorAll('slicc-user-message');
    expect(userBubbles).toHaveLength(2);
    expect(userBubbles[0].shadowRoot?.textContent).toContain('first queued');
    expect(userBubbles[1].shadowRoot?.textContent).toContain('second queued');
    expect([...userBubbles].some((b) => b.hasAttribute('queued'))).toBe(false);
    // The queued list is empty and the host got a final change call.
    expect(localController.getQueuedMessages()).toHaveLength(0);
    expect(queuedChanges.at(-1)).toHaveLength(0);
  });

  it('does not re-flush queued items on mid-turn second message_start (multi-message turn)', () => {
    agent.emit({ type: 'message_start', messageId: 'm1' });
    controller.sendUserMessage('queued mid-turn');
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(0);
    // A second message_start in the SAME turn (multi-message) must NOT
    // flush — those items belong to the NEXT turn.
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
    // Unknown id is a no-op (no change notification).
    queuedChanges.length = 0;
    localController.removeQueuedMessage('does-not-exist');
    expect(queuedChanges).toHaveLength(0);
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
    // The final render replaced the streaming elements — disposal first.
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

  // Regression for #959: a canonical replay that lands mid-turn must leave the
  // stream machine pointed at the streaming tail so resumed deltas extend it
  // (and content_done folds the last un-flushed chunk) instead of the reply
  // hanging unrendered behind a stuck spinner.
  it('resumes a streaming tail after loadMessages: deltas extend it, content_done flushes', async () => {
    const { thread, agent, controller } = makeTracked();
    controller.loadMessages([
      { id: 'm1', role: 'assistant', content: 'before', timestamp: 2, isStreaming: true },
    ]);
    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' mid' });
    await nextFrame();
    expect(thread.querySelector('slicc-agent-message')?.textContent).toContain('before mid');

    // A delta with no rAF tick before content_done must still be folded in
    // (works because loadMessages restored #currentStreamId for the tail).
    agent.emit({ type: 'content_delta', messageId: 'm1', text: ' end' });
    agent.emit({ type: 'content_done', messageId: 'm1' });
    const el = thread.querySelector('slicc-agent-message');
    expect(el?.textContent).toContain('before mid end');
    expect(el?.hasAttribute('streaming')).toBe(false);
    expect(thread.querySelectorAll('slicc-agent-message')).toHaveLength(1);
  });

  // A prompt/lick queued mid-turn is buffered after the streaming assistant,
  // so loadMessages must scan backward (not assume the tail) to keep resuming
  // the right bubble.
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
    const thread = document.createElement('slicc-chat-thread') as HTMLElement & {
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

    // Streaming re-renders follow politely too (this is where the chip shows).
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
    // A lick whose content is a non-string used to throw deep inside
    // messageEls and wipe the whole thread render. Force the worst case with
    // a hostile payload: content as an object (seen after OPFS corruption).
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
    // The renderer threw (logged), the broken message degraded to a plain
    // bubble, and the healthy neighbours rendered untouched.
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

    // THE LIVE-FLOAT SHAPE (regression): the chat wire never carries a
    // `turn_end` event — content events stream, then processing falls via a
    // scoop STATUS broadcast (`setProcessing`). The completion hook must
    // fire on that transition too, or the spoken-reply loop is dead outside
    // tests.
    agent.emit({ type: 'message_start', messageId: 'm10' });
    agent.emit({ type: 'content_delta', messageId: 'm10', text: 'live reply' });
    agent.emit({ type: 'content_done', messageId: 'm10' });
    await nextFrame();
    controller.setProcessing(false);
    expect(completed[1]?.content).toBe('live reply');

    // No transition (already idle) → no duplicate fire.
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

    // Turn 1 streams a reply.
    agent.emit({ type: 'message_start', messageId: 't1' });
    agent.emit({ type: 'content_delta', messageId: 't1', text: 'earlier answer' });
    agent.emit({ type: 'content_done', messageId: 't1' });
    await nextFrame();
    agent.emit({ type: 'turn_end', messageId: 't1' });
    expect(completed[0]?.content).toBe('earlier answer');

    // A later turn that streams NOTHING (status-only cycle) must report null
    // — never re-surface turn 1's reply (the stale-speak review finding).
    controller.setProcessing(true);
    controller.setProcessing(false);
    expect(completed[1]).toBeNull();

    // The error path: processing falls before the error bubble is appended.
    // The hook gets THIS turn's (empty) stream — not 'earlier answer'.
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
