// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { ChatMessage } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import { createWcLiveCallbacks } from '../../../src/ui/wc/wc-live-callbacks.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';

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
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2'), prompt('q3')]);
    controller.loadMessages([], ['q3', 'q1', 'q2']);
    expect(queuedIds()).toEqual(['q3', 'q1', 'q2']);
  });

  it('ignores backend ids the panel has no content for', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q2')]);
    controller.loadMessages([], ['q1', 'q2', 'q3']);
    expect(queuedIds()).toEqual(['q2']);
  });

  it('applies the replay dedupe BEFORE the reorder', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2'), prompt('q3')]);

    controller.loadMessages([prompt('q2')], ['q3', 'q1']);
    expect(queuedIds()).toEqual(['q3', 'q1']);
  });
});

describe('a backend-pending prompt outranks the replay (Codex P2 on #2362)', () => {
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
    const { controller, queuedIds, bubbleIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([prompt('q1')]);
    expect(queuedIds()).toEqual([]);
    expect(bubbleIds()).toEqual(['q1']);
  });
});

describe('items the backend does not list', () => {
  it('keeps an unacked local draft queued, appended last, while idle', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1'), prompt('q2')]);
    controller.loadMessages([], ['q2']);
    expect(queuedIds()).toEqual(['q2', 'q1']);
  });

  it('flushes an item the running turn swallowed mid-restore into a bubble', () => {
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
    const { controller, bubbleIds } = makeController();
    controller.setProcessing(true);
    controller.restoreQueued([prompt('q9')]);
    controller.loadMessages([prompt('m1')], []);
    expect(bubbleIds()).toEqual(['m1', 'q9']);
  });
});

describe('no authoritative answer', () => {
  it('keeps the held order when queuedIds is undefined (follower path)', () => {
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
    const { controller, queuedIds } = makeController();
    controller.setProcessing(true);
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([]);
    expect(queuedIds()).toEqual(['q1']);
  });
});

describe('an armed restore is disarmed by the next stash', () => {
  it('hands the un-applied restore back to the stash', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    expect(controller.stashQueued().map((m) => m.id)).toEqual(['q1']);

    controller.loadMessages([], ['q1']);
    expect(queuedIds()).toEqual([]);
  });

  it('carries the live pile out behind the held one', () => {
    const { controller } = makeController();
    controller.setProcessing(true);
    controller.sendUserMessage('typed after the selection');
    controller.restoreQueued([prompt('q1')]);
    const stashed = controller.stashQueued();
    expect(stashed).toHaveLength(2);
    expect(stashed[0]?.id).toBe('q1');
    expect(stashed[1]?.content).toBe('typed after the selection');
  });

  it('is a no-op when neither a pile nor a restore is waiting', () => {
    const { controller } = makeController();
    expect(controller.stashQueued()).toEqual([]);
  });
});

describe('one-shot', () => {
  it('does not resurrect the pile on a later reload', () => {
    const { controller, queuedIds } = makeController();
    controller.restoreQueued([prompt('q1')]);
    controller.loadMessages([], ['q1']);
    expect(queuedIds()).toEqual(['q1']);

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
  function mountedShell(
    loadMessages: (messages: unknown[], queuedIds?: string[]) => void,
    jids: readonly string[] = ['cone-1']
  ) {
    const app = document.createElement('div');
    document.body.append(app);
    const boot = prepareWcShell(app, 'test');
    const units = jids.map(
      (jid) =>
        ({
          jid,
          name: jid,
          folder: jid,
          parentJid: null,
          assistantLabel: 'sliccy',
          config: {},
        }) as never
    );

    const summaries = units.map((record) => recordToWorkUnitSummary(record, {}));
    const unit = summaries[0] as never;
    let selectedScoopJid = jids[0] ?? null;
    boot.setClient({
      get selectedScoopJid() {
        return selectedScoopJid;
      },
      setSelectedScoopJid: vi.fn((jid: string) => {
        selectedScoopJid = jid;
      }),
      requestScoopMessages: vi.fn(),
      isProcessing: () => false,
      deleteQueuedMessage: async () => undefined,
      getScoops: () => units,
    } as never);
    boot.setController({
      loadMessages,
      getQueuedMessages: () => [],
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn(),
      stashQueued: () => [],
    } as never);

    const callbacks = createWcLiveCallbacks(boot.wiring);
    boot.selectScoop(unit);
    return {
      callbacks,
      selectUnit: (jid: string) => boot.selectScoop(summaries[jids.indexOf(jid)] as never),
    };
  }

  it('hands queuedIds to the controller alongside the messages', () => {
    const loadMessages = vi.fn();
    const { callbacks } = mountedShell(loadMessages);
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never, ['q2', 'q1']);

    expect(loadMessages).toHaveBeenCalledWith([], ['q2', 'q1']);
  });

  it('passes undefined through untouched when the sender could not answer', () => {
    const loadMessages = vi.fn();
    const { callbacks } = mountedShell(loadMessages);
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never);

    expect(loadMessages).toHaveBeenCalledWith([], undefined);
  });

  it('never leaves another unit’s transcript under the new unit’s chrome', () => {
    vi.useFakeTimers();
    try {
      const loadMessages = vi.fn();
      const { callbacks, selectUnit } = mountedShell(loadMessages, ['cone-1', 'cone-2']);

      callbacks.onScoopMessagesReplaced?.('cone-1', [{ id: 'a1' }] as never, []);
      expect(loadMessages).toHaveBeenLastCalledWith([{ id: 'a1' }], []);

      loadMessages.mockClear();
      selectUnit('cone-2');
      vi.advanceTimersByTime(5000);
      vi.advanceTimersByTime(5000);
      expect(loadMessages).toHaveBeenCalled();

      expect(loadMessages.mock.calls.at(-1)?.[0]).toEqual([]);

      expect(loadMessages.mock.calls.at(-1)?.[1]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a replay for a unit that is not selected', () => {
    const loadMessages = vi.fn();
    const { callbacks } = mountedShell(loadMessages);
    callbacks.onScoopMessagesReplaced?.('someone-else', [] as never, ['q1']);
    expect(loadMessages).not.toHaveBeenCalled();
  });
});
