/**
 * When to dial the local `/cdp` bridge again.
 *
 * A rejected handshake is asynchronous — it does not spin the main thread —
 * but `listPages` refreshes every few seconds and each refresh used to open
 * a new WebSocket immediately. A stale `bridgeToken` makes every one of those
 * fail the same way, so the page and the server log a reconnect storm.
 *
 * Transient failures (bridge not listening yet, Chrome's socket down) back
 * off with jitter up to {@link CDP_RECONNECT_CAP_MS}. A `403` whose body is
 * `bridge-token-required` cannot succeed until the tab is opened again with
 * the server's current token, so it is terminal.
 */

import { BRIDGE_SUBPROTOCOL_PREFIX, BRIDGE_TOKEN_HEADER } from '@slicc/shared-ts';

export const CDP_RECONNECT_BASE_MS = 250;
export const CDP_RECONNECT_CAP_MS = 30_000;
/** Fraction of the exponential delay added as jitter, in `[0, 1]`. */
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

/**
 * Delay before the next dial. `attempt` is how many transient failures have
 * already been recorded (0 = the gap after the first failure). `random`
 * returns a value in `[0, 1)` and exists so tests can pin the jitter.
 */
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

/**
 * Ask the local bridge whether this tab's token is still the one it minted.
 *
 * The WebSocket handshake hides the HTTP status, so a rejected upgrade looks
 * the same as "nothing is listening". `GET /api/status` with `X-Bridge-Token`
 * separates them: `403 bridge-token-required` is terminal, anything else
 * (including a network error) is transient.
 */
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
