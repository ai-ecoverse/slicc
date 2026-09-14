import { normalizeTrayWorkerBaseUrl, parseTrayJoinUrl } from '@slicc/shared-ts';

export { normalizeTrayWorkerBaseUrl };

export const TRAY_WORKER_STORAGE_KEY = 'slicc.trayWorkerBaseUrl';

export const TRAY_JOIN_STORAGE_KEY = 'slicc.trayJoinUrl';

export interface TrayUrlConfig {
  workerBaseUrl: string;
  trayId: string | null;
  joinUrl: string | null;
}

export type TrayJoinConfig = TrayUrlConfig & { joinUrl: string };

export function parseTrayUrlValue(raw: string | null | undefined): TrayUrlConfig | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    url.search = '';
    url.hash = '';

    const segments = url.pathname.split('/').filter(Boolean);
    let trayId: string | null = null;
    const joinUrl: string | null = null;
    if (segments.length >= 2 && segments.at(-2) === 'tray') {
      trayId = decodeURIComponent(segments.at(-1)!);
      segments.splice(-2, 2);
      url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';
    } else if (segments.length >= 2 && segments.at(-2) === 'join') {
      return parseTrayJoinUrl(url.toString());
    }

    const workerBaseUrl = normalizeTrayWorkerBaseUrl(url.toString());
    if (!workerBaseUrl) {
      return null;
    }

    return { workerBaseUrl, trayId, joinUrl };
  } catch {
    return null;
  }
}

export function parseTrayJoinUrlValue(raw: string | null | undefined): TrayJoinConfig | null {
  const parsed = parseTrayUrlValue(raw);
  return parsed?.joinUrl ? (parsed as TrayJoinConfig) : null;
}
