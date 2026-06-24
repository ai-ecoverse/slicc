/**
 * Tests for the thin-bridge worker→page panel-RPC sudo broker. The panel-RPC
 * client and the pattern suggester are injected so the worker→page routing,
 * approve / deny / always decisions, and the fail-closed default (no reachable
 * page) are all deterministic without a real BroadcastChannel.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PanelRpcClient } from '../../src/kernel/panel-rpc.js';
import { createPanelRpcSudoBroker } from '../../src/sudo/panel-rpc-broker.js';
import type { SudoDecision, SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };
const suggest = vi.fn(async () => 'git push*');

/** Build a stub PanelRpcClient whose `call` resolves with `decision`. */
function clientReturning(decision: SudoDecision): {
  client: PanelRpcClient;
  call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(async () => ({ decision }));
  const client = {
    call,
    onEvent: () => () => {},
    registerPushTarget: () => {},
    unregisterPushTarget: () => {},
    dispose: () => {},
  } as unknown as PanelRpcClient;
  return { client, call };
}

describe('createPanelRpcSudoBroker', () => {
  it('relays the enriched request to the page and returns an approve decision', async () => {
    const { client, call } = clientReturning({ decision: 'allow' });
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'allow' });
    expect(call).toHaveBeenCalledWith(
      'sudo-request',
      { request: { ...REQ, suggestedPattern: 'git push*' } },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it('returns a deny decision from the page (cancel)', async () => {
    const { client } = clientReturning({ decision: 'deny' });
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('passes through an always decision with its pattern', async () => {
    const { client } = clientReturning({ decision: 'always', pattern: 'git push*' });
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('fills an always decision missing a pattern with the suggested default', async () => {
    const { client } = clientReturning({ decision: 'always' } as SudoDecision);
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('denies on an unrecognized decision shape', async () => {
    const { client } = clientReturning({ decision: 'maybe' } as unknown as SudoDecision);
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('fails closed (deny) when no panel-RPC client is reachable', async () => {
    const broker = createPanelRpcSudoBroker({ getClient: () => null, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('fails closed (deny) when the client lookup throws', async () => {
    const broker = createPanelRpcSudoBroker({
      getClient: () => {
        throw new Error('worker has no bridge');
      },
      suggest,
    });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('fails closed (deny) when the relay call rejects (timeout)', async () => {
    const call = vi.fn(async () => {
      throw new Error("panel-rpc: op 'sudo-request' timed out after 600000ms");
    });
    const client = {
      call,
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    } as unknown as PanelRpcClient;
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('still relays when the suggester throws (uses detail as the pattern)', async () => {
    const { client, call } = clientReturning({ decision: 'allow' });
    const broker = createPanelRpcSudoBroker({
      getClient: () => client,
      suggest: vi.fn(async () => {
        throw new Error('llm down');
      }),
    });
    await broker.requestApproval(REQ);
    expect(call.mock.calls[0][1]).toEqual({
      request: { ...REQ, suggestedPattern: 'git push origin main' },
    });
  });

  it('honors a custom timeout', async () => {
    const { client, call } = clientReturning({ decision: 'allow' });
    const broker = createPanelRpcSudoBroker({ getClient: () => client, suggest, timeoutMs: 1234 });
    await broker.requestApproval(REQ);
    expect(call.mock.calls[0][2]).toEqual({ timeoutMs: 1234 });
  });
});
