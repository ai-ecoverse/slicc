import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLocalBridgeAcceptsToken,
  STALE_BRIDGE_TOKEN_CODE,
  STALE_BRIDGE_TOKEN_MESSAGE,
  StaleBridgeTokenError,
  setBridgeToken,
  setLocalApiBaseUrl,
  throwIfStaleBridgeToken,
} from '../../src/base/api-endpoint.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('throwIfStaleBridgeToken', () => {
  it('rejects the launcher-restarted token body', async () => {
    const response = jsonResponse(403, { error: 'bridge-token-required' });
    await expect(throwIfStaleBridgeToken(response)).rejects.toBeInstanceOf(StaleBridgeTokenError);
    await expect(
      throwIfStaleBridgeToken(jsonResponse(403, { error: 'bridge-token-required' }))
    ).rejects.toMatchObject({
      code: STALE_BRIDGE_TOKEN_CODE,
      message: STALE_BRIDGE_TOKEN_MESSAGE,
    });

    await expect(response.json()).resolves.toEqual({ error: 'bridge-token-required' });
  });

  it('ignores other 403s and non-403 failures', async () => {
    await expect(
      throwIfStaleBridgeToken(jsonResponse(403, { error: 'forbidden' }))
    ).resolves.toBeUndefined();
    await expect(
      throwIfStaleBridgeToken(jsonResponse(401, { error: 'bridge-token-required' }))
    ).resolves.toBeUndefined();
    await expect(
      throwIfStaleBridgeToken(new Response('nope', { status: 403 }))
    ).resolves.toBeUndefined();
  });
});

describe('assertLocalBridgeAcceptsToken', () => {
  afterEach(() => {
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  it('does nothing when this realm has no bridge token', async () => {
    const fetchImpl = vi.fn();
    await assertLocalBridgeAcceptsToken(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when /api/status says the token is no longer accepted', async () => {
    setLocalApiBaseUrl('http://127.0.0.1:5710');
    setBridgeToken('stale-token');
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'bridge-token-required' }));

    await expect(
      assertLocalBridgeAcceptsToken(fetchImpl as unknown as typeof fetch)
    ).rejects.toBeInstanceOf(StaleBridgeTokenError);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5710/api/status',
      expect.objectContaining({
        cache: 'no-store',
        headers: { 'X-Bridge-Token': 'stale-token' },
      })
    );
  });

  it('resolves on a healthy status and on a bridge that is simply down', async () => {
    setLocalApiBaseUrl('http://127.0.0.1:5710');
    setBridgeToken('live-token');
    const ok = vi.fn(async () => jsonResponse(200, { service: 'slicc-server' }));
    await expect(
      assertLocalBridgeAcceptsToken(ok as unknown as typeof fetch)
    ).resolves.toBeUndefined();

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      assertLocalBridgeAcceptsToken(down as unknown as typeof fetch)
    ).resolves.toBeUndefined();

    const other403 = vi.fn(async () => jsonResponse(403, { error: 'nope' }));
    await expect(
      assertLocalBridgeAcceptsToken(other403 as unknown as typeof fetch)
    ).resolves.toBeUndefined();
  });
});
