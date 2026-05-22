import { describe, expect, it, vi } from 'vitest';
import { findSliccPageTarget, restartLeader } from '../src/leader-restart.js';

describe('findSliccPageTarget', () => {
  it('returns the page target whose URL starts with the local URL', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'chrome://newtab/', attached: true },
      {
        id: 'b',
        type: 'page',
        url: 'http://localhost:5710/?runtime=hosted-leader',
        attached: true,
      },
      { id: 'c', type: 'background_page', url: 'http://localhost:5710/', attached: true },
    ];
    const t = findSliccPageTarget(targets, 'http://localhost:5710/');
    expect(t?.id).toBe('b');
  });

  it('returns null when no page target matches', () => {
    expect(findSliccPageTarget([], 'http://localhost:5710/')).toBeNull();
    expect(
      findSliccPageTarget(
        [{ id: 'a', type: 'page', url: 'chrome://newtab/', attached: true }],
        'http://localhost:5710/'
      )
    ).toBeNull();
  });

  it('prefers attached page targets when multiple match', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'http://localhost:5710/x', attached: false },
      { id: 'b', type: 'page', url: 'http://localhost:5710/y', attached: true },
    ];
    expect(findSliccPageTarget(targets, 'http://localhost:5710/')?.id).toBe('b');
  });
});

describe('restartLeader', () => {
  it('calls CDP Page.reload against the SLICC page', async () => {
    const reloads: string[] = [];
    const fakeCdp = {
      send: vi.fn(async (method: string, _params: unknown, sessionId?: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'tgt',
                type: 'page',
                url: 'http://localhost:5710/?runtime=hosted-leader',
                attached: true,
              },
            ],
          };
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'sess' };
        if (method === 'Page.reload') {
          reloads.push(sessionId ?? 'none');
          return {};
        }
        return {};
      }),
    };
    const result = await restartLeader(fakeCdp, 'http://localhost:5710/');
    expect(result.ok).toBe(true);
    expect(reloads).toEqual(['sess']);
  });

  it('returns 503 NO_LEADER_TAB shape when no SLICC page exists', async () => {
    const fakeCdp = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      }),
    };
    const result = await restartLeader(fakeCdp, 'http://localhost:5710/');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_LEADER_TAB');
  });
});

describe('registerLeaderRestartEndpoint — localhost guard', () => {
  it('returns 403 for a non-loopback remoteAddress', async () => {
    // Same synthetic-request approach as the cloud-status 403 test;
    // requireLoopback is shared from cloud-status.ts.
    const { requireLoopback } = await import('../src/cloud-status.js');
    let statusCode = 0;
    let body: unknown = null;
    const req = { socket: { remoteAddress: '10.0.0.5' } } as never;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as never;
    let nextCalled = false;
    requireLoopback(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: 'localhost only' });
  });
});
