import { BRIDGE_SUBPROTOCOL_PREFIX, BRIDGE_TOKEN_HEADER } from '@slicc/shared-ts';

export const CDP_RECONNECT_BASE_MS = 250;
export const CDP_RECONNECT_CAP_MS = 30_000;

export const CDP_RECONNECT_JITTER = 0.2;

export const CDP_BRIDGE_REJECTED_MESSAGE =
  'CDP bridge rejected the session token (bridge-token-required). Open SLICC again from Sliccstart to pick up a fresh token.';

export class CdpBridgeRejectedError extends Error {
  constructor(message: string = CDP_BRIDGE_REJECTED_MESSAGE) {
    super(message);
    this.name = 'CdpBridgeRejectedError';
  }
}

export class CdpReconnectBackoffError extends Error {
  constructor() {
    super('CDP reconnect is backing off');
    this.name = 'CdpReconnectBackoffError';
  }
}

export interface CdpConnectFailureInput {
  url: string;
  protocols?: string | string[];
}

export type CdpConnectFailureKind = 'terminal' | 'transient';

export type CdpConnectFailureClassifier = (
  input: CdpConnectFailureInput
) => Promise<CdpConnectFailureKind>;

export function nextCdpReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const shift = Math.min(Math.max(0, attempt), 16);
  const exp = Math.min(CDP_RECONNECT_CAP_MS, CDP_RECONNECT_BASE_MS * 2 ** shift);
  const jitter = Math.round(exp * CDP_RECONNECT_JITTER * random());
  return Math.min(CDP_RECONNECT_CAP_MS, exp + jitter);
}

export function bridgeHttpOriginFromWsUrl(wsUrl: string): string | null {
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    const http = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${http}//${url.host}`;
  } catch {
    return null;
  }
}

export function bridgeTokenFromProtocols(protocols: string | string[] | undefined): string | null {
  const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
  const match = list.find((protocol) => protocol.startsWith(BRIDGE_SUBPROTOCOL_PREFIX));
  if (!match) return null;
  const token = match.slice(BRIDGE_SUBPROTOCOL_PREFIX.length);
  return token.length > 0 ? token : null;
}

export async function classifyCdpConnectFailure(
  input: CdpConnectFailureInput,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<CdpConnectFailureKind> {
  const token = bridgeTokenFromProtocols(input.protocols);
  const origin = bridgeHttpOriginFromWsUrl(input.url);
  if (!token || !origin || typeof fetchImpl !== 'function') return 'transient';
  try {
    const res = await fetchImpl(`${origin}/api/status`, {
      method: 'GET',
      headers: { [BRIDGE_TOKEN_HEADER]: token },
      cache: 'no-store',
      signal: AbortSignal.timeout(1_000),
    });
    const body = await res.text();
    if (res.status === 403 && body.includes('bridge-token-required')) return 'terminal';
    return 'transient';
  } catch {
    return 'transient';
  }
}
