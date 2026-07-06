import { describe, expect, it } from 'vitest';
import type {
  FollowerBootstrapRequest,
  LeaderToWorkerControlMessage,
  WorkerToLeaderControlMessage,
} from '../src/tray-signaling.js';
import {
  TRAY_BOOTSTRAP_MAX_RETRIES,
  TRAY_BOOTSTRAP_RETRY_AFTER_MS,
  TRAY_BOOTSTRAP_TIMEOUT_MS,
} from '../src/tray-signaling.js';

describe('tray signaling contract', () => {
  it('pins the bootstrap retry policy constants', () => {
    expect(TRAY_BOOTSTRAP_TIMEOUT_MS).toBe(20_000);
    expect(TRAY_BOOTSTRAP_MAX_RETRIES).toBe(3);
    expect(TRAY_BOOTSTRAP_RETRY_AFTER_MS).toBe(1_000);
  });

  it('round-trips representative control messages through JSON', () => {
    const leaderMessages: LeaderToWorkerControlMessage[] = [
      { type: 'ping' },
      {
        type: 'bootstrap.offer',
        controllerId: 'c1',
        bootstrapId: 'b1',
        offer: { type: 'offer', sdp: 'v=0' },
      },
      { type: 'bridge.close', connId: 'conn1' },
    ];
    const workerMessages: WorkerToLeaderControlMessage[] = [
      { type: 'pong', trayId: 't1' },
      {
        type: 'webhook.event',
        webhookId: 'w1',
        headers: { 'content-type': 'application/json' },
        body: { hello: true },
        timestamp: '2026-07-06T00:00:00Z',
      },
    ];
    const followerRequests: FollowerBootstrapRequest[] = [
      { action: 'poll', controllerId: 'c1', bootstrapId: 'b1', cursor: 0 },
      { action: 'retry', runtime: 'ios' },
    ];

    for (const message of [...leaderMessages, ...workerMessages, ...followerRequests]) {
      let roundTripped: unknown;
      try {
        roundTripped = JSON.parse(JSON.stringify(message)) as unknown;
      } catch {
        roundTripped = undefined; // the expect below fails loudly
      }
      expect(roundTripped).toEqual(message);
    }
  });
});
