import { BRIDGE_TOKEN_QUERY_PARAM, BRIDGE_WS_QUERY_PARAM } from './bridge-security.js';
import {
  buildCanonicalTrayLaunchUrl,
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrl,
} from './tray-url-shared.js';

export interface CliLaunchUrlOptions {
  serveOrigin: string;
  lead: boolean;
  leadWorkerBaseUrl?: string | null;
  envWorkerBaseUrl?: string | null;
  join: boolean;
  joinUrl?: string | null;
  /**
   * Thin-bridge coordinates appended as query params so the hosted leader can
   * discover + authenticate the local /cdp WebSocket. Both must be set
   * together; both unset = no bridge params (legacy / bundled UI path).
   */
  bridgeWsUrl?: string | null;
  bridgeToken?: string | null;
  /** When true, appends `cup=1` to activate the external-brain shell bridge. */
  cup?: boolean;
}

export function appendCupParam(url: string, cup: boolean): string {
  if (!cup) return url;
  return `${url}${url.includes('?') ? '&' : '?'}cup=1`;
}

function appendBridgeParams(url: string, opts: CliLaunchUrlOptions): string {
  if (!opts.bridgeWsUrl || !opts.bridgeToken) return url;
  const params = new URLSearchParams();
  params.set(BRIDGE_WS_QUERY_PARAM, opts.bridgeWsUrl);
  params.set(BRIDGE_TOKEN_QUERY_PARAM, opts.bridgeToken);
  return `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
}

function buildTrayJoinLaunchUrl(locationHref: string, joinUrl: string): string {
  const parsedJoinUrl = parseTrayJoinUrl(joinUrl);
  if (!parsedJoinUrl) {
    throw new Error(`Invalid tray join URL: ${joinUrl}`);
  }

  return buildCanonicalTrayLaunchUrl(locationHref, parsedJoinUrl.joinUrl);
}

function buildTrayLeadLaunchUrl(locationHref: string, workerBaseUrl: string): string {
  const normalizedBase = normalizeTrayWorkerBaseUrl(workerBaseUrl);
  if (!normalizedBase) {
    throw new Error(`Invalid tray worker base URL: ${workerBaseUrl}`);
  }

  return buildCanonicalTrayLaunchUrl(locationHref, normalizedBase);
}

export function resolveCliBrowserLaunchUrl(options: CliLaunchUrlOptions): string {
  if (options.lead && options.join) {
    throw new Error('The --lead and --join launch flows are mutually exclusive.');
  }

  let url: string;

  if (options.join) {
    if (!options.joinUrl) {
      throw new Error(
        'The --join launch flow requires a tray join URL via --join <url> or --join=<url>.'
      );
    }
    url = appendBridgeParams(buildTrayJoinLaunchUrl(options.serveOrigin, options.joinUrl), options);
  } else if (!options.lead) {
    url = appendBridgeParams(options.serveOrigin, options);
  } else {
    const workerBaseUrl = normalizeTrayWorkerBaseUrl(
      options.leadWorkerBaseUrl ?? options.envWorkerBaseUrl ?? null
    );
    if (!workerBaseUrl) {
      throw new Error(
        'The --lead launch flow requires a tray worker base URL via --lead <url>, --lead=<url>, or WORKER_BASE_URL.'
      );
    }
    url = appendBridgeParams(buildTrayLeadLaunchUrl(options.serveOrigin, workerBaseUrl), options);
  }

  return appendCupParam(url, options.cup ?? false);
}
