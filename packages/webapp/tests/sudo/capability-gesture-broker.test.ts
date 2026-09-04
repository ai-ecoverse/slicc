/**
 * Tests for `createCapabilityGestureSudoBroker` (#2276 slice C) — the raw
 * native-gesture hop, now wrapping the injected `CapabilityBroker`'s
 * `approvals.request` instead of a topology-specific transport. Replaces
 * the deleted `http-broker.test.ts` / `extension-broker.test.ts` /
 * `panel-rpc-broker.test.ts`: those exercised three DIFFERENT transports
 * behind the SAME shape (suggest, abort-check, transport, fail-closed
 * normalize) — this file exercises that one shared shape once, against a
 * scripted `CapabilityBroker` instead of `fetch` / `chrome.runtime` /
 * panel-RPC.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityGestureSudoBroker } from '../../src/sudo/capability-gesture-broker.js';
import type { SudoRequest } from '../../src/sudo/types.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CapabilityBroker,
  CapabilityResult,
} from '../../src/work-unit/capability/index.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };
const suggest = vi.fn(async () => 'git push*');

function fakeBroker(
  request: (req: ApprovalRequest) => CapabilityResult<ApprovalDecision>
): CapabilityBroker {
  return {
    adapter: 'node-rest',
    approvals: {
      allowlist: ['request'],
      supports: () => true,
      request: async (req: ApprovalRequest) => request(req),
      resolve: async () => {
        throw new Error('not used by this test');
      },
    },
  } as unknown as CapabilityBroker;
}

describe('createCapabilityGestureSudoBroker', () => {
  beforeEach(() => {
    suggest.mockClear();
  });

  it('does not call the broker when the caller aborted while the suggester was slow', async () => {
    const controller = new AbortController();
    const request = vi.fn(
      (_req: ApprovalRequest) => ({ ok: true, value: { decision: 'allow' } }) as const
    );
    const slowSuggest = vi.fn(async () => {
      controller.abort();
      return 'git push*';
    });
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), {
      suggest: slowSuggest,
    });

    expect(await broker.requestApproval(REQ, { signal: controller.signal })).toEqual({
      decision: 'deny',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('forwards the abort signal to the broker call', async () => {
    const controller = new AbortController();
    const request = vi.fn(
      (_req: ApprovalRequest) => ({ ok: true, value: { decision: 'allow' } }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    await broker.requestApproval(REQ, { signal: controller.signal });
    expect(request.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it('short-circuits the suggester when the request already carries one (tray-first pre-populates it)', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) => ({ ok: true, value: { decision: 'allow' } }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    await broker.requestApproval({ ...REQ, suggestedPattern: 'already-suggested*' });
    expect(suggest).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[0]?.suggestedPattern).toBe('already-suggested*');
  });

  it('calls the broker with the suggested pattern and returns the decision as-is', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) => ({ ok: true, value: { decision: 'allow' } }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'allow' });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'command',
        detail: 'git push origin main',
        suggestedPattern: 'git push*',
      })
    );
  });

  it('passes through an always decision with its pattern — the adapter already normalized it', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) =>
        ({ ok: true, value: { decision: 'always', pattern: 'git push*' } }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('forwards requester and approver when present', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) => ({ ok: true, value: { decision: 'allow' } }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    await broker.requestApproval({
      ...REQ,
      requester: 'guest-42',
      approver: { kind: 'cone', unitJid: 'cone_1' },
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      requester: 'guest-42',
      approver: { kind: 'cone', unitJid: 'cone_1' },
    });
  });

  it('denies on a CapabilityFailure (transport reached but the call did not succeed)', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) =>
        ({
          ok: false,
          reason: 'failed',
          capability: 'approvals',
          operation: 'request',
          message: 'sudo endpoint returned 500',
        }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on CapabilityUnavailable (no transport for this float at all)', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) =>
        ({
          ok: false,
          reason: 'unavailable',
          capability: 'approvals',
          operation: 'request',
          message: 'connect topology has no privileged surface',
        }) as const
    );
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), { suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies (fails closed) when no CapabilityBroker was ever injected, without constructing any transport', async () => {
    const broker = createCapabilityGestureSudoBroker(null, { suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('falls back to req.detail when the suggester throws', async () => {
    const request = vi.fn(
      (_req: ApprovalRequest) => ({ ok: true, value: { decision: 'allow' } }) as const
    );
    const throwingSuggest = vi.fn(async () => {
      throw new Error('quickLabel unavailable');
    });
    const broker = createCapabilityGestureSudoBroker(fakeBroker(request), {
      suggest: throwingSuggest,
    });
    await broker.requestApproval(REQ);
    expect(request.mock.calls[0]?.[0]?.suggestedPattern).toBe(REQ.detail);
  });
});
