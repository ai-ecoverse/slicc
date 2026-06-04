/**
 * Maps a tray's worker base URL to its preview-subdomain base host.
 *
 * Critical: this is a LOOKUP TABLE, not a hostname suffix-strip. The staging
 * worker lives on `slicc-tray-hub-staging.minivelos.workers.dev` (per
 * `packages/webapp/src/scoops/tray-runtime-config.ts:4-5`), which has no string
 * relationship to `preview.staging.sliccy.ai`. Adding a new env means adding
 * a row here AND ensuring infra has both routes bound to the same worker /
 * DurableObject namespace.
 */
const PREVIEW_BASE_BY_WORKER: Record<string, string> = {
  // Production
  'www.sliccy.ai': 'preview.sliccy.ai',
  'sliccy.ai': 'preview.sliccy.ai',
  // Staging — mint API on workers.dev, preview on sliccy.ai zone (same worker)
  'slicc-tray-hub-staging.minivelos.workers.dev': 'preview.staging.sliccy.ai',
};

export function previewBaseHost(workerBaseUrl: string): string {
  const host = new URL(workerBaseUrl).host.toLowerCase();
  const mapped = PREVIEW_BASE_BY_WORKER[host];
  if (!mapped) {
    throw new Error(`No preview base configured for worker host ${host}`);
  }
  return mapped;
}

export function buildPreviewUrl(workerBaseUrl: string, previewToken: string, path = '/'): string {
  const base = previewBaseHost(workerBaseUrl);
  const p = path.startsWith('/') ? path : '/' + path;
  return `https://${previewToken}.${base}${p}`;
}
