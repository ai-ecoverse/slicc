// @vitest-environment jsdom

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

    boot.selectScoop(summaryOf(coneA));
    callbacks.onScoopMessagesReplaced?.('cone-1', [] as never, []);
    controller.setProcessing(true);
    controller.sendUserMessage('and then deploy it');
    const queued = controller.getQueuedMessages() as unknown as { id: string }[];
    expect(queued).toHaveLength(1);
    const id = queued[0]?.id as string;

    boot.selectScoop(summaryOf(coneB));
    callbacks.onScoopMessagesReplaced?.('cone-2', [] as never, []);
    expect(controller.getQueuedMessages()).toEqual([]);
    expect(
      (client.deleteQueuedMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
    ).toHaveLength(0);

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
  it('holds the pile when a frozen chat takes the thread, and restores it', () => {
    const controller = fakeController([{ id: 'q1' }]);
    const { boot, deleted } = bootShell(controller);

    boot.selectScoop(summaryOf(coneA));

    boot.holdQueuedPile();
    expect(controller.stashQueued).toHaveBeenCalledOnce();
    expect(deleted()).toHaveLength(0);

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

    boot.selectScoop(summaryOf(coneB));
    expect(controller.restoreQueued).not.toHaveBeenCalled();

    boot.selectScoop(summaryOf(coneA));
    expect(controller.restoreQueued).toHaveBeenCalledTimes(1);
    expect(controller.restoreQueued).toHaveBeenCalledWith([{ id: 'q1' }]);
  });
});

describe('a restore that has not landed yet stays with its own cone', () => {
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

    boot.selectScoop(summaryOf(coneA));
    boot.selectScoop(summaryOf(coneB));

    callbacks.onScoopMessagesReplaced?.('cone-2', [] as never, []);
    expect(ids()).toEqual([]);
    expect(controller.getMessages()).toEqual([]);

    boot.selectScoop(summaryOf(coneA));
    const buffered = { id, role: 'user', content: 'and then deploy it', timestamp: 1 };
    callbacks.onScoopMessagesReplaced?.('cone-1', [buffered] as never, [id]);
    expect(ids()).toEqual([id]);
    controller.dispose();
  });
});
