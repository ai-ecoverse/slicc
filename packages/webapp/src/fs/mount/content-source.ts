/**
 * Content-source probe — decides whether an AEM site's documents live in the
 * Helix 5 Document Authoring store (`admin.da.live`) or the Helix 6 Source Bus
 * (`api.aem.live`).
 *
 * The scheme the user typed is a request, not an answer. A site upgraded to
 * Helix 6 keeps its `da.live` authoring UI and its `<org>/<site>` identity, so
 * `da://<org>/<site>` still *looks* right — but `admin.da.live` no longer holds
 * that site's content, and mounting it there succeeds while indexing an
 * unrelated project's boilerplate. Silently mounting the wrong repository is
 * the outcome this probe exists to rule out (issue #2227).
 *
 * The authority is the site config, which `api.aem.live` serves for Helix 5 and
 * Helix 6 sites alike:
 *
 *   GET https://api.aem.live/<org>/sites/<site>/config.json
 *   → { content: { source: { type: "markup", url: "…" } }, … }
 *
 * `content.source.type` is `"markup"` in both generations, so the *host* of
 * `content.source.url` is the discriminator:
 *
 *   - `https://api.aem.live/<org>/sites/<site>/source`  → Helix 6 Source Bus
 *   - `https://content.da.live/<org>/<site>/`           → Helix 5 DA store
 *
 * Per the DA team, a client picks between the two admin endpoints from this
 * value rather than substituting the URL wholesale — which is why this returns
 * a backend choice and not a base URL.
 */

import { AEM_SOURCE_BUS_ORIGIN } from './backend-aem.js';
import type { SignedFetchDa } from './backend-da.js';

/** Which admin API holds a site's documents. */
export type ContentBackendKind = 'da' | 'aem';

export interface ContentSourceProbe {
  backend: ContentBackendKind;
  /** `content.source.url` verbatim, for error copy. Absent if unreadable. */
  sourceUrl?: string;
}

interface SiteConfig {
  content?: { source?: { url?: string; type?: string } };
}

/**
 * Probe `<org>/<site>`'s config and report which backend holds its content.
 *
 * Throws when the config can't be read — an unauthenticated session, a
 * nonexistent site, or a transport failure. Callers decide whether that is
 * fatal (it is for an ambiguous `da://`) or recoverable.
 */
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

/**
 * Map a `content.source.url` onto a backend. Unknown and missing hosts fall
 * back to `da` — the historical behaviour, and the one that stays correct for
 * every site that has not been upgraded.
 */
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
