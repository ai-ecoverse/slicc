/**
 * Tests for the CLI/standalone HTTP sudo broker. `fetch` and the pattern
 * suggester are injected so transport and fail-closed paths are deterministic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBridgeToken, setLocalApiBaseUrl } from '../../src/shell/proxied-fetch.js';
import { createHttpSudoBroker } from '../../src/sudo/http-broker.js';
import { SUDO_APPROVE_PATH, type SudoRequest } from '../../src/sudo/types.js';

afterEach(() => {
  setLocalApiBaseUrl(null);
  setBridgeToken(null);
});

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const suggest = vi.fn(async () => 'git push*');

describe('createHttpSudoBroker', () => {
  it('POSTs the request with the suggested pattern and returns the decision', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'allow' });
    expect(fetchImpl).toHaveBeenCalledWith(
      SUDO_APPROVE_PATH,
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      kind: 'command',
      detail: 'git push origin main',
      suggestedPattern: 'git push*',
    });
  });

  it('passes through an always decision with its pattern', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'always', pattern: 'git push*' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('fills an always decision missing a pattern with the suggested default', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'always' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('denies on a non-OK status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }, false, 500));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on a transport error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on an unrecognized decision shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'maybe' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('still POSTs when the suggester throws (uses detail)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({
      fetchImpl,
      suggest: vi.fn(async () => {
        throw new Error('llm down');
      }),
    });
    await broker.requestApproval(REQ);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.suggestedPattern).toBe('git push origin main');
  });
});

describe('createHttpSudoBroker — thin-bridge URL + token', () => {
  it('legacy / same-origin: POSTs the relative path with no X-Bridge-Token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    await broker.requestApproval(REQ);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SUDO_APPROVE_PATH);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('thin-bridge: POSTs to the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    await broker.requestApproval(REQ);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5710/api/sudo-approve');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBe('abc-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('thin-bridge: base set but no token → absolute URL, still no X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    await broker.requestApproval(REQ);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5710/api/sudo-approve');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
  });

  it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
    setBridgeToken('abc-123');
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    await broker.requestApproval(REQ);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SUDO_APPROVE_PATH);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
  });
});
