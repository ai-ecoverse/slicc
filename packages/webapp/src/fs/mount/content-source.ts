import { AEM_SOURCE_BUS_ORIGIN } from './backend-aem.js';
import type { SignedFetchDa } from './backend-da.js';

export type ContentBackendKind = 'da' | 'aem';

export interface ContentSourceProbe {
  backend: ContentBackendKind;

  sourceUrl?: string;
}

interface SiteConfig {
  content?: { source?: { url?: string; type?: string } };
}

export async function probeContentSource(
  org: string,
  site: string,
  signedFetch: SignedFetchDa
): Promise<ContentSourceProbe> {
  const res = await signedFetch({
    method: 'GET',
    path: `/${org}/sites/${site}/config.json`,
    origin: AEM_SOURCE_BUS_ORIGIN,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `not authorized to read the site config for ${org}/${site} — ` +
        'log in via Settings → Providers → Adobe, or pass --backend to skip the probe'
    );
  }
  if (res.status === 404) {
    throw new Error(`no site config for ${org}/${site} — check the org and site names`);
  }
  if (res.status >= 400) {
    throw new Error(`site config probe failed for ${org}/${site}: ${res.status}`);
  }

  let config: SiteConfig;
  try {
    config = (await res.json()) as SiteConfig;
  } catch (err) {
    throw new Error(
      `site config for ${org}/${site} is not JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const sourceUrl = config.content?.source?.url;
  return { backend: classifyContentSourceUrl(sourceUrl), sourceUrl };
}

export function classifyContentSourceUrl(url: string | undefined): ContentBackendKind {
  if (!url) return 'da';
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return 'da';
  }
  return host === 'api.aem.live' ? 'aem' : 'da';
}
