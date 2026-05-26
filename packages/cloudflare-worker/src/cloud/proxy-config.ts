// Fetches the Adobe LLM proxy's /v1/config endpoint (no auth required) and
// caches the result for ~5 minutes. The dashboard, the JWT client_id check,
// and the popup-construction code all read from this so the cone's reused
// bearer matches the proxy's expectations.

const DEFAULT_PROXY = 'https://adobe-llm-proxy.paolo-moz.workers.dev';
const TTL_MS = 5 * 60 * 1000;

export interface ProxyConfig {
  clientId: string;
  scopes: string;
  imsEnvironment: string;
}

let cached: { config: ProxyConfig; expiresAt: number } | null = null;

export function getProxyEndpoint(env: { ADOBE_PROXY_ENDPOINT?: string }): string {
  return (env.ADOBE_PROXY_ENDPOINT || DEFAULT_PROXY).replace(/\/$/, '');
}

export async function getProxyConfig(
  env: { ADOBE_PROXY_ENDPOINT?: string },
  fetchImpl: typeof fetch = fetch
): Promise<ProxyConfig> {
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  const endpoint = getProxyEndpoint(env);
  const res = await fetchImpl(`${endpoint}/v1/config`, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`proxy /v1/config returned ${res.status}`);
  }
  const config = (await res.json()) as ProxyConfig;
  if (!config.clientId || !config.scopes || !config.imsEnvironment) {
    throw new Error(`proxy /v1/config missing required fields`);
  }
  cached = { config, expiresAt: Date.now() + TTL_MS };
  return config;
}

export function clearProxyConfigCache(): void {
  cached = null;
}
