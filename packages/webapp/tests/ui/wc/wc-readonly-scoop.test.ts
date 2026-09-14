// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { initFeatureFlags, isFeatureEnabled } from '../../../src/core/feature-flags.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import { createWcLiveCallbacks } from '../../../src/ui/wc/wc-live-callbacks.js';
import { messageEls } from '../../../src/ui/wc/wc-message-view.js';
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

function summaryOf(record: RegisteredScoop): WorkUnitSummary {
  return recordToWorkUnitSummary(record, {});
}

const cone = unit({ jid: 'cone-1', name: 'sliccy', folder: 'cone', parentJid: null });
const worker = unit({ jid: 'scoop-1', name: 'worker', folder: 'worker-scoop' });
const sibling = unit({ jid: 'scoop-2', name: 'sibling', folder: 'sibling-scoop' });
const otherCone = unit({
  jid: 'cone-2',
  name: 'research',
  folder: 'cone-research',
  parentJid: null,
});

const otherScoop = unit({
  jid: 'scoop-3',
  name: 'helper',
  folder: 'helper-scoop',
  parentJid: 'cone-2',
});

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
    getScoops: vi.fn(() => [cone, worker]),
    getScoop: vi.fn((jid: string) => [cone, worker].find((record) => record.jid === jid)),
    ...leaderChatHostFakes(),
  };
}

function bootShell() {
  const app = document.createElement('div');
  document.body.append(app);
  const boot = prepareWcShell(app, 'test');
  const client = fakeClient();
  boot.setClient(client as never);

  installLeaderChatHost(boot, client);
  return boot;
}

describe('read-only scoop view (leader)', () => {
  afterEach(() => {
    initFeatureFlags('standalone');
  });

  it('unmounts the composer band when a scoop is selected and restores it for a cone', () => {
    const boot = bootShell();

    boot.selectScoop(summaryOf(cone));
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);

    boot.selectScoop(summaryOf(worker));

    expect(boot.refs.composer.hasAttribute('hidden')).toBe(true);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(true);

    boot.selectScoop(summaryOf(cone));
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the composer text across a scoop round trip', () => {
    const boot = bootShell();
    boot.selectScoop(summaryOf(cone));
    (boot.refs.inputCard as HTMLElement & { value: string }).value = 'half-written thought';

    boot.selectScoop(summaryOf(worker));
    boot.selectScoop(summaryOf(cone));

    expect((boot.refs.inputCard as HTMLElement & { value: string }).value).toBe(
      'half-written thought'
    );
  });

  it('holds the cone’s queued pile across a read-only detour instead of cancelling it', () => {
    const boot = bootShell();
    const stashed = [{ id: 'q1' }, { id: 'q2' }];
    let live: unknown[] = stashed;
    const controller = {
      getQueuedMessages: vi.fn(() => live),
      stashQueued: vi.fn(() => {
        const taken = live;
        live = [];
        return taken;
      }),
      restoreQueued: vi.fn(),
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn(),
    };
    boot.setController(controller as never);
    const client = boot.wiring.getClient() as unknown as {
      deleteQueuedMessage: { mock: { calls: unknown[][] } };
    };

    boot.selectScoop(summaryOf(cone));
    boot.selectScoop(summaryOf(worker));

    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
    expect(controller.stashQueued).toHaveBeenCalledOnce();

    boot.selectScoop(summaryOf(cone));
    expect(controller.restoreQueued).toHaveBeenCalledWith(stashed);
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
  });

  it('holds — never cancels — when leaving a cone for ANOTHER cone’s scoop', () => {
    const boot = bootShell();
    const stashed = [{ id: 'q1' }];
    let live: unknown[] = stashed;
    const controller = {
      getQueuedMessages: vi.fn(() => live),
      stashQueued: vi.fn(() => {
        const taken = live;
        live = [];
        return taken;
      }),
      restoreQueued: vi.fn(),
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn(),
    };
    boot.setController(controller as never);
    const client = boot.wiring.getClient() as unknown as {
      deleteQueuedMessage: { mock: { calls: unknown[][] } };
      getScoops: { mockReturnValue(v: unknown): void };
    };
    client.getScoops.mockReturnValue([cone, worker, otherCone, otherScoop]);

    boot.selectScoop(summaryOf(cone));
    boot.selectScoop(summaryOf(otherScoop));

    expect(controller.stashQueued).toHaveBeenCalledOnce();
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);

    boot.selectScoop(summaryOf(cone));
    expect(controller.restoreQueued).toHaveBeenCalledWith(stashed);
  });

  it('keeps holding across a SIBLING scoop of the same cone, then restores', () => {
    const boot = bootShell();
    const stashed = [{ id: 'q1' }];
    let live: unknown[] = stashed;
    const controller = {
      getQueuedMessages: vi.fn(() => live),
      stashQueued: vi.fn(() => {
        const taken = live;
        live = [];
        return taken;
      }),
      restoreQueued: vi.fn(),
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn(),
    };
    boot.setController(controller as never);
    const client = boot.wiring.getClient() as unknown as {
      deleteQueuedMessage: { mock: { calls: unknown[][] } };
      getScoops: { mockReturnValue(v: unknown): void };
    };
    client.getScoops.mockReturnValue([cone, worker, sibling]);

    boot.selectScoop(summaryOf(cone));
    boot.selectScoop(summaryOf(worker));
    boot.selectScoop(summaryOf(sibling));
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);

    boot.selectScoop(summaryOf(cone));
    expect(controller.restoreQueued).toHaveBeenCalledWith(stashed);
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
  });

  it('keeps a held pile alive while the user works in a DIFFERENT cone', () => {
    const boot = bootShell();
    const stashed = [{ id: 'q1' }];
    let live: unknown[] = stashed;
    const controller = {
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
    boot.setController(controller as never);
    const client = boot.wiring.getClient() as unknown as {
      deleteQueuedMessage: { mock: { calls: unknown[][] } };
      getScoops: { mockReturnValue(v: unknown): void };
    };
    client.getScoops.mockReturnValue([cone, worker, otherCone]);
    boot.selectScoop(summaryOf(cone));
    boot.selectScoop(summaryOf(worker));
    boot.selectScoop(summaryOf(otherCone));

    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
    boot.selectScoop(summaryOf(cone));
    expect(controller.restoreQueued).toHaveBeenLastCalledWith(stashed);
  });

  it('applies with the multiple-cones flag OFF — it is not part of that experiment', () => {
    initFeatureFlags('standalone', { 'multiple-cones': 'off' });
    expect(isFeatureEnabled('multiple-cones')).toBe(false);
    const boot = bootShell();

    boot.selectScoop(summaryOf(cone));
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);

    boot.selectScoop(summaryOf(worker));
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(true);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(true);

    boot.selectScoop(summaryOf(cone));
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);
  });

  it('keeps the scoop shell mood — only the interactive chrome goes away', () => {
    const boot = bootShell();
    boot.selectScoop(summaryOf(worker));
    expect(boot.refs.shader.getAttribute('mode')).toBe('scoop');
    expect(boot.refs.shader.getAttribute('tint')).toBeTruthy();
    expect(boot.refs.thread.getAttribute('context')).toBe('scoop:worker');
  });

  it('comes up read-only when BOOT restores a `scoop:<name>` URL context, flag off', () => {
    initFeatureFlags('standalone', { 'multiple-cones': 'off' });
    const boot = bootShell();
    boot.wiring.pendingUrlContext = 'scoop:worker';

    createWcLiveCallbacks(boot.wiring).onReady?.();

    expect(boot.getSelected()?.id).toBe('scoop-1');
    expect(boot.refs.thread.getAttribute('context')).toBe('scoop:worker');
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(true);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(true);

    expect(boot.wiring.pendingUrlContext).toBeNull();
  });

  it('opens the read-only view for a `scoop:<name>` URL context', async () => {
    const { unitForContext } = await import('../../../src/ui/wc/wc-unit-context.js');
    const boot = bootShell();
    const addressed = unitForContext([cone, worker].map(summaryOf), 'scoop:worker');
    expect(addressed?.id).toBe('scoop-1');

    boot.selectScoop(addressed as WorkUnitSummary);

    expect(boot.refs.thread.getAttribute('context')).toBe('scoop:worker');
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(true);
  });

  it('tells the controller before it asks for the new unit’s messages', () => {
    const boot = bootShell();
    const order: string[] = [];
    boot.setController({
      getQueuedMessages: () => [],
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn((readOnly: boolean) => order.push(`readOnly=${readOnly}`)),
    } as never);
    const client = boot.wiring.getClient() as unknown as {
      requestScoopMessages: { mockImplementation(fn: () => void): void };
    };
    client.requestScoopMessages.mockImplementation(() => order.push('requestMessages'));

    boot.selectScoop(summaryOf(worker));

    expect(order).toEqual(['readOnly=true', 'requestMessages']);
  });
});

describe('queue held across a read-only detour', () => {
  it('drops prompts the cone already consumed while the user was away (Codex P2)', async () => {
    const { WcChatController } = await import('../../../src/ui/wc/wc-chat-controller.js');
    const thread = document.createElement('slicc-chat-thread');
    document.body.append(thread);
    const queuedViews: unknown[][] = [];
    const controller = new WcChatController({
      thread,
      agent: { onEvent: () => () => {}, sendMessage: () => {}, stop: () => {} },
      onQueuedChange: (items: readonly unknown[]) => queuedViews.push([...items]),
    } as never);

    const consumed = { id: 'q1', role: 'user', content: 'eaten', timestamp: 1 } as ChatMessage;
    const pending = {
      id: 'q2',
      role: 'user',
      content: 'still waiting',
      timestamp: 2,
    } as ChatMessage;
    controller.restoreQueued([consumed, pending]);
    controller.loadMessages([consumed]);

    const ids = controller.getQueuedMessages().map((m) => (m as { id: string }).id);
    expect(ids).toEqual(['q2']);
    controller.dispose();
  });

  it('restores nothing when the replay already contains every held prompt', async () => {
    const { WcChatController } = await import('../../../src/ui/wc/wc-chat-controller.js');
    const thread = document.createElement('slicc-chat-thread');
    document.body.append(thread);
    const controller = new WcChatController({
      thread,
      agent: { onEvent: () => () => {}, sendMessage: () => {}, stop: () => {} },
    } as never);

    const q = { id: 'q1', role: 'user', content: 'eaten', timestamp: 1 } as ChatMessage;
    controller.restoreQueued([q]);
    controller.loadMessages([q]);

    expect(controller.getQueuedMessages()).toEqual([]);

    controller.loadMessages([]);
    expect(controller.getQueuedMessages()).toEqual([]);
    controller.dispose();
  });
});

describe('read-only transcript rendering', () => {
  function errorMessage(content: string): ChatMessage {
    return {
      id: 'm1',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      error: true,
    } as ChatMessage;
  }

  it('drops every error-card CTA — including "Change model" — in a read-only view', () => {
    const invalidModel = errorMessage('The provided model identifier is invalid');
    const [live] = messageEls(invalidModel);
    expect(live.getAttribute('action')).toBe('change-model');
    expect(live.hasAttribute('no-action')).toBe(false);

    const [readOnly] = messageEls(invalidModel, { readOnly: true });

    expect(readOnly.hasAttribute('action')).toBe(false);
    expect(readOnly.hasAttribute('no-action')).toBe(true);
  });
});
