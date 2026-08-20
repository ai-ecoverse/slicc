/**
 * Router-level settle paths for cone-mediated sudo requests.
 *
 * When a request is settled fail-closed WITHOUT a cone decision — the
 * per-request timer fires (`expired`), the requesting scoop is dropped
 * (`scoop-dropped`), or the orchestrator shuts down (`shutdown`) — the stored
 * `sudo-request` lick card must flip off `pending` to `dismissed`, and the cone
 * must NOT be re-prompted (no second `handleMessage` delivery).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ScoopApprovalRouter,
  type ScoopApprovalRouterDeps,
} from '../../src/scoops/scoop-approval-router.js';
import type { ChannelMessage, RegisteredScoop } from '../../src/scoops/types.js';
import { CONE_SUDO_TIMEOUT_MS } from '../../src/sudo/index.js';
import type { SudoManager } from '../../src/sudo/sudo-manager.js';
import type { SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function scoop(jid: string, isCone: boolean): RegisteredScoop {
  return {
    jid,
    name: jid,
    folder: `${jid}-folder`,
    isCone,
    type: isCone ? 'cone' : 'scoop',
    requiresTrigger: false,
    assistantLabel: jid,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeHarness(sudoManager: SudoManager | null = null) {
  const cone = scoop('cone_jid', true);
  const requester = scoop('scoop_a', false);
  const scoops = new Map<string, RegisteredScoop>([
    [cone.jid, cone],
    [requester.jid, requester],
  ]);
  const store: ChannelMessage[] = [];
  const handleMessage = vi.fn(async (msg: ChannelMessage) => {
    store.push(msg);
  });
  const saveMessage = vi.fn(async (msg: ChannelMessage) => {
    const i = store.findIndex((m) => m.id === msg.id);
    if (i >= 0) store[i] = msg;
    else store.push(msg);
  });
  const onMessageUpdate = vi.fn();
  const deps: ScoopApprovalRouterDeps = {
    getScoops: () => scoops,
    getSudoManager: () => sudoManager,
    getLickManager: () => null,
    handleMessage,
    onMessageUpdate,
    getMessagesForScoop: async (jid) => store.filter((m) => m.chatJid === jid),
    saveMessage,
  };
  return { router: new ScoopApprovalRouter(deps), store, handleMessage, onMessageUpdate };
}

describe('ScoopApprovalRouter persistence settlement', () => {
  it('claims the request before awaiting a durable rule write', async () => {
    let finishAppend: (pattern: string) => void = () => {};
    const appendScoopRule = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishAppend = resolve;
        })
    );
    const sudoManager = { appendScoopRule } as unknown as SudoManager;
    const h = makeHarness(sudoManager);
    const pendingDecision = h.router.enqueueSudoRequest('scoop_a', {
      kind: 'read',
      detail: '/recordings/first.har',
    });
    await flush();
    const [{ id }] = h.router.listPendingSudoRequests();

    const resultPromise = h.router.resolveSudoRequestAndPersist(id, {
      decision: 'always',
      pattern: '/recordings/**',
    });

    expect(appendScoopRule).toHaveBeenCalledOnce();
    expect(h.router.failAll()).toBe(0);
    await expect(pendingDecision).resolves.toEqual({
      decision: 'always',
      pattern: '/recordings/**',
    });

    finishAppend('/recordings/**');
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ settled: true, persisted: true })
    );
  });
});

describe('ScoopApprovalRouter settle paths flip the lick card off pending', () => {
  it('scoop-dropped: failScoop flips the stored card to dismissed', async () => {
    const h = makeHarness();
    const decision = h.router.enqueueSudoRequest('scoop_a', REQ);
    expect(h.store[0].lickState).toBe('pending');

    expect(h.router.failScoop('scoop_a')).toBe(1);
    await flush();

    expect(h.store[0].lickState).toBe('dismissed');
    expect(h.onMessageUpdate).toHaveBeenCalledWith(
      'cone_jid',
      expect.objectContaining({ lickId: h.store[0].lickId, lickState: 'dismissed' })
    );
    // Only the original delivery — settling must not re-prompt the cone.
    expect(h.handleMessage).toHaveBeenCalledTimes(1);
    await expect(decision).resolves.toEqual({ decision: 'deny' });
  });

  it('shutdown: failAll flips the stored card to dismissed', async () => {
    const h = makeHarness();
    const decision = h.router.enqueueSudoRequest('scoop_a', REQ);
    expect(h.store[0].lickState).toBe('pending');

    expect(h.router.failAll()).toBe(1);
    await flush();

    expect(h.store[0].lickState).toBe('dismissed');
    expect(h.onMessageUpdate).toHaveBeenCalledWith(
      'cone_jid',
      expect.objectContaining({ lickState: 'dismissed' })
    );
    expect(h.handleMessage).toHaveBeenCalledTimes(1);
    await expect(decision).resolves.toEqual({ decision: 'deny' });
  });

  it('expired: the fail-closed timer flips the stored card to dismissed', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const decision = h.router.enqueueSudoRequest('scoop_a', REQ);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.store[0].lickState).toBe('pending');

      await vi.advanceTimersByTimeAsync(CONE_SUDO_TIMEOUT_MS + 1);

      expect(h.store[0].lickState).toBe('dismissed');
      expect(h.onMessageUpdate).toHaveBeenCalledWith(
        'cone_jid',
        expect.objectContaining({ lickState: 'dismissed' })
      );
      expect(h.handleMessage).toHaveBeenCalledTimes(1);
      // Tagged `cone-timeout` so the scoop hears "the cone never answered"
      // rather than "the cone said no" — and is not told to wait for a user
      // who was never prompted. See sudo/approval-timeout.ts.
      await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'cone-timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
