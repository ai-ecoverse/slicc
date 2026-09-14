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
