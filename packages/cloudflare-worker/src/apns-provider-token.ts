import type { ApnsProviderToken, ApnsProviderTokenSource, ProviderTokenStore } from './apns.js';
import type {
  DurableObjectNamespaceLike,
  DurableObjectStorageLike,
  DurableObjectStubLike,
} from './shared.js';
import { jsonResponse } from './shared.js';

export const APNS_TOKEN_DO_NAME = '__apns_provider_token';

export const APNS_TOKEN_PATH = '/internal/apns-token';

export const APNS_TOKEN_STORAGE_KEY = 'apns:provider-token';

const BORROWED_TOKEN_TTL_MS = 50 * 60 * 1000;

const BORROWED_TOKEN_MAX_AGE_MS = 55 * 60 * 1000;

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

export async function handleProviderTokenRequest(
  request: Request,
  minter: ApnsProviderTokenSource
): Promise<Response> {
  let staleToken: string | undefined;
  try {
    const body = (await request.json()) as { staleToken?: unknown };
    if (typeof body?.staleToken === 'string' && body.staleToken) staleToken = body.staleToken;
  } catch {}
  const token = await minter.getToken(staleToken);
  return jsonResponse(token);
}

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
