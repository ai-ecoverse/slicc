/**
 * HTTP-surface tests for the biscotto mint/revoke/list routes.
 *
 * The DO half is covered by `biscotto.test.ts` (lifecycle) and
 * `biscotto-join.test.ts` (join path); this file covers the edge handlers —
 * bearer extraction, body validation, and exactly what gets forwarded inward.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  handleBiscottoList,
  handleBiscottoMint,
  handleBiscottoStop,
} from '../src/biscotto-routes.js';

const HOST = 'https://www.sliccy.ai';

function stub() {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    fetch: vi.fn(async (request: Request) => {
      calls.push({ url: request.url, body: await request.json() });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  };
}

function post(body: unknown, auth?: string): Request {
  return new Request(`${HOST}/api/tray/t1/biscotto`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleBiscottoMint', () => {
  it('forwards the controller bearer and the derived worker base URL', async () => {
    const tray = stub();
    const res = await handleBiscottoMint(post({ label: 'Anna' }, 'Bearer tok-1'), tray);

    expect(res.status).toBe(200);
    expect(tray.calls[0].url).toBe('https://internal/internal/biscotto/mint');
    expect(tray.calls[0].body).toMatchObject({
      controllerToken: 'tok-1',
      label: 'Anna',
      workerBaseUrl: HOST,
    });
  });

  it('401s without a bearer, and never reaches the durable object', async () => {
    const tray = stub();
    expect((await handleBiscottoMint(post({ label: 'Anna' }), tray)).status).toBe(401);
    expect((await handleBiscottoMint(post({ label: 'Anna' }, 'Basic x'), tray)).status).toBe(401);
    expect((await handleBiscottoMint(post({ label: 'Anna' }, 'Bearer   '), tray)).status).toBe(401);
    expect(tray.fetch).not.toHaveBeenCalled();
  });

  it('400s a missing or non-string label', async () => {
    const tray = stub();
    expect((await handleBiscottoMint(post({}, 'Bearer t'), tray)).status).toBe(400);
    expect((await handleBiscottoMint(post({ label: 7 }, 'Bearer t'), tray)).status).toBe(400);
    expect(tray.fetch).not.toHaveBeenCalled();
  });

  it('400s a body that is not a JSON object rather than throwing', async () => {
    // `request.json()` resolves for `null`, `[]` and `1`; reading a field off
    // the result then threw outside the catch and surfaced as an uncaught 500.
    const tray = stub();
    for (const body of ['null', '[]', '1', '"x"', 'not json at all']) {
      const res = await handleBiscottoMint(post(body, 'Bearer t'), tray);
      expect(res.status, `body ${body}`).toBe(400);
    }
    expect(tray.fetch).not.toHaveBeenCalled();
  });

  it('passes ttl and gates through untouched', async () => {
    const tray = stub();
    await handleBiscottoMint(
      post(
        { label: 'Anna', ttlMs: 3600_000, gates: { message: { approver: 'cone' } } },
        'Bearer t'
      ),
      tray
    );
    expect(tray.calls[0].body).toMatchObject({
      ttlMs: 3600_000,
      gates: { message: { approver: 'cone' } },
    });
  });
});

describe('handleBiscottoStop', () => {
  it('forwards the seat id', async () => {
    const tray = stub();
    const res = await handleBiscottoStop(post({ id: 'seat1' }, 'Bearer tok-1'), tray);
    expect(res.status).toBe(200);
    expect(tray.calls[0].url).toBe('https://internal/internal/biscotto/stop');
    expect(tray.calls[0].body).toEqual({ controllerToken: 'tok-1', id: 'seat1' });
  });

  it('401s without a bearer and 400s without an id', async () => {
    const tray = stub();
    expect((await handleBiscottoStop(post({ id: 'seat1' }), tray)).status).toBe(401);
    expect((await handleBiscottoStop(post({}, 'Bearer t'), tray)).status).toBe(400);
    expect((await handleBiscottoStop(post({ id: '' }, 'Bearer t'), tray)).status).toBe(400);
    expect((await handleBiscottoStop(post('null', 'Bearer t'), tray)).status).toBe(400);
    expect(tray.fetch).not.toHaveBeenCalled();
  });
});

describe('handleBiscottoList', () => {
  it('re-posts the bearer inward because the DO only speaks fetch', async () => {
    const tray = stub();
    const res = await handleBiscottoList(
      new Request(`${HOST}/api/tray/t1/biscotti`, { headers: { authorization: 'Bearer tok-1' } }),
      tray
    );
    expect(res.status).toBe(200);
    expect(tray.calls[0].url).toBe('https://internal/internal/biscotto/list');
    expect(tray.calls[0].body).toEqual({ controllerToken: 'tok-1' });
  });

  it('401s without a bearer', async () => {
    const tray = stub();
    const res = await handleBiscottoList(new Request(`${HOST}/api/tray/t1/biscotti`), tray);
    expect(res.status).toBe(401);
    expect(tray.fetch).not.toHaveBeenCalled();
  });
});
