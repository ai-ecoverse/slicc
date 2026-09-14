const BYPASS_HEADER = 'x-bypass-llm-proxy';
const BYPASS_VALUE = '1';

export type FetchFn = typeof fetch;

export type BridgeProxyOriginGetter = () => string | null;

export function makeSameOriginBypassFetch(
  orig: FetchFn,
  selfOrigin: string | undefined,
  getBridgeProxyOrigin?: BridgeProxyOriginGetter
): FetchFn {
  if (!selfOrigin) return orig;
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!shouldStampBypass(input, selfOrigin, getBridgeProxyOrigin)) {
      return orig(input, init);
    }
    const headers = new Headers(init?.headers);
    if (!headers.has(BYPASS_HEADER)) headers.set(BYPASS_HEADER, BYPASS_VALUE);
    return orig(input, { ...init, headers });
  };
}

function shouldStampBypass(
  input: RequestInfo | URL,
  selfOrigin: string,
  getBridgeProxyOrigin: BridgeProxyOriginGetter | undefined
): boolean {
  if (isSameOrigin(input, selfOrigin)) return true;
  const bridgeOrigin = getBridgeProxyOrigin?.() ?? null;
  if (!bridgeOrigin) return false;
  return isBridgeLocalApiTarget(input, bridgeOrigin, selfOrigin);
}

export function isBridgeLocalApiTarget(
  input: RequestInfo | URL,
  bridgeOrigin: string,
  selfOrigin: string
): boolean {
  const urlStr = inputUrlString(input);
  let target: URL;
  let bridge: URL;
  try {
    target = new URL(urlStr, selfOrigin);
    bridge = new URL(bridgeOrigin);
  } catch {
    return false;
  }
  return target.origin === bridge.origin && target.pathname.startsWith('/api/');
}

export function isSameOrigin(input: RequestInfo | URL, selfOrigin: string): boolean {
  const urlStr = inputUrlString(input);
  try {
    return new URL(urlStr, selfOrigin).origin === selfOrigin;
  } catch {
    return true;
  }
}

function inputUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
