import {
  type DiscoveryKind,
  discoveryFingerprint,
  extractCatalogFromWebRequest,
  type ProbeFetch,
  probeWellKnown,
} from '@slicc/shared-ts';

export interface ObservedDiscovery {
  discoveryOrigin: string;
  discoveryKind: DiscoveryKind;
  discoveryUrl: string;

  url: string;
}

export interface DiscoveryHeadersDetail {
  url: string;
  responseHeaders?: Array<{ name: string; value?: string }>;
}

export interface DiscoveryObserverDeps {
  fetchImpl: ProbeFetch;

  emit: (discovery: ObservedDiscovery) => number;

  probeTimeoutMs?: number;

  isEnabled?: () => boolean;
}

export interface DiscoveryObserver {
  onHeaders: (detail: DiscoveryHeadersDetail) => void;
}

export function createDiscoveryObserver(deps: DiscoveryObserverDeps): DiscoveryObserver {
  const seenFingerprints = new Set<string>();
  const probedOrigins = new Set<string>();

  const forward = (
    origin: string,
    kind: DiscoveryKind,
    artifactUrl: string,
    pageUrl: string
  ): void => {
    const fingerprint = discoveryFingerprint({ origin, kind, url: artifactUrl });
    if (seenFingerprints.has(fingerprint)) return;

    const delivered = deps.emit({
      discoveryOrigin: origin,
      discoveryKind: kind,
      discoveryUrl: artifactUrl,
      url: pageUrl,
    });
    if (delivered >= 1) seenFingerprints.add(fingerprint);
  };

  const probeOrigin = async (origin: string, pageUrl: string): Promise<void> => {
    if (probedOrigins.has(origin)) return;
    probedOrigins.add(origin);
    try {
      const matches = await probeWellKnown(origin, deps.fetchImpl, {
        timeoutMs: deps.probeTimeoutMs,
      });
      for (const match of matches) forward(origin, match.kind, match.url, pageUrl);
    } catch {}
  };

  const isEnabled = deps.isEnabled ?? ((): boolean => true);

  const onHeaders = (detail: DiscoveryHeadersDetail): void => {
    if (!isEnabled()) return;
    let url: URL;
    try {
      url = new URL(detail.url);
    } catch {
      return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const origin = url.origin;

    const { match } = extractCatalogFromWebRequest(detail.responseHeaders, detail.url);
    if (match) forward(origin, match.kind, match.url, detail.url);

    void probeOrigin(origin, detail.url);
  };

  return { onHeaders };
}
