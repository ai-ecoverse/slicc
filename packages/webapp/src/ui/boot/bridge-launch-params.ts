import {
  BRIDGE_ROLE_QUERY_PARAM,
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
  type BridgeRole,
  isLoopbackHostname,
} from '@slicc/shared-ts';

export type { BridgeRole };

export {
  BRIDGE_ROLE_QUERY_PARAM,
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
};

export interface BridgeLaunchParams {
  url: string;

  subprotocol: string;

  token: string;

  apiBaseUrl: string | null;

  lickWsUrl: string | null;

  role: BridgeRole | null;
}

export function deriveBridgeApiBaseUrl(bridgeWsUrl: string): string | null {
  try {
    const u = new URL(bridgeWsUrl);
    const httpScheme = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${httpScheme}//${u.host}`;
  } catch {
    return null;
  }
}

export function deriveBridgeLickWsUrl(bridgeWsUrl: string): string | null {
  try {
    const u = new URL(bridgeWsUrl);
    return `${u.protocol}//${u.host}/licks-ws`;
  } catch {
    return null;
  }
}

export function parseBridgeLaunchParams(search: string): BridgeLaunchParams | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const url = params.get(BRIDGE_WS_QUERY_PARAM);
  const token = params.get(BRIDGE_TOKEN_QUERY_PARAM);
  if (!url || !token) return null;
  if (!/^wss?:\/\//.test(url)) return null;

  let bridgeHostname: string;
  try {
    bridgeHostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!isLoopbackHostname(bridgeHostname)) return null;

  const rawRole = params.get(BRIDGE_ROLE_QUERY_PARAM);
  const role: BridgeRole | null = rawRole === 'leader' || rawRole === 'follower' ? rawRole : null;

  return {
    url,
    subprotocol: `${BRIDGE_SUBPROTOCOL_PREFIX}${token}`,
    token,
    apiBaseUrl: deriveBridgeApiBaseUrl(url),
    lickWsUrl: deriveBridgeLickWsUrl(url),
    role,
  };
}
