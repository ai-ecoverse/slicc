/**
 * One APNs provider JWT for the whole worker (issue #2432).
 *
 * Apple throttles provider-token creation per (team id, key id) pair — not per
 * connection — and answers `429 TooManyProviderTokenUpdates` to anyone minting
 * more than once every 20 minutes. The tray hub runs one Durable Object *per
 * tray*, each of which used to sign its own JWT, and those DOs use WebSocket
 * hibernation: an idle tray is evicted between messages and mints again on the
 * next push. Mint rate therefore scaled with `active trays × wake cycles`
 * rather than with time, and a single busy user could exceed Apple's floor.
 *
 * The fix reuses infrastructure already bound: every tray DO asks one
 * well-known instance of the *same* namespace — `idFromName(APNS_TOKEN_DO_NAME)`
 * — for the current token. That instance is the only one that signs, and it
 * persists the result to its own storage so its own hibernation costs nothing.
 * No new binding, no KV.
 *
 * Deliberately *not* fronted by `caches.default`: the singleton never mints on
 * a cache miss (it returns a stored token), so a cache would only shave the
 * internal round trip while adding an invalidation path for a value that must
 * rotate on demand. The per-DO memo below already collapses the hot path.
 */

import type { ApnsProviderToken, ApnsProviderTokenSource, ProviderTokenStore } from './apns.js';
import type {
  DurableObjectNamespaceLike,
  DurableObjectStorageLike,
  DurableObjectStubLike,
} from './shared.js';
import { jsonResponse } from './shared.js';

/** Well-known instance name of the minting DO within the tray namespace. */
export const APNS_TOKEN_DO_NAME = '__apns_provider_token';
/** Internal route the minting instance answers on. */
export const APNS_TOKEN_PATH = '/internal/apns-token';
/** Storage key the minting instance keeps its token under. */
export const APNS_TOKEN_STORAGE_KEY = 'apns:provider-token';
/**
 * How long a borrowing DO may reuse a fetched token before asking again. Keyed
 * off the token's `mintedAt`, never the fetch time, so a token borrowed at
 * minute 49 is not held past Apple's 60-minute expiry.
 */
const BORROWED_TOKEN_TTL_MS = 50 * 60 * 1000;
/**
 * Absolute age past which a borrowed token is never reused, even to ride out an
 * outage of the minting instance. Apple expires provider tokens at 60 minutes.
 */
const BORROWED_TOKEN_MAX_AGE_MS = 55 * 60 * 1000;

/** Any URL works for a DO stub fetch; only the path is routed. */
const INTERNAL_ORIGIN = 'https://tray-hub.internal';

function isProviderToken(value: unknown): value is ApnsProviderToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as { value?: unknown; mintedAt?: unknown };
  return (
    typeof token.value === 'string' &&
    token.value.length > 0 &&
    typeof token.mintedAt === 'number' &&
    Number.isFinite(token.mintedAt)
  );
}

/** Persist the minted JWT in the minting DO's own storage across hibernation. */
export function durableObjectProviderTokenStore(
  storage: DurableObjectStorageLike
): ProviderTokenStore {
  return {
    async load() {
      const stored = await storage.get<ApnsProviderToken>(APNS_TOKEN_STORAGE_KEY);
      return isProviderToken(stored) ? stored : null;
    },
    async save(token) {
      await storage.put(APNS_TOKEN_STORAGE_KEY, token);
    },
  };
}

/**
 * Serve the current provider token to a borrowing tray DO. Runs *on* the
 * minting instance, against its local minter — never over the network, so
 * there is no self-fetch and no chance of a DO deadlocking on itself.
 */
export async function handleProviderTokenRequest(
  request: Request,
  minter: ApnsProviderTokenSource
): Promise<Response> {
  let staleToken: string | undefined;
  try {
    const body = (await request.json()) as { staleToken?: unknown };
    if (typeof body?.staleToken === 'string' && body.staleToken) staleToken = body.staleToken;
  } catch {
    // No body / not JSON: treat as a plain "give me the current token".
  }
  const token = await minter.getToken(staleToken);
  return jsonResponse(token);
}

/**
 * Borrows the provider JWT from the minting instance.
 *
 * When that instance cannot be reached this deliberately does **not** mint
 * locally. Doing so would put every waking tray back to signing its own JWT —
 * precisely the behaviour this module exists to remove — converting a brief,
 * local outage into account-wide `429 TooManyProviderTokenUpdates` that outlasts
 * it and fails the pushes anyway. A still-valid borrowed token is reused if this
 * instance happens to hold one; otherwise the push fails loudly. Pushes are
 * best-effort wake-ups — the request itself travels over the data channel — so
 * losing one costs far less than throttling the whole key.
 */
export class SharedProviderTokenSource implements ApnsProviderTokenSource {
  private memo: ApnsProviderToken | null = null;

  constructor(
    private readonly namespace: DurableObjectNamespaceLike,
    private readonly now: () => number
  ) {}

  async getToken(staleToken?: string): Promise<ApnsProviderToken> {
    const memo = this.memo;
    if (memo && staleToken === undefined && this.now() - memo.mintedAt < BORROWED_TOKEN_TTL_MS) {
      return memo;
    }
    try {
      const token = await this.fetchFromSingleton(staleToken);
      this.memo = token;
      return token;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Only worth riding out with a token the gateway has not rejected and
      // that Apple will still accept.
      if (
        memo &&
        memo.value !== staleToken &&
        this.now() - memo.mintedAt < BORROWED_TOKEN_MAX_AGE_MS
      ) {
        console.warn('[push] APNs provider-token instance unreachable — reusing borrowed token', {
          error,
        });
        return memo;
      }
      console.warn('[push] APNs provider-token instance unreachable — dropping push', { error });
      throw err;
    }
  }

  private async fetchFromSingleton(staleToken?: string): Promise<ApnsProviderToken> {
    const stub: DurableObjectStubLike = this.namespace.get(
      this.namespace.idFromName(APNS_TOKEN_DO_NAME)
    );
    const response = await stub.fetch(
      new Request(`${INTERNAL_ORIGIN}${APNS_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(staleToken ? { staleToken } : {}),
      })
    );
    if (!response.ok) {
      throw new Error(`provider-token DO responded ${response.status}`);
    }
    const token = (await response.json()) as unknown;
    if (!isProviderToken(token)) {
      throw new Error('provider-token DO returned a malformed token');
    }
    return token;
  }
}
