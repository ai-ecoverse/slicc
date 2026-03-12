const TRAY_QUERY_PARAM = 'tray';
const TRAY_WORKER_QUERY_PARAM = 'trayWorkerUrl';
const TRAY_LEGACY_LEAD_QUERY_PARAM = 'lead';

export interface CliLaunchUrlOptions {
  serveOrigin: string;
  lead: boolean;
  leadWorkerBaseUrl?: string | null;
  envWorkerBaseUrl?: string | null;
  join: boolean;
  joinUrl?: string | null;
}

function buildTrayJoinLaunchUrl(locationHref: string, joinUrl: string): string {
  const normalizedJoinUrl = normalizeTrayJoinUrl(joinUrl);
  if (!normalizedJoinUrl) {
    throw new Error(`Invalid tray join URL: ${joinUrl}`);
  }

  const url = new URL(locationHref);
  url.searchParams.delete(TRAY_LEGACY_LEAD_QUERY_PARAM);
  url.searchParams.delete(TRAY_WORKER_QUERY_PARAM);
  url.searchParams.set(TRAY_QUERY_PARAM, normalizedJoinUrl);
  return url.toString();
}

function normalizeTrayWorkerBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    }
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

function normalizeTrayJoinUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments.at(-2) !== 'join') {
      return null;
    }

    const token = decodeURIComponent(segments.at(-1)!);
    const [trayId, secret, ...rest] = token.split('.');
    if (!trayId || !secret || rest.length > 0) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function buildTrayLeadLaunchUrl(locationHref: string, workerBaseUrl: string): string {
  const normalizedBase = normalizeTrayWorkerBaseUrl(workerBaseUrl);
  if (!normalizedBase) {
    throw new Error(`Invalid tray worker base URL: ${workerBaseUrl}`);
  }

  const url = new URL(locationHref);
  url.searchParams.delete(TRAY_LEGACY_LEAD_QUERY_PARAM);
  url.searchParams.delete(TRAY_WORKER_QUERY_PARAM);
  url.searchParams.set(TRAY_QUERY_PARAM, normalizedBase);
  return url.toString();
}

export function resolveCliBrowserLaunchUrl(options: CliLaunchUrlOptions): string {
  if (options.lead && options.join) {
    throw new Error('The --lead and --join launch flows are mutually exclusive.');
  }

  if (options.join) {
    if (!options.joinUrl) {
      throw new Error('The --join launch flow requires a tray join URL via --join <url> or --join=<url>.');
    }
    return buildTrayJoinLaunchUrl(options.serveOrigin, options.joinUrl);
  }

  if (!options.lead) {
    return options.serveOrigin;
  }

  const workerBaseUrl = normalizeTrayWorkerBaseUrl(options.leadWorkerBaseUrl ?? options.envWorkerBaseUrl ?? null);
  if (!workerBaseUrl) {
    throw new Error('The --lead launch flow requires a tray worker base URL via --lead <url>, --lead=<url>, or WORKER_BASE_URL.');
  }

  return buildTrayLeadLaunchUrl(options.serveOrigin, workerBaseUrl);
}