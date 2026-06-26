/**
 * Regression reproduction for issue #1181:
 * "Adobe session expired surfaces as unrecoverable cone error when token
 *  expires mid-session in worker realm".
 *
 * Bug chain being reproduced:
 *  1. The kernel-worker realm has no DOM, so `typeof window === 'undefined'`.
 *  2. When the locally-cached IMS token has crossed its `tokenExpiresAt`
 *     boundary, `getValidAccessToken` (providers/adobe.ts) calls
 *     `silentRenewToken`, which short-circuits with `return null` because it
 *     cannot drive the IMS popup/iframe flow without a `window`.
 *  3. With no renewed token, `getValidAccessToken` throws the literal
 *     `Adobe session expired — please log in again` — this is the raw stream
 *     error RUM records under `source: llm`.
 *  4. `isNonRetryableError` (scoops/scoop-context.ts) matches the
 *     `session expired|log in again` pattern, so the cone's
 *     `handleNonRetryableError` skips retry and re-emits the SAME message
 *     wrapped as `Scoop "Cone" failed with unrecoverable error: …` under
 *     `source: scoop:cone` — the second RUM fingerprint.
 *
 * This file does NOT fix the bug; it pins the failing behavior so the eventual
 * fix (a worker→page silent-renew RPC, per the issue) has a reproduction to
 * flip. The vitest `webapp` project runs in the `node` environment, which has
 * no `window`, so the worker-realm condition holds with no extra setup.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isNonRetryableError } from '../../src/scoops/scoop-context.js';

// Map-backed localStorage shim — mirrors how the kernel worker reads the
// `slicc_accounts` token replica the page pushed in before boot.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

const SESSION_EXPIRED = 'Adobe session expired — please log in again';

/** Seed the `slicc_accounts` replica with a single Adobe account. */
function seedAdobeAccount(tokenExpiresAt: number): void {
  storage.set(
    'slicc_accounts',
    JSON.stringify([
      {
        providerId: 'adobe',
        apiKey: 'cached-access-token',
        accessToken: 'cached-access-token',
        tokenExpiresAt,
      },
    ])
  );
}

describe('issue #1181: Adobe session expiry in the worker realm', () => {
  beforeEach(() => storage.clear());

  it('has no DOM — the worker-realm precondition the bug depends on', () => {
    expect(typeof window).toBe('undefined');
  });

  it('throws the literal session-expired error when an expired token cannot be silently renewed', async () => {
    seedAdobeAccount(Date.now() - 60_000); // expired one minute ago
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    // This is the raw stream error RUM records under `source: llm`.
    await expect(getValidAccessToken()).rejects.toThrow(SESSION_EXPIRED);
  });

  it('classifies the surfaced error as non-retryable, producing the wrapped cone error', async () => {
    seedAdobeAccount(Date.now() - 60_000);
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    const message = await getValidAccessToken().then(
      () => {
        throw new Error('expected getValidAccessToken to reject');
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    // The cone treats this as terminal (no retry, no live re-auth) ...
    expect(isNonRetryableError(message)).toBe(true);

    // ... and re-emits the SAME text wrapped under `source: scoop:cone`.
    // Mirrors ScoopContext.handleNonRetryableError's fatal-error format.
    const wrapped = `Scoop "Cone" failed with unrecoverable error: ${message}`;
    expect(wrapped).toBe(
      'Scoop "Cone" failed with unrecoverable error: Adobe session expired — please log in again'
    );
  });

  it('control: a still-valid token is returned without attempting renewal', async () => {
    seedAdobeAccount(Date.now() + 10 * 60_000); // 10 minutes of headroom
    const { getValidAccessToken } = await import('../../providers/adobe.js');

    await expect(getValidAccessToken()).resolves.toBe('cached-access-token');
  });
});
