import { SLICC_HOSTED_ORIGIN } from './bridge-protocol.js';

const SLICC_HOSTED_HOSTNAME = new URL(SLICC_HOSTED_ORIGIN).hostname;

const PREVIEW_BASE_BY_WORKER: Record<string, string> = {
  [SLICC_HOSTED_HOSTNAME]: 'sliccy.now',
  'sliccy.ai': 'sliccy.now',

  'slicc-tray-hub-staging.minivelos.workers.dev': 'sliccy.dev',
};

export function previewBaseHost(workerBaseUrl: string): string {
  const url = new URL(workerBaseUrl);
  const host = url.host.toLowerCase();

  if (url.hostname.toLowerCase() === 'localhost') return host;
  const mapped = PREVIEW_BASE_BY_WORKER[host];
  if (!mapped) {
    throw new Error(`No preview base configured for worker host ${host}`);
  }
  return mapped;
}

function encodeTokenForSubdomain(previewToken: string, userHash?: string): string {
  const dotIndex = previewToken.indexOf('.');
  if (dotIndex === -1) return previewToken;
  const trayId = previewToken.slice(0, dotIndex).replace(/-/g, '');
  const secret = previewToken.slice(dotIndex + 1);
  if (userHash) {
    return `${trayId}--${userHash}-${secret}`;
  }
  return `${trayId}--${secret}`;
}

export function buildPreviewUrl(
  workerBaseUrl: string,
  previewToken: string,
  path = '/',
  userHash?: string
): string {
  const base = previewBaseHost(workerBaseUrl);
  const label = encodeTokenForSubdomain(previewToken, userHash);
  const p = path.startsWith('/') ? path : '/' + path;

  const scheme = base.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${label}.${base}${p}`;
}

export const PREVIEW_MAX_FILE_BYTES = 25 * 1024 * 1024;

export const PREVIEW_MAX_RANGE_BYTES = 8 * 1024 * 1024;

export const PREVIEW_MAX_SNAPSHOTS_PER_TRAY = 10;

export const PREVIEW_LIVE_ORPHAN_MINUTES = 5;

const PREVIEW_LABEL_RE = /^([0-9a-f]{32})--(?:[0-9a-f]{8}-)?([0-9a-f]+)$/i;

export function previewTokenFromUrl(input: string): string | null {
  let host: string;
  try {
    host = new URL(input.includes('://') ? input : `https://${input}`).hostname;
  } catch {
    return null;
  }
  const match = PREVIEW_LABEL_RE.exec(host.split('.')[0] ?? '');
  if (!match || !host.includes('.')) return null;
  const compact = match[1]!.toLowerCase();
  const trayId = [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
  return `${trayId}.${match[2]!.toLowerCase()}`;
}
