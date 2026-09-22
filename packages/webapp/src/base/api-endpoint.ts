import { isChromeExtensionRealm } from '@slicc/shared-ts';

let localApiBaseUrl: string | null = null;

let bridgeToken: string | null = null;

export function setLocalApiBaseUrl(baseUrl: string | null): void {
  if (baseUrl === null || baseUrl === '') {
    localApiBaseUrl = null;
    return;
  }
  localApiBaseUrl = baseUrl.replace(/\/+$/, '');
}

export function getLocalApiBaseUrl(): string | null {
  return localApiBaseUrl;
}

export function setBridgeToken(token: string | null): void {
  bridgeToken = token === null || token === '' ? null : token;
}

export function getBridgeToken(): string | null {
  return bridgeToken;
}

let extensionDelegateId: string | null = null;

export function setExtensionDelegateId(id: string | null): void {
  extensionDelegateId = id === null || id === '' ? null : id;
}

export function getExtensionDelegateId(): string | null {
  return extensionDelegateId;
}

let chromeExtensionRealm: boolean | null = null;

export function setChromeExtensionRealm(value: boolean | null): void {
  chromeExtensionRealm = value;
}

export function getChromeExtensionRealm(): boolean {
  if (chromeExtensionRealm === null) {
    chromeExtensionRealm = isChromeExtensionRealm();
  }
  return chromeExtensionRealm;
}

export function resolveApiUrl(path: string): string {
  return localApiBaseUrl ? `${localApiBaseUrl}${path}` : path;
}

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (bridgeToken && localApiBaseUrl) {
    headers['X-Bridge-Token'] = bridgeToken;
  }
  if (extra) {
    for (const k of Object.keys(extra)) {
      headers[k] = extra[k];
    }
  }
  return headers;
}

export const BRIDGE_TOKEN_REQUIRED_ERROR = 'bridge-token-required';

export const STALE_BRIDGE_TOKEN_CODE = 'stale-bridge-token';

export const STALE_BRIDGE_TOKEN_MESSAGE =
  "This tab's bridge token is no longer valid — the launcher restarted. Reload from the launcher.";

export class StaleBridgeTokenError extends Error {
  readonly code = STALE_BRIDGE_TOKEN_CODE;

  constructor() {
    super(STALE_BRIDGE_TOKEN_MESSAGE);
    this.name = 'StaleBridgeTokenError';
  }
}

export function isStaleBridgeTokenError(err: unknown): err is StaleBridgeTokenError {
  if (err instanceof StaleBridgeTokenError) return true;
  if (!(err instanceof Error)) return false;
  return (err as Error & { code?: unknown }).code === STALE_BRIDGE_TOKEN_CODE;
}

export interface BridgeStatusResponse {
  status: number;
  clone(): { json(): Promise<unknown> };
}

export async function throwIfStaleBridgeToken(response: BridgeStatusResponse): Promise<void> {
  if (response.status !== 403) return;
  let errorField: unknown;
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    errorField = body?.error;
  } catch {
    return;
  }
  if (errorField === BRIDGE_TOKEN_REQUIRED_ERROR) {
    throw new StaleBridgeTokenError();
  }
}

export async function assertLocalBridgeAcceptsToken(
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!localApiBaseUrl || !bridgeToken) return;
  let response: Response;
  try {
    response = await fetchImpl(resolveApiUrl('/api/status'), {
      cache: 'no-store',
      headers: apiHeaders(),
      signal: AbortSignal.timeout(1500),
    });
  } catch (err) {
    if (isStaleBridgeTokenError(err)) throw err;
    return;
  }
  await throwIfStaleBridgeToken(response);
}
