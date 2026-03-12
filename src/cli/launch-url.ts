const TRAY_QUERY_PARAM = 'tray';

export interface CliLaunchUrlOptions {
  serveOrigin: string;
  lead: boolean;
  leadWorkerBaseUrl?: string | null;
  envWorkerBaseUrl?: string | null;
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

function buildTrayLaunchUrl(locationHref: string, workerBaseUrl: string): string {
  const normalizedBase = normalizeTrayWorkerBaseUrl(workerBaseUrl);
  if (!normalizedBase) {
    throw new Error(`Invalid tray worker base URL: ${workerBaseUrl}`);
  }

  const url = new URL(locationHref);
  url.searchParams.delete('lead');
  url.searchParams.delete('trayWorkerUrl');
  url.searchParams.set(TRAY_QUERY_PARAM, normalizedBase);
  return url.toString();
}

export function resolveCliBrowserLaunchUrl(options: CliLaunchUrlOptions): string {
  if (!options.lead) {
    return options.serveOrigin;
  }

  const workerBaseUrl = normalizeTrayWorkerBaseUrl(options.leadWorkerBaseUrl ?? options.envWorkerBaseUrl ?? null);
  if (!workerBaseUrl) {
    throw new Error('The --lead launch flow requires a tray worker base URL via --lead <url>, --lead=<url>, or WORKER_BASE_URL.');
  }

  return buildTrayLaunchUrl(options.serveOrigin, workerBaseUrl);
}