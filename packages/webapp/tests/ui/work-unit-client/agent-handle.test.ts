/**
 * `createWorkUnitAgentHandle` — the one composer handle both mounts install
 * (#2382).
 *
 * The conformance suite pins what the ADAPTERS do with a send; this pins what
 * the handle does before it gets there: name the selected unit, carry the
 * controller's message id and the steer flag, refuse to guess when nothing is
 * selected, and never swallow a rejected send.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/core/agent-types.js';
import { createWorkUnitAgentHandle } from '../../../src/ui/work-unit-client/agent-handle.js';
import type { WorkUnitClient } from '../../../src/work-unit/client/types.js';

function makeClient(overrides: Partial<WorkUnitClient> = {}): {
  client: WorkUnitClient;
  send: ReturnType<typeof vi.fn>;
  signal: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => undefined);
  const signal = vi.fn(async () => undefined);
  return {
    client: { send, signal, ...overrides } as unknown as WorkUnitClient,
    send,
    signal,
  };
}

describe('createWorkUnitAgentHandle', () => {
  it('sends to the selected unit, carrying the message id and attachments', () => {
    const { client, send } = makeClient();
    const attachments = [{ id: 'att-1' }];
    const handle = createWorkUnitAgentHandle(client, {
      getSelectedId: () => 'cone_1',
      onEvent: () => () => undefined,
    });

    handle.sendMessage('hello', 'msg-1', attachments as never);

    expect(send).toHaveBeenCalledWith('cone_1', {
      attachments,
      messageId: 'msg-1',
      text: 'hello',
    });
  });

  it('carries steer and the guest gate, and omits them when absent', () => {
    const { client, send } = makeClient();
    const gate = { kind: 'biscotto' } as never;
    const handle = createWorkUnitAgentHandle(client, {
      getSelectedId: () => 'cone_1',
      onEvent: () => () => undefined,
    });

    handle.sendMessage('a', 'm1', undefined, { steer: true });
    handle.sendMessage('b', 'm2', undefined, { guestGate: gate });
    handle.sendMessage('c', 'm3');

    expect(send.mock.calls[0]?.[1]).toEqual({ messageId: 'm1', steer: true, text: 'a' });
    expect(send.mock.calls[1]?.[1]).toEqual({ guestGate: gate, messageId: 'm2', text: 'b' });
    // A non-steering, ungated send carries neither key — `false` on the wire
    // is a claim the composer never made.
    expect(send.mock.calls[2]?.[1]).toEqual({ messageId: 'm3', text: 'c' });
  });

  it('reports rather than guesses when nothing is selected', () => {
    const { client, send, signal } = makeClient();
    const onError = vi.fn();
    const handle = createWorkUnitAgentHandle(client, {
      getSelectedId: () => null,
      onError,
      onEvent: () => () => undefined,
    });

    handle.sendMessage('hello');
    handle.stop();

    // The protocol names the unit, so there is no "current" one to fall back
    // on: a dropped send the user can see beats a send to the wrong unit.
    expect(send).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('No scoop selected');
  });

  it('surfaces a refused send instead of swallowing it', async () => {
    const send = vi.fn(async () => {
      throw new Error('a guest gate cannot travel over the tray wire');
    });
    const onError = vi.fn();
    const handle = createWorkUnitAgentHandle({ send } as unknown as WorkUnitClient, {
      getSelectedId: () => 'cone_1',
      onError,
      onEvent: () => () => undefined,
    });

    handle.sendMessage('guest words', 'm1', undefined, { guestGate: {} as never });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('a guest gate cannot travel over the tray wire');
  });

  it('stops the selected unit through the protocol signal', () => {
    const { client, signal } = makeClient();
    const handle = createWorkUnitAgentHandle(client, {
      getSelectedId: () => 'scoop_9',
      onEvent: () => () => undefined,
    });

    handle.stop();

    expect(signal).toHaveBeenCalledWith('scoop_9', 'stop');
  });

  it('passes the agent event stream straight through to the transport', () => {
    const { client } = makeClient();
    const listeners = new Set<(event: AgentEvent) => void>();
    const off = vi.fn();
    const handle = createWorkUnitAgentHandle(client, {
      getSelectedId: () => 'cone_1',
      onEvent: (listener) => {
        listeners.add(listener);
        return off;
      },
    });
    const seen: AgentEvent[] = [];

    const unsubscribe = handle.onEvent((event) => seen.push(event));
    for (const listener of listeners) listener({ type: 'message_start', messageId: 'm1' });
    unsubscribe();

    // `AgentEvent` is the agent loop's vocabulary, not the client protocol's:
    // the handle must not filter or re-shape it.
    expect(seen).toEqual([{ type: 'message_start', messageId: 'm1' }]);
    expect(off).toHaveBeenCalledTimes(1);
  });
});
