/**
 * A delegated approver scoop must only see and settle what was routed to it.
 * Without the scope, marking a scoop as an approver handed it every cone's
 * pending requests — to read, to settle, and to persist `always` grants for.
 */
import { describe, expect, it, vi } from 'vitest';
import { ScoopApprovalRouter } from '../../src/scoops/scoop-approval-router.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

function unit(jid: string, name: string, parentJid: string | null): RegisteredScoop {
  return {
    jid,
    name,
    folder: name,
    requiresTrigger: false,
    assistantLabel: name,
    addedAt: '2026-08-27T00:00:00.000Z',
    parentJid,
  } as RegisteredScoop;
}

function harness(approver: RegisteredScoop, scoops: RegisteredScoop[]) {
  const map = new Map(scoops.map((s) => [s.jid, s]));
  const router = new ScoopApprovalRouter({
    getScoops: () => map,
    findApprover: () => approver,
    getSudoManager: () => null,
    getLickManager: () => null,
    handleMessage: vi.fn(async () => {}),
    onMessageUpdate: vi.fn(),
    getMessagesForScoop: vi.fn(async () => []),
    saveMessage: vi.fn(async () => {}),
  });
  return router;
}

describe('delegated approver scoping', () => {
  it('shows a delegated approver only its own pending requests', async () => {
    const reviewer = unit('scoop_reviewer', 'reviewer', 'cone_1');
    const other = unit('scoop_other', 'other', 'cone_1');
    const asker = unit('cone_1', 'cone', null);
    const router = harness(reviewer, [reviewer, other, asker]);

    void router.enqueueSudoRequest('cone_1', { kind: 'guest-tool', detail: 'mine' });

    expect(router.listPendingSudoRequests('scoop_reviewer')).toHaveLength(1);
    // Another delegated approver sees nothing of it.
    expect(router.listPendingSudoRequests('scoop_other')).toHaveLength(0);
    // A root approver stays unrestricted, as cones have always been.
    expect(router.listPendingSudoRequests()).toHaveLength(1);
  });

  it('refuses a settle from a unit the request was not routed to', async () => {
    const reviewer = unit('scoop_reviewer', 'reviewer', 'cone_1');
    const asker = unit('cone_1', 'cone', null);
    const router = harness(reviewer, [reviewer, asker]);

    void router.enqueueSudoRequest('cone_1', { kind: 'guest-tool', detail: 'mine' });
    const [pending] = router.listPendingSudoRequests();

    expect(router.resolveSudoRequest(pending.id, { decision: 'allow' }, 'scoop_impostor')).toBe(
      false
    );
    // Still pending — the impostor changed nothing.
    expect(router.listPendingSudoRequests()).toHaveLength(1);

    expect(router.resolveSudoRequest(pending.id, { decision: 'allow' }, 'scoop_reviewer')).toBe(
      true
    );
  });

  it('refuses settle+persist from the wrong unit before any side effect', async () => {
    const reviewer = unit('scoop_reviewer', 'reviewer', 'cone_1');
    const asker = unit('cone_1', 'cone', null);
    const router = harness(reviewer, [reviewer, asker]);

    void router.enqueueSudoRequest('cone_1', { kind: 'command', detail: 'rm -rf /' });
    const [pending] = router.listPendingSudoRequests();

    const result = await router.resolveSudoRequestAndPersist(
      pending.id,
      { decision: 'always', pattern: '*' },
      'scoop_impostor'
    );
    // A durable grant written on behalf of a requester it has nothing to do
    // with is the worst version of this bug.
    expect(result).toEqual({ settled: false, persisted: false });
  });
});
