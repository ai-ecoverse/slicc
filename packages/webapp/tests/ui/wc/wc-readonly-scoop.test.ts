// @vitest-environment jsdom
/**
 * Read-only scoop view (#2312).
 *
 * Users never talk to a scoop: selecting one opens a transcript with no
 * composer, no queued pile, no model picker and no CTAs. Switching back to a
 * cone restores the band with its text and queue intact — the composer is
 * hidden, never rebuilt, which is the whole reason it can be restored at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import { messageEls } from '../../../src/ui/wc/wc-message-view.js';

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

const cone = unit({ jid: 'cone-1', name: 'sliccy', folder: 'cone', parentJid: null });
const worker = unit({ jid: 'scoop-1', name: 'worker', folder: 'worker-scoop' });

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
  it('unmounts the composer band when a scoop is selected and restores it for a cone', () => {
    const boot = bootShell();

    boot.selectScoop(cone);
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);

    boot.selectScoop(worker);
    // `hidden` on `<slicc-composer>` is `display:none` in the component's own
    // sheet — the queued pile, model picker, thinking pill, dictation and
    // attachments all live inside it, so nothing is left and nothing is
    // reserved.
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(true);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(true);

    boot.selectScoop(cone);
    expect(boot.refs.composer.hasAttribute('hidden')).toBe(false);
    expect(boot.refs.inputCard.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the composer text across a scoop round trip', () => {
    const boot = bootShell();
    boot.selectScoop(cone);
    (boot.refs.inputCard as HTMLElement & { value: string }).value = 'half-written thought';

    boot.selectScoop(worker);
    boot.selectScoop(cone);

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
        live = [];
        return stashed;
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

    boot.selectScoop(cone);
    boot.selectScoop(worker);
    // Nothing was cancelled on the backend: there is nowhere else to talk, so
    // reading a scoop is not the user abandoning the prompt.
    expect(client.deleteQueuedMessage.mock.calls).toHaveLength(0);
    expect(controller.stashQueued).toHaveBeenCalledOnce();

    boot.selectScoop(cone);
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
        live = [];
        return stashed;
      }),
      restoreQueued: vi.fn(),
      setLickBackpressure: vi.fn(),
      setProcessing: vi.fn(),
      setReadOnly: vi.fn(),
    } as never);
    const client = boot.wiring.getClient() as unknown as {
      deleteQueuedMessage: { mock: { calls: unknown[][] } };
    };
    const other = unit({
      jid: 'cone-2',
      name: 'research',
      folder: 'cone-research',
      parentJid: null,
    });

    boot.selectScoop(cone);
    boot.selectScoop(worker);
    boot.selectScoop(other);

    expect(client.deleteQueuedMessage.mock.calls).toEqual([['cone-1', 'q1']]);
  });

  it('keeps the scoop shell mood — only the interactive chrome goes away', () => {
    const boot = bootShell();
    boot.selectScoop(worker);
    expect(boot.refs.shader.getAttribute('mode')).toBe('scoop');
    expect(boot.refs.shader.getAttribute('tint')).toBeTruthy();
    expect(boot.refs.thread.getAttribute('context')).toBe('scoop:worker');
  });

  it('opens the read-only view for a `scoop:<name>` URL context', async () => {
    const { unitForContext } = await import('../../../src/ui/wc/wc-unit-context.js');
    const boot = bootShell();
    const addressed = unitForContext([cone, worker], 'scoop:worker');
    expect(addressed?.jid).toBe('scoop-1');

    boot.selectScoop(addressed as RegisteredScoop);

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

    boot.selectScoop(worker);

    expect(order).toEqual(['readOnly=true', 'requestMessages']);
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
