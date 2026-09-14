import { isExtensionRealm } from './runtime-env.js';

export function toPreviewUrl(vfsPath: string, projectRoot?: string): string {
  const isExt = isExtensionRealm();
  const projectRootSuffix = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  const previewPath = `/preview${vfsPath}${projectRootSuffix}`;

  if (isExt) {
    const getURL = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } })
      .chrome?.runtime?.getURL;
    if (getURL) return getURL(previewPath);
  }

  let origin = 'http://localhost:5710';
  if (typeof window !== 'undefined' && window.location?.origin) {
    origin = window.location.origin;
  } else if (typeof self !== 'undefined' && self.location?.origin) {
    origin = self.location.origin;
  }
  return `${origin}${previewPath}`;
}

export function isPreviewUrl(url: string): boolean {
  if (url.includes('/preview/')) return true;
  try {
    const host = new URL(url).host;
    return /^[^.]+\.sliccy\.(?:now|dev)$/i.test(host);
  } catch {
    return false;
  }
}
