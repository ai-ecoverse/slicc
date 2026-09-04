// @vitest-environment jsdom
/**
 * Read-only scoop view (#2312).
 *
 * Users never talk to a scoop: selecting one opens a transcript with no
 * composer, no queued pile, no model picker and no CTAs. Switching back to a
 * cone restores the band with its text and queue intact — the composer is
 * hidden, never rebuilt, which is the whole reason it can be restored at all.
 */

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

/**
 * The same unit as the client protocol carries it. Selection is expressed in
 * summaries since #2382 D2a, while the fake kernel still answers with records.
 */
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
/** A scoop owned by the OTHER cone — the destination that must cancel. */
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
  };
}

function bootShell() {
  const app = document.createElement('div');
  document.body.append(app);
  const boot = prepareWcShell(app, 'test');
  boot.setClient(fakeClient() as never);
  return boot;
}

describe('read-only scoop view (leader)', () => {
  afterEach(() => {
    // Restore the graduated default — the off-switch below is a CENTRAL value
    // (a user override cannot turn this flag off since #2280), and central
    // values live on the module until the next `initFeatureFlags`.
    initFeatureFlags('standalone');
  });

  it('unmounts the composer band when a scoop is selected and restores it for a cone', () => {
    const boot = bootShell();

    boot.selectScoop(summaryOf(cone));
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);

    boot.selectScoop(summaryOf(worker));
    // `hidden` on `<slicc-composer>` is `display:none` in the component's own
    // sheet — the queued pile, model picker, thinking pill, dictation and
    // attachments all live inside it, so nothing is left and nothing is
    // reserved.
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
    // Nothing was cancelled on the backend: there is nowhere else to talk, so
    // reading a scoop is not the user abandoning the prompt.
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
    expect(controller.stashQueued).toHaveBeenCalledOnce();

    boot.selectScoop(summaryOf(cone));
    expect(controller.restoreQueued).toHaveBeenCalledWith(stashed);
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
  });

  it('cancels — never stashes — when leaving a cone for ANOTHER cone’s scoop (Codex P1)', () => {
    // Preserving on "destination is read-only" alone was wrong: hopping from
    // cone A straight to a scoop owned by cone B is the user going elsewhere
    // to work, so A's queued prompt is abandoned and must not stay live on
    // the backend just because the tab we landed on has no composer.
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

    expect(controller.stashQueued).not.toHaveBeenCalled();
    expect(client.deleteQueuedMessage.mock.calls).toEqual([['cone-1', 'q1']]);
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
    boot.selectScoop(summaryOf(sibling)); // still inside cone-1's subtree
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);

    boot.selectScoop(summaryOf(cone));
    expect(controller.restoreQueued).toHaveBeenCalledWith(stashed);
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
  });

  it('cancels a held pile once the user lands on a DIFFERENT cone', () => {
    const boot = bootShell();
    const stashed = [{ id: 'q1' }];
    let live: unknown[] = stashed;
    boot.setController({
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
    } as never);
    const client = boot.wiring.getClient() as unknown as {
      deleteQueuedMessage: { mock: { calls: unknown[][] } };
      getScoops: { mockReturnValue(v: unknown): void };
    };
    client.getScoops.mockReturnValue([cone, worker, otherCone]);
    boot.selectScoop(summaryOf(cone));
    boot.selectScoop(summaryOf(worker));
    boot.selectScoop(summaryOf(otherCone));

    expect(client.deleteQueuedMessage.mock.calls).toEqual([['cone-1', 'q1']]);
  });

  it('applies with the multiple-cones flag OFF — it is not part of that experiment', () => {
    // Users never talk to scoops, flag or no flag: the read-only view is the
    // one piece of the multi-cones stack that ships unflagged. Nothing in the
    // path (`unitRoleFor` → `isReadOnlyRole` → `applyComposerAvailability`,
    // and the follower's `summaryRole`) reads a feature flag; this pins that
    // so a future gate around the selection wiring cannot silently re-expose
    // a scoop composer.
    //
    // The off-switch is the worker's central value, not a `localStorage`
    // override: since #2280 the flag is not `userToggleable`, so an override
    // is dropped by `canOverride` and would leave this testing the ON state.
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
    // The reload path, not a click: `ensureSelection` (wc-live-callbacks)
    // resolves `pendingUrlContext` and routes it through the SAME
    // `selectScoop`, so a restored scoop context can never boot with a live
    // composer. Driven through the real callback (`onReady`) rather than by
    // calling `selectScoop` directly, which is what makes this cover the
    // wiring instead of just the resolution.
    initFeatureFlags('standalone', { 'multiple-cones': 'off' });
    const boot = bootShell();
    boot.wiring.pendingUrlContext = 'scoop:worker';

    createWcLiveCallbacks(boot.wiring).onReady?.();

    expect(boot.getSelected()?.id).toBe('scoop-1');
    expect(boot.refs.thread.getAttribute('context')).toBe('scoop:worker');
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(true);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(true);
    // The context is consumed, so a later roster push cannot re-route it.
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
    // The replay is canonical. If the cone's turn ate the queued prompt while
    // the user read its scoop, that prompt is already a real message — adding
    // the stashed snapshot back would show it twice: once as a bubble and
    // once as a queue card that never clears.
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
    // The restore is one-shot: a later reload must not resurrect it.
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
    // No `action` at all: an actionless card would fall back to the default
    // Retry button, so the card is asked to render no footer instead.
    expect(readOnly.hasAttribute('action')).toBe(false);
    expect(readOnly.hasAttribute('no-action')).toBe(true);
  });
});
