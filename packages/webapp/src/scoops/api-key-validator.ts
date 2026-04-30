/**
 * API-key validator — best-effort live check that an entered key
 * actually authenticates against the provider's models endpoint.
 *
 * The validator is deliberately permissive: when we don't know how
 * to test a particular provider (or the request fails for a
 * non-auth reason like CORS), we report `kind: 'skipped'` rather
 * than `'failed'` so the dip can still let the user save the key
 * and move on. Authentication failures (HTTP 401/403) surface as
 * `'failed'` with a human-readable error.
 *
 * No keys are logged or persisted by this module. The caller is
 * responsible for storing successful results via `addAccount`.
 */

export interface ValidateApiKeyOptions {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  /** Optional fetch override for tests / extension proxies. */
  fetchImpl?: typeof fetch;
  /** Abort signal so the dip can cancel an in-flight check. */
  signal?: AbortSignal;
}

export type ValidationResult =
  | { kind: 'ok' }
  | { kind: 'failed'; status: number | null; message: string }
  | { kind: 'skipped'; reason: string };

/**
 * Provider-specific endpoints. Keep this list small and explicit —
 * each entry is a request that should succeed quickly with a valid
 * key and fail with 401/403 for a bad one.
 */
interface Probe {
  url: (baseUrl?: string) => string;
  headers: (apiKey: string) => Record<string, string>;
}

const PROBES: Record<string, Probe> = {
  openai: {
    url: (b) => `${(b ?? 'https://api.openai.com').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  anthropic: {
    url: (b) => `${(b ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({
      'x-api-key': k,
      'anthropic-version': '2023-06-01',
    }),
  },
  groq: {
    url: (b) => `${(b ?? 'https://api.groq.com/openai').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  cerebras: {
    url: (b) => `${(b ?? 'https://api.cerebras.ai').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  mistral: {
    url: (b) => `${(b ?? 'https://api.mistral.ai').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  'x-ai': {
    url: (b) => `${(b ?? 'https://api.x.ai').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  deepseek: {
    url: (b) => `${(b ?? 'https://api.deepseek.com').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  openrouter: {
    url: (b) => `${(b ?? 'https://openrouter.ai/api').replace(/\/$/, '')}/v1/models`,
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  // Google's "Generative Language" API uses a query-string key.
  google: {
    url: (b) =>
      `${(b ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '')}/v1beta/models`,
    headers: () => ({}),
  },
};

/** Map an HTTP status to a friendly message. */
function describeStatus(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'Authentication failed — the key was rejected by the provider.';
  }
  if (status === 404) return 'Endpoint not found — check the base URL.';
  if (status === 429) return 'Rate-limited — try again in a moment.';
  if (status >= 500) return 'Provider returned a server error.';
  // Surface a snippet of the body when present, capped to avoid log spam.
  const trimmed = body.trim();
  if (trimmed) return `${status}: ${trimmed.slice(0, 160)}`;
  return `Provider responded with HTTP ${status}.`;
}

export async function validateApiKey(opts: ValidateApiKeyOptions): Promise<ValidationResult> {
  const { provider, apiKey, baseUrl, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const trimmedKey = apiKey.trim();

  if (!trimmedKey) {
    return { kind: 'failed', status: null, message: 'API key is empty.' };
  }

  const probe = PROBES[provider];
  if (!probe) {
    return {
      kind: 'skipped',
      reason: `No live validation available for "${provider}" — saving without testing.`,
    };
  }

  let url = probe.url(baseUrl);
  // Google's API key rides as a query-string parameter.
  if (provider === 'google') {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}key=${encodeURIComponent(trimmedKey)}`;
  }

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: probe.headers(trimmedKey),
      signal,
    });
    if (response.ok) return { kind: 'ok' };
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore — body unreadable
    }
    if (response.status === 401 || response.status === 403) {
      return {
        kind: 'failed',
        status: response.status,
        message: describeStatus(response.status, body),
      };
    }
    return {
      kind: 'failed',
      status: response.status,
      message: describeStatus(response.status, body),
    };
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw err;
    }
    // Network errors (CORS, DNS, offline) are recoverable from the
    // user's perspective — they couldn't have *known* whether the
    // key was good — so we report a skip with the underlying message.
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'skipped',
      reason: `Couldn't reach the provider (${message}). Saving without live test — you can retry from Settings.`,
    };
  }
}

export const __test__ = { PROBES };
