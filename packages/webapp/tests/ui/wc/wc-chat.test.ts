// @vitest-environment jsdom
/**
 * The shared chat surface (#2382 PR D2b).
 *
 * These drive `attachWcChat` directly, with a fake `WorkUnitClient` and a
 * hand-written host, because the point of the module is that it does NOT know
 * which float it is on: the same wiring has to publish a strip, select a unit,
 * submit and stop for a leader and for a follower.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { attachWcChat } from '../../../src/ui/wc/wc-chat.js';
import {
  createFollowerChatHost,
  FOLLOWER_QUEUE_CANCEL_UNSUPPORTED,
  type WcChatHost,
} from '../../../src/ui/wc/wc-chat-host.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import type {
  Unsubscribe,
  WorkUnitClient,
  WorkUnitSnapshot,
  WorkUnitSummary,
} from '../../../src/work-unit/client/types.js';

function unit(over: Partial<WorkUnitSummary> & { id: string }): WorkUnitSummary {
  return {
    assistantLabel: 'sliccy',
    fill: 0,
    folder: 'cone',
    name: 'sliccy',
    parentId: null,
    role: 'primary',
    state: 'idle',
    ...over,
  };
}

const CONE = unit({ id: 'cone-1' });
const OTHER = unit({ id: 'cone-2', folder: 'cone-research', name: 'research' });

/** A client that answers the protocol from a roster the test controls. */
function fakeClient(units: WorkUnitSummary[] = [CONE, OTHER]) {
  const listeners = new Set<(units: readonly WorkUnitSummary[]) => void>();
  const subscribers = new Map<string, Set<(event: never) => void>>();
  const asked: string[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const signalled: string[] = [];
  const client: WorkUnitClient = {
    currentUnits: () => units,
    list: () => Promise.resolve(units),
    send: (id, input) => {
      sent.push({ id, text: input.text });
      return Promise.resolve();
    },
    setModel: () => Promise.resolve(true),
    signal: (id) => {
      signalled.push(id);
      return Promise.resolve();
    },
    snapshot: (id) => {
      asked.push(id);
      return Promise.resolve({ messages: [] } as WorkUnitSnapshot);
    },
    subscribe: (id, listener): Unsubscribe => {
      const set = subscribers.get(id) ?? new Set();
      set.add(listener as never);
      subscribers.set(id, set);
      return () => set.delete(listener as never);
    },
    subscribeList: (listener): Unsubscribe => {
      listeners.add(listener);
      listener(units);
      return () => listeners.delete(listener);
    },
  };
  return {
    asked,
    client,
    push: (next: WorkUnitSummary[]) => {
      units = next;
      for (const listener of listeners) listener(units);
    },
    sent,
    signalled,
    subscriberCount: (id: string) => subscribers.get(id)?.size ?? 0,
  };
}

function testHost(over: Partial<WcChatHost> = {}): WcChatHost {
  return {
    deleteQueuedMessage: () => Promise.resolve(),
    emitAgentError: () => undefined,
    onAgentEvent: () => () => undefined,
    sendSprinkleLick: () => undefined,
    sendToolUiAction: () => undefined,
    ...over,
  };
}

function mount(units?: WorkUnitSummary[], host: WcChatHost = testHost()) {
  const app = document.createElement('div');
  document.body.append(app);
  const boot = prepareWcShell(app, 'test');
  const fake = fakeClient(units);
  const chat = attachWcChat(boot, fake.client, host);
  return { boot, chat, fake };
}

describe('attachWcChat', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('publishes the tab strip from the roster, and again when it moves', () => {
    const { boot, fake } = mount();
    // `subscribeList` fires once immediately, so the strip is never empty
    // waiting for a first change.
    expect(boot.refs.switcher.scoops.map((chip) => chip.key)).toEqual(['cone-1', 'cone-2']);

    fake.push([CONE]);
    expect(boot.refs.switcher.scoops.map((chip) => chip.key)).toEqual(['cone-1']);
  });

  it('selects the SUMMARY a tab click names, and ignores a re-click', () => {
    const { boot, fake } = mount();
    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-2' } })
    );
    expect(boot.getSelected()?.id).toBe('cone-2');
    // Selection IS the snapshot call on this protocol.
    expect(fake.asked).toEqual(['cone-2']);

    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-2' } })
    );
    // Same unit: no second ask, and no second subscription to seed from.
    expect(fake.asked).toEqual(['cone-2']);
    expect(fake.subscriberCount('cone-2')).toBe(1);
  });

  it('submits the composer to the selected unit and clears the input', () => {
    const { boot, fake } = mount();
    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-1' } })
    );
    const input = boot.refs.inputCard as HTMLElement & { value: string };
    input.value = 'ship it';
    input.dispatchEvent(new CustomEvent('submit', { detail: { value: 'ship it' } }));
    expect(fake.sent).toEqual([{ id: 'cone-1', text: 'ship it' }]);
    expect(input.value).toBe('');
  });

  it('stops only while a turn is running', () => {
    const { boot, fake } = mount();
    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-1' } })
    );
    boot.refs.inputCard.dispatchEvent(new CustomEvent('stop'));
    // Nothing is processing: a stop here would abort a turn that is not there.
    expect(fake.signalled).toEqual([]);

    boot.getController()?.setProcessing(true);
    boot.refs.inputCard.dispatchEvent(new CustomEvent('stop'));
    expect(fake.signalled).toEqual(['cone-1']);
  });

  it('takes the float’s staged attachments on submit', () => {
    const take = vi.fn(() => [{ data: 'x', id: 'a1', kind: 'image', mimeType: 'image/png' }]);
    const { boot, fake } = mount(undefined, testHost({ takeAttachments: take as never }));
    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-1' } })
    );
    const input = boot.refs.inputCard as HTMLElement & { value: string };
    // No text: an attachment alone is still a real send.
    input.dispatchEvent(new CustomEvent('submit', { detail: { value: '' } }));
    expect(take).toHaveBeenCalled();
    expect(fake.sent).toHaveLength(1);
  });

  it('addresses a send at what the HOST allows, not merely at the selection', () => {
    // A follower narrows this: until its leader has named a unit for this
    // session there is nothing to address, and a send would be dropped after
    // the bubble was already rendered.
    const errors: string[] = [];
    const { boot, fake } = mount(
      undefined,
      testHost({
        addressableUnitId: () => null,
        emitAgentError: (error) => errors.push(error),
      })
    );
    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-1' } })
    );
    const input = boot.refs.inputCard as HTMLElement & { value: string };
    input.value = 'hello?';
    input.dispatchEvent(new CustomEvent('submit', { detail: { value: 'hello?' } }));
    expect(fake.sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('createFollowerChatHost', () => {
  it('forwards a dip lick over the tray', () => {
    const sendSprinkleLick = vi.fn();
    const host = createFollowerChatHost({
      getSync: () => ({ sendSprinkleLick }),
      onAgentEvent: () => () => undefined,
      onAgentError: () => undefined,
    });
    host.sendSprinkleLick('inline', { action: 'connect' });
    expect(sendSprinkleLick).toHaveBeenCalledWith('inline', { action: 'connect' }, undefined);
  });

  it('REJECTS a backend queue cancel instead of resolving', async () => {
    // The queue belongs to the leader and the tray has no verb for it. A
    // silent success would leave the pile out of step with the backend that
    // still holds the entry.
    const host = createFollowerChatHost({
      getSync: () => null,
      onAgentEvent: () => () => undefined,
      onAgentError: () => undefined,
    });
    await expect(host.deleteQueuedMessage('cone-1', 'q1')).rejects.toThrow(
      FOLLOWER_QUEUE_CANCEL_UNSUPPORTED
    );
  });

  it('renders tool-UI cards read-only and speaks no replies', () => {
    const host = createFollowerChatHost({
      getSync: () => null,
      onAgentEvent: () => () => undefined,
      onAgentError: () => undefined,
    });
    // A follower mounts no permissions surface, so live buttons would no-op.
    expect(host.readOnlyToolUi).toBe(true);
    expect(host.speaksReplies).toBeUndefined();
    // No records at all: the thinking pill has nothing to read and keeps its
    // previous value rather than reporting reasoning as off.
    expect(host.getRecord).toBeUndefined();
  });
});
