const DEFAULT_PROXY = 'https://adobe-llm-proxy.paolo-moz.workers.dev';
const TTL_MS = 5 * 60 * 1000;

export interface ProxyModel {
  id: string;
  name: string;
}

export interface ProxyConfig {
  clientId: string;
  scopes: string;
  imsEnvironment: string;

  models?: ProxyModel[];
}

let cached: { config: ProxyConfig; expiresAt: number } | null = null;

export function getProxyEndpoint(env: { ADOBE_PROXY_ENDPOINT?: string }): string {
  return (env.ADOBE_PROXY_ENDPOINT || DEFAULT_PROXY).replace(/\/$/, '');
}

class ProxyConfigError extends Error {
  constructor(
    public readonly code: 'PROXY_HTTP_ERROR' | 'PROXY_SHAPE_ERROR',
    message: string
  ) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

export async function getProxyConfig(
  env: { ADOBE_PROXY_ENDPOINT?: string },
  fetchImpl: typeof fetch = fetch
): Promise<ProxyConfig> {
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  const endpoint = getProxyEndpoint(env);

  let res: Response;
  try {
    res = await fetchImpl(`${endpoint}/v1/config`, { method: 'GET' });
  } catch (err) {
    throw new ProxyConfigError(
      'PROXY_HTTP_ERROR',
      `proxy /v1/config fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    throw new ProxyConfigError('PROXY_HTTP_ERROR', `proxy /v1/config returned ${res.status}`);
  }

  const config = (await res.json()) as ProxyConfig;
  if (!config.clientId || !config.scopes || !config.imsEnvironment) {
    throw new ProxyConfigError('PROXY_SHAPE_ERROR', `proxy /v1/config missing required fields`);
  }
  cached = { config, expiresAt: Date.now() + TTL_MS };
  return config;
}

export function clearProxyConfigCache(): void {
  cached = null;
}
