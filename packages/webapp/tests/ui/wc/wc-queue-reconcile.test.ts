// @vitest-environment jsdom
/**
 * Reconciling a held queue against the BACKEND (#2354).
 *
 * A cone's queued pile survives a read-only detour into one of its own scoops
 * (#2312), but until now the only thing it was reconciled against on the way
 * back was the canonical replay. That catches duplicates — a prompt the cone
 * consumed while the user was away no longer comes back as a phantom card —
 * and nothing else. ORDER was whatever the panel happened to be holding, and
 * a prompt the cone dequeued between the replay snapshot and the restore
 * (there is a window) was in neither list.
 *
 * `scoop-messages-replaced` now carries `queuedIds`: the orchestrator's own
 * pending queue for that scoop, in delivery order, snapshotted with the
 * messages. That is the authority. `undefined` means the sender could not
 * answer (a tray follower, whose queue lives on the leader) and falls back to
 * the held order.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { ChatMessage } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import { createWcLiveCallbacks } from '../../../src/ui/wc/wc-live-callbacks.js';

function prompt(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `prompt ${id}`,
    timestamp: Number(id.slice(1)),
  } as ChatMessage;
}

interface Harness {
  controller: WcChatController;
  queuedIds(): string[];
  bubbleIds(): string[];
}

const live: WcChatController[] = [];

function makeController(): Harness {
  const thread = document.createElement('slicc-chat-thread');
  document.body.append(thread);
  const controller = new WcChatController({
    thread,
    agent: { onEvent: () => () => {}, sendMessage: () => {}, stop: () => {} },
  } as never);
  live.push(controller);
  return {
    controller,
    queuedIds: () => controller.getQueuedMessages().map((m) => (m as { id: string }).id),
    bubbleIds: () => controller.getMessages().map((m) => m.id),
  };
}

afterEach(() => {
  for (const controller of live.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('backend order wins', () => {
  it('re-sorts the held pile onto the orchestrator’s delivery order', () => {
    // The user queued q1, q2, q3 and walked into a scoop. A lick landed on the
    // cone meanwhile and the orchestrator now intends to run q3 first. The
    // pile the user comes back to has to say so.
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2'), prompt('q3')]);
    controller.loadMessages([], ['q3', 'q1', 'q2']);
    expect(queuedIds()).toEqual(['q3', 'q1', 'q2']);
  });

  it('ignores backend ids the panel has no content for', () => {
    // A queue card cannot be materialised from an id alone — the pile the user
    // is owed is by definition the one they were shown.
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q2')]);
    controller.loadMessages([], ['q1', 'q2', 'q3']);
    expect(queuedIds()).toEqual(['q2']);
  });

  it('applies the replay dedupe BEFORE the reorder', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2'), prompt('q3')]);
    // q2 was consumed while the user was away — it is a real bubble now.
    controller.loadMessages([prompt('q2')], ['q3', 'q1']);
    expect(queuedIds()).toEqual(['q3', 'q1']);
  });
});

describe('a backend-pending prompt outranks the replay (Codex P2 on #2362)', () => {
  // `Bridge.handleUserMessage` pushes every prompt into `messageBuffers` the
  // moment it is sent, queued or not — which is why `handleDeleteQueuedMessage`
  // has to scrub the buffer too. So the replay carries prompts the
  // orchestrator has NOT reached, and "present in the replay" cannot mean
  // "consumed". Deduping on that alone silently turned a live queue card
  // (still cancellable, still reorderable) into a plain bubble.

  it('keeps the card when the replay and the backend both hold the prompt', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([prompt('q1')], ['q1']);
    expect(queuedIds()).toEqual(['q1']);
  });

  it('does NOT also render it as a transcript bubble', () => {
    const { controller, bubbleIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([prompt('m1'), prompt('q1')], ['q1']);
    expect(bubbleIds()).toEqual(['m1']);
  });

  it('separates a consumed prompt from a still-pending one in the same replay', () => {
    // The whole point of asking the backend: both are in `messages`, only the
    // backend can say which one the cone actually ate.
    const { controller, queuedIds, bubbleIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([prompt('q1'), prompt('q2')], ['q2']);
    expect(queuedIds()).toEqual(['q2']);
    expect(bubbleIds()).toEqual(['q1']);
  });

  it('still applies the backend ORDER to prompts rescued from the replay', () => {
    const { controller, queuedIds, bubbleIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2'), prompt('q3')]);
    controller.loadMessages([prompt('q1'), prompt('q2'), prompt('q3')], ['q3', 'q1']);
    expect(queuedIds()).toEqual(['q3', 'q1']);
    expect(bubbleIds()).toEqual(['q2']);
  });

  it('leaves the transcript untouched when nothing is held', () => {
    const { controller, bubbleIds } = makeController();
    controller.loadMessages([prompt('m1'), prompt('m2')], ['m1']);
    expect(bubbleIds()).toEqual(['m1', 'm2']);
  });

  it('keeps the replay-wins reading without an authority (follower)', () => {
    // A follower cannot tell a queued prompt from a consumed one, so it must
    // not guess a card into existence — that is the phantom #2312 removed.
    const { controller, queuedIds, bubbleIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([prompt('q1')]);
    expect(queuedIds()).toEqual([]);
    expect(bubbleIds()).toEqual(['q1']);
  });
});

describe('items the backend does not list', () => {
  it('keeps an unacked local draft queued, appended last, while idle', () => {
    // Nothing is running, so nothing can be mid-consumption: q1 is a draft
    // whose enqueue the backend has not acked. Dropping it would lose a
    // prompt the user can still see; it goes behind the backend-ordered ones.
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([], ['q2']);
    expect(queuedIds()).toEqual(['q2', 'q1']);
  });

  it('flushes an item the running turn swallowed mid-restore into a bubble', () => {
    // The consume race: the cone dequeued q1 between the replay snapshot and
    // the restore, so it is in neither list. While a turn is RUNNING that is
    // the live reading — leaving it as a card would pin a queue entry no
    // rising edge ever clears.
    const { controller, queuedIds, bubbleIds } = makeController();
    controller.setProcessing(true);
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([], ['q2']);
    expect(queuedIds()).toEqual(['q2']);
    expect(bubbleIds()).toEqual(['q1']);
  });

  it('flushes the whole pile when the running turn took everything', () => {
    const { controller, queuedIds, bubbleIds } = makeController();
    controller.setProcessing(true);
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([], []);
    expect(queuedIds()).toEqual([]);
    expect(bubbleIds()).toEqual(['q1', 'q2']);
  });

  it('keeps the whole pile when the backend queue is empty and nothing runs', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([], []);
    expect(queuedIds()).toEqual(['q1', 'q2']);
  });

  it('survives the wholesale re-render — flushed bubbles are not wiped', () => {
    // `loadMessages` rebuilds every row from scratch; the restore has to land
    // after that or the appended bubble is discarded with the old DOM.
    const { controller, bubbleIds } = makeController();
    controller.setProcessing(true);
    controller.restoreQueued([prompt('q9')]);
    controller.loadMessages([prompt('m1')], []);
    expect(bubbleIds()).toEqual(['m1', 'q9']);
  });
});

describe('no authoritative answer', () => {
  it('keeps the held order when queuedIds is undefined (follower path)', () => {
    // A tray follower's local orchestrator is deliberately idle; its empty
    // queue says nothing about what the leader still holds, so the bridge
    // omits the field and the panel must not reorder against silence.
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([]);
    expect(queuedIds()).toEqual(['q1', 'q2']);
  });

  it('still applies the replay dedupe without queuedIds', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([prompt('q1')]);
    expect(queuedIds()).toEqual(['q2']);
  });

  it('does not flush unlisted items into bubbles while processing', () => {
    // Without an authority there is no basis for calling anything consumed.
    const { controller, queuedIds } = makeController();
    controller.setProcessing(true);
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([]);
    expect(queuedIds()).toEqual(['q1']);
  });
});

describe('one-shot', () => {
  it('does not resurrect the pile on a later reload', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([], ['q1']);
    expect(queuedIds()).toEqual(['q1']);
    // A real session reload: the queue is dropped by `loadMessages` as ever
    // and the (already consumed) restore does not put it back.
    controller.loadMessages([], ['q1']);
    expect(queuedIds()).toEqual([]);
  });

  it('is a no-op when nothing was held', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([]);
    controller.loadMessages([], ['q1', 'q2']);
    expect(queuedIds()).toEqual([]);
  });
});

describe('replay envelope plumbing', () => {
  /**
   * The replay reaches the thread through the client protocol now (#2382), not
   * through an `onScoopMessagesReplaced` handler in the callback bag — so these
   * drive the real mount: `prepareWcShell` selects a unit (which subscribes),
   * and the kernel callback the ADAPTER decorates delivers the envelope.
   */
  function mountedShell(loadMessages: (messages: unknown[], queuedIds?: string[]) => void) {
    const app = document.createElement('div');
    document.body.append(app);
    const boot = prepareWcShell(app, 'test');
    const unit = {
      jid: 'cone-1',
      name: 'sliccy',
      folder: 'cone',
      parentJid: null,
      assistantLabel: 'sliccy',
      config: {},
    } as never;
    boot.setClient({
      selectedScoopJid: 'cone-1',
      setSelectedScoopJid: vi.fn(),
      requestScoopMessages: vi.fn(),
      isProcessing: () => false,
      deleteQueuedMessage: async () => undefined,
      getScoops: () => [unit],
    } as never);
    boot.setController({
      loadMessages,
      getQueuedMessages: () => [],
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn(),
      stashQueued: () => [],
    } as never);
    // The adapter decorates the bag; firing a wrapped callback is what a kernel
    // replay does.
    const callbacks = createWcLiveCallbacks(boot.wiring);
    boot.selectScoop(unit);
    return { callbacks };
  }

  it('hands queuedIds to the controller alongside the messages', () => {
    const loadMessages = vi.fn();
    const { callbacks } = mountedShell(loadMessages);
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never, ['q2', 'q1']);
    // Delivery order preserved, and the ids ride the SAME envelope as the
    // messages so the reconcile cannot race the consume (#2354/#2362).
    expect(loadMessages).toHaveBeenCalledWith([], ['q2', 'q1']);
  });

  it('passes undefined through untouched when the sender could not answer', () => {
    const loadMessages = vi.fn();
    const { callbacks } = mountedShell(loadMessages);
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never);
    // Absent is not empty: `undefined` leaves the held order standing.
    expect(loadMessages).toHaveBeenCalledWith([], undefined);
  });

  it('ignores a replay for a unit that is not selected', () => {
    const loadMessages = vi.fn();
    const { callbacks } = mountedShell(loadMessages);
    callbacks.onScoopMessagesReplaced?.('someone-else', [] as never, ['q1']);
    expect(loadMessages).not.toHaveBeenCalled();
  });
});
