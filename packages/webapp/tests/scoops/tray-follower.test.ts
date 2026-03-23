import { describe, expect, it, vi } from 'vitest';

import {
  attachTrayFollower,
  normalizeFollowerAttachResponse,
  pollTrayFollowerBootstrap,
  retryTrayFollowerBootstrap,
  sendTrayFollowerAnswer,
} from '../../src/scoops/tray-follower.js';

describe('tray-follower', () => {
  it('posts the follower join request and normalizes wait responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          trayId: 'tray-1',
          controllerId: 'follower-1',
          role: 'follower',
          leader: null,
          participantCount: 1,
          result: { action: 'wait', code: 'LEADER_NOT_ELECTED', retryAfterMs: 1000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const plan = await attachTrayFollower({
      joinUrl: 'https://tray.example.com/join/token',
      controllerId: 'follower-1',
      runtime: 'electron',
      fetchImpl,
    });

    expect(plan).toEqual({
      trayId: 'tray-1',
      controllerId: 'follower-1',
      participantCount: 1,
      leader: null,
      action: 'wait',
      code: 'LEADER_NOT_ELECTED',
      retryAfterMs: 1000,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tray.example.com/join/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follower-1', runtime: 'electron' }),
      })
    );
  });

  it('preserves signal and fail outcomes without assuming a follower websocket', () => {
    expect(
      normalizeFollowerAttachResponse({
        trayId: 'tray-1',
        controllerId: 'follower-2',
        role: 'follower',
        leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
        participantCount: 2,
        result: {
          action: 'signal',
          code: 'LEADER_CONNECTED',
          bootstrap: {
            controllerId: 'follower-2',
            bootstrapId: 'bootstrap-1',
            attempt: 1,
            state: 'pending',
            expiresAt: '2026-03-11T00:00:20.000Z',
            cursor: 0,
            maxRetries: 3,
            retriesRemaining: 3,
            retryAfterMs: null,
            failure: null,
          },
        },
      })
    ).toEqual({
      trayId: 'tray-1',
      controllerId: 'follower-2',
      participantCount: 2,
      leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
      action: 'signal',
      code: 'LEADER_CONNECTED',
      bootstrap: {
        controllerId: 'follower-2',
        bootstrapId: 'bootstrap-1',
        attempt: 1,
        state: 'pending',
        expiresAt: '2026-03-11T00:00:20.000Z',
        cursor: 0,
        maxRetries: 3,
        retriesRemaining: 3,
        retryAfterMs: null,
        failure: null,
      },
    });

    expect(
      normalizeFollowerAttachResponse({
        trayId: 'tray-1',
        controllerId: 'follower-2',
        role: 'follower',
        leader: {
          controllerId: 'leader-1',
          connected: false,
          reconnectDeadline: '2026-03-11T01:00:00.000Z',
        },
        participantCount: 2,
        result: {
          action: 'fail',
          code: 'TRAY_EXPIRED',
          error: 'Tray expired because the leader did not reclaim it within one hour',
        },
      })
    ).toEqual({
      trayId: 'tray-1',
      controllerId: 'follower-2',
      participantCount: 2,
      leader: {
        controllerId: 'leader-1',
        connected: false,
        reconnectDeadline: '2026-03-11T01:00:00.000Z',
      },
      action: 'fail',
      code: 'TRAY_EXPIRED',
      error: 'Tray expired because the leader did not reclaim it within one hour',
    });
  });

  it('rejects malformed worker responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(
      attachTrayFollower({
        joinUrl: 'https://tray.example.com/join/token',
        fetchImpl,
      })
    ).rejects.toThrow('Tray follower attach returned an invalid response (200)');
  });

  it('posts follower bootstrap poll, answer, and retry actions', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'follower-1',
            role: 'follower',
            leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
            participantCount: 2,
            bootstrap: {
              controllerId: 'follower-1',
              bootstrapId: 'bootstrap-1',
              attempt: 1,
              state: 'offered',
              expiresAt: '2026-03-11T00:00:20.000Z',
              cursor: 1,
              maxRetries: 3,
              retriesRemaining: 3,
              retryAfterMs: null,
              failure: null,
            },
            events: [
              {
                sequence: 1,
                sentAt: '2026-03-11T00:00:01.000Z',
                type: 'bootstrap.offer',
                offer: { type: 'offer', sdp: 'v=0' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'follower-1',
            role: 'follower',
            leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
            participantCount: 2,
            bootstrap: {
              controllerId: 'follower-1',
              bootstrapId: 'bootstrap-1',
              attempt: 1,
              state: 'connected',
              expiresAt: '2026-03-11T00:00:20.000Z',
              cursor: 1,
              maxRetries: 3,
              retriesRemaining: 3,
              retryAfterMs: null,
              failure: null,
            },
            events: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'follower-1',
            role: 'follower',
            leader: { controllerId: 'leader-1', connected: true, reconnectDeadline: null },
            participantCount: 2,
            bootstrap: {
              controllerId: 'follower-1',
              bootstrapId: 'bootstrap-2',
              attempt: 2,
              state: 'pending',
              expiresAt: '2026-03-11T00:00:42.000Z',
              cursor: 0,
              maxRetries: 3,
              retriesRemaining: 2,
              retryAfterMs: null,
              failure: null,
            },
            events: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const poll = await pollTrayFollowerBootstrap({
      joinUrl: 'https://tray.example.com/join/token',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      cursor: 0,
      fetchImpl,
    });
    expect(poll.events).toEqual([
      {
        sequence: 1,
        sentAt: '2026-03-11T00:00:01.000Z',
        type: 'bootstrap.offer',
        offer: { type: 'offer', sdp: 'v=0' },
      },
    ]);

    const answer = await sendTrayFollowerAnswer({
      joinUrl: 'https://tray.example.com/join/token',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      answer: { type: 'answer', sdp: 'v=0' },
      fetchImpl,
    });
    expect(answer.bootstrap.state).toBe('connected');

    const retry = await retryTrayFollowerBootstrap({
      joinUrl: 'https://tray.example.com/join/token',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      runtime: 'electron',
      fetchImpl,
    });
    expect(retry.bootstrap).toMatchObject({
      bootstrapId: 'bootstrap-2',
      attempt: 2,
      retriesRemaining: 2,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://tray.example.com/join/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'poll',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          cursor: 0,
        }),
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://tray.example.com/join/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'answer',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          answer: { type: 'answer', sdp: 'v=0' },
        }),
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://tray.example.com/join/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'retry',
          controllerId: 'follower-1',
          bootstrapId: 'bootstrap-1',
          runtime: 'electron',
        }),
      })
    );
  });
});
