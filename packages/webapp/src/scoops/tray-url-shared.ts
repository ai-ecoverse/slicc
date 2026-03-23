export const TRAY_QUERY_PARAM = 'tray';
export const TRAY_WORKER_QUERY_PARAM = 'trayWorkerUrl';
export const TRAY_LEGACY_LEAD_QUERY_PARAM = 'lead';

export interface ParsedTrayJoinUrl {
  workerBaseUrl: string;
  trayId: string;
  joinUrl: string;
}

export function normalizeTrayWorkerBaseUrl(raw: string | null | undefined): string | null {
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

export function parseTrayJoinUrl(raw: string | null | undefined): ParsedTrayJoinUrl | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';
    const normalizedJoinUrl = url.toString();

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments.at(-2) !== 'join') {
      return null;
    }

    const token = decodeURIComponent(segments.at(-1)!);
    const [trayId, secret, ...rest] = token.split('.');
    if (!trayId || !secret || rest.length > 0) {
      return null;
    }

    segments.splice(-2, 2);
    url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';

    const workerBaseUrl = normalizeTrayWorkerBaseUrl(url.toString());
    if (!workerBaseUrl) {
      return null;
    }

    return { workerBaseUrl, trayId, joinUrl: normalizedJoinUrl };
  } catch {
    return null;
  }
}

export function buildCanonicalTrayLaunchUrl(locationHref: string, trayValue: string): string {
  const url = new URL(locationHref);
  url.searchParams.delete(TRAY_WORKER_QUERY_PARAM);
  url.searchParams.delete(TRAY_LEGACY_LEAD_QUERY_PARAM);
  url.searchParams.set(TRAY_QUERY_PARAM, trayValue);
  return url.toString();
}