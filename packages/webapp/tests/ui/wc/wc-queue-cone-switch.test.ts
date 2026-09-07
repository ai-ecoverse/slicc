// @vitest-environment jsdom
/**
 * A cone's queued pile survives a switch to ANOTHER cone.
 *
 * Typing while a cone works stacks the prompt on the queued pile; the backend
 * already holds it (every send is buffered synchronously). Walking over to a
 * second cone to read what it is doing used to CANCEL that pile — the cards
 * vanished and the orchestrator dropped the prompts — which reads as SLICC
 * throwing away work the user already committed to. The pile belongs to the
 * cone that owns it, so it is held per cone and re-installed on the way back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import { WcChatController } from '../../../src/ui/wc/wc-chat-controller.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import { createWcLiveCallbacks } from '../../../src/ui/wc/wc-live-callbacks.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';
import type { WorkUnitSummary } from '../../../src/work-unit/client/types.js';
import { installLeaderChatHost, leaderChatHostFakes } from './leader-chat-host.js';

function unit(over: Partial<RegisteredScoop>): RegisteredScoop {
  return {
    jid: 'jid',
    name: 'name',
    folder: 'folder',
    isCone: over.parentJid === null,
    type: over.parentJid === null ? 'cone' : 'scoop',
    requiresTrigger: false,
    assistantLabel: 'label',
    addedAt: '2026-01-01T00:00:00.000Z',
    parentJid: 'cone-1',
    ...over,
  } as RegisteredScoop;
}

const summaryOf = (record: RegisteredScoop): WorkUnitSummary => recordToWorkUnitSummary(record, {});

const coneA = unit({ jid: 'cone-1', name: 'sliccy', folder: 'cone', parentJid: null });
const coneB = unit({ jid: 'cone-2', name: 'research', folder: 'cone-research', parentJid: null });
const scoopOfB = unit({ jid: 'scoop-3', name: 'helper', folder: 'helper', parentJid: 'cone-2' });
const roster = [coneA, coneB, scoopOfB];

function fakeClient(): Record<string, unknown> {
  let selectedScoopJid: string | null = null;
  return {
    get selectedScoopJid() {
      return selectedScoopJid;
    },
    setSelectedScoopJid: vi.fn((jid: string) => {
      selectedScoopJid = jid;
    }),
    requestScoopMessages: vi.fn(),
    isProcessing: vi.fn(() => false),
    deleteQueuedMessage: vi.fn(async () => undefined),
    getScoops: vi.fn(() => roster),
    getScoop: vi.fn((jid: string) => roster.find((record) => record.jid === jid)),
    ...leaderChatHostFakes(),
  };
}

/** A controller stub whose pile behaves like the real stash/restore pair. */
function fakeController(initial: readonly { id: string }[]) {
  let live: unknown[] = [...initial];
  return {
    getQueuedMessages: vi.fn(() => live),
    stashQueued: vi.fn(() => {
      const taken = live;
      live = [];
      return taken;
    }),
    restoreQueued: vi.fn((items: unknown[]) => {
      live = [...items];
    }),
    setLickBackpressure: vi.fn(),
    setProcessing: vi.fn(),
    setReadOnly: vi.fn(),
  };
}

function bootShell(controller: ReturnType<typeof fakeController>) {
  const app = document.createElement('div');
  document.body.append(app);
  const boot = prepareWcShell(app, 'test');
  const client = fakeClient();
  boot.setClient(client as never);
  installLeaderChatHost(boot, client);
  boot.setController(controller as never);
  return {
    boot,
    deleted: () =>
      (client.deleteQueuedMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('queued pile across a cone switch', () => {
  it('holds — never cancels — when leaving a working cone for another cone', () => {
    const controller = fakeController([{ id: 'q1' }, { id: 'q2' }]);
    const { boot, deleted } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));
    boot.selectScoop(summaryOf(coneB));

    expect(deleted()).toHaveLength(0);
    expect(controller.stashQueued).toHaveBeenCalledOnce();
  });

  it('re-installs the pile when the user comes back to the cone', () => {
    const controller = fakeController([{ id: 'q1' }, { id: 'q2' }]);
    const { boot, deleted } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));
    boot.selectScoop(summaryOf(coneB));
    boot.selectScoop(summaryOf(coneA));

    expect(controller.restoreQueued).toHaveBeenCalledWith([{ id: 'q1' }, { id: 'q2' }]);
    expect(deleted()).toHaveLength(0);
  });

  it('keeps holding across a hop through a THIRD unit', () => {
    const controller = fakeController([{ id: 'q1' }]);
    const { boot, deleted } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));
    boot.selectScoop(summaryOf(coneB));
    boot.selectScoop(summaryOf(scoopOfB));
    boot.selectScoop(summaryOf(coneA));

    expect(controller.restoreQueued).toHaveBeenCalledWith([{ id: 'q1' }]);
    expect(deleted()).toHaveLength(0);
  });

  it('holds each cone’s pile separately', () => {
    const controller = fakeController([{ id: 'a1' }]);
    const { boot, deleted } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));
    boot.selectScoop(summaryOf(coneB));
    // B's own pile, typed while B works.
    controller.restoreQueued([{ id: 'b1' }]);
    boot.selectScoop(summaryOf(coneA));
    expect(controller.restoreQueued).toHaveBeenLastCalledWith([{ id: 'a1' }]);
    boot.selectScoop(summaryOf(coneB));
    expect(controller.restoreQueued).toHaveBeenLastCalledWith([{ id: 'b1' }]);
    expect(deleted()).toHaveLength(0);
  });
});

describe('the whole round trip, on the real controller', () => {
  it('brings the cards back after a detour through another cone', () => {
    const app = document.createElement('div');
    document.body.append(app);
    const boot = prepareWcShell(app, 'test');
    const client = fakeClient();
    boot.setClient(client as never);
    installLeaderChatHost(boot, client);
    const callbacks = createWcLiveCallbacks(boot.wiring);

    const thread = document.createElement('slicc-chat-thread');
    document.body.append(thread);
    const controller = new WcChatController({
      thread,
      agent: {
        onEvent: () => () => undefined,
        sendMessage: () => undefined,
        stop: () => undefined,
      },
    } as never);
    boot.setController(controller as never);

    // Cone A is working; the user types anyway, so the prompt stacks.
    boot.selectScoop(summaryOf(coneA));
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never, []);
    controller.setProcessing(true);
    controller.sendUserMessage('and then deploy it');
    const queued = controller.getQueuedMessages() as unknown as { id: string }[];
    expect(queued).toHaveLength(1);
    const id = queued[0]?.id as string;

    // Off to cone B to see what it is up to. The pile leaves the screen…
    boot.selectScoop(summaryOf(coneB));
    callbacks.onScoopMessagesReplaced?.('cone-2', [] as never, []);
    expect(controller.getQueuedMessages()).toEqual([]);
    expect(
      (client.deleteQueuedMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
    ).toHaveLength(0);

    // …and comes back with it. The replay carries the prompt because every
    // send is buffered, and the backend still lists it as pending — so it is
    // a card, not a bubble.
    boot.selectScoop(summaryOf(coneA));
    const buffered = { id, role: 'user', content: 'and then deploy it', timestamp: 1 };
    callbacks.onScoopMessagesReplaced?.('cone-1', [buffered] as never, [id]);
    expect(
      (controller.getQueuedMessages() as unknown as { id: string }[]).map((m) => m.id)
    ).toEqual([id]);
    expect(controller.getMessages().map((m: ChatMessage) => m.id)).toEqual([]);
    controller.dispose();
  });
});

describe('queued pile across a Freezer detour', () => {
  /**
   * Thawing a frozen chat replaces the thread WITHOUT a selection change —
   * `openFrozen` calls `loadMessages` directly and then clears the selection —
   * so the pile used to be cancelled by the very `onQueuedCancel` path a
   * switch no longer takes. `holdQueuedPile()` parks it under the selected
   * cone first, and re-selecting that cone hands it back.
   */
  it('holds the pile when a frozen chat takes the thread, and restores it', () => {
    const controller = fakeController([{ id: 'q1' }]);
    const { boot, deleted } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));
    // What `openFrozen` does before it paints the archive.
    boot.holdQueuedPile();
    expect(controller.stashQueued).toHaveBeenCalledOnce();
    expect(deleted()).toHaveLength(0);

    // Leaving the Freezer means selecting a cone again — with NO previous
    // selection, since the thaw cleared it.
    boot.clearSelection();
    boot.selectScoop(summaryOf(coneA));
    expect(controller.restoreQueued).toHaveBeenLastCalledWith([{ id: 'q1' }]);
  });

  it('is a no-op with nothing selected', () => {
    const controller = fakeController([{ id: 'q1' }]);
    const { boot } = bootShell(controller);
    boot.holdQueuedPile();
    expect(controller.stashQueued).not.toHaveBeenCalled();
  });

  it('does not hand the pile to a different cone on the way out of the Freezer', () => {
    const controller = fakeController([{ id: 'q1' }]);
    const { boot } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));
    boot.holdQueuedPile();
    boot.clearSelection();

    // Out of the Freezer into cone B: B has no pile of its own and must not
    // inherit A's.
    boot.selectScoop(summaryOf(coneB));
    expect(controller.restoreQueued).not.toHaveBeenCalled();

    boot.selectScoop(summaryOf(coneA));
    expect(controller.restoreQueued).toHaveBeenCalledTimes(1);
    expect(controller.restoreQueued).toHaveBeenCalledWith([{ id: 'q1' }]);
  });
});

describe('a restore that has not landed yet stays with its own cone', () => {
  /**
   * `restoreQueued` arms a SINGLE pending slot that carries no unit id, and
   * the replay it waits for is asynchronous. Leaving the cone again inside
   * that window used to leave the slot armed, so the next unit's replay —
   * another cone, or a Freezer thaw — consumed the pile and rendered one
   * cone's queued prompts under another's thread (Codex P1 on this PR).
   */
  it('re-holds an armed restore when the user leaves before the replay lands', () => {
    const app = document.createElement('div');
    document.body.append(app);
    const boot = prepareWcShell(app, 'test');
    const client = fakeClient();
    boot.setClient(client as never);
    installLeaderChatHost(boot, client);
    const callbacks = createWcLiveCallbacks(boot.wiring);

    const thread = document.createElement('slicc-chat-thread');
    document.body.append(thread);
    const controller = new WcChatController({
      thread,
      agent: {
        onEvent: () => () => undefined,
        sendMessage: () => undefined,
        stop: () => undefined,
      },
    } as never);
    boot.setController(controller as never);
    const ids = () =>
      (controller.getQueuedMessages() as unknown as { id: string }[]).map((m) => m.id);

    boot.selectScoop(summaryOf(coneA));
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never, []);
    controller.setProcessing(true);
    controller.sendUserMessage('and then deploy it');
    const id = ids()[0] as string;

    boot.selectScoop(summaryOf(coneB));
    callbacks.onScoopMessagesReplaced?.('cone-2', [] as never, []);

    // Back to A — the restore is armed — and straight out again before A's
    // snapshot has had a chance to arrive.
    boot.selectScoop(summaryOf(coneA));
    boot.selectScoop(summaryOf(coneB));

    // B's replay must not inherit A's pile.
    callbacks.onScoopMessagesReplaced?.('cone-2', [] as never, []);
    expect(ids()).toEqual([]);
    expect(controller.getMessages()).toEqual([]);

    // A still owns it.
    boot.selectScoop(summaryOf(coneA));
    const buffered = { id, role: 'user', content: 'and then deploy it', timestamp: 1 };
    callbacks.onScoopMessagesReplaced?.('cone-1', [buffered] as never, [id]);
    expect(ids()).toEqual([id]);
    controller.dispose();
  });
});
