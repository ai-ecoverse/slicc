/**
 * RFC 8288 Link-header discovery, browse.sh catalog matching, and the
 * `SecureFetch` → Web Fetch adapter used by the playwright-cli command family.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import { discoverLinks } from '../../../net/discover-links.js';
import { extractHandoff } from '../../../net/handoff-link.js';
import { parseLinkHeader } from '../../../net/link-header.js';
import { createProxiedFetch } from '../../proxied-fetch.js';
import { normalizeHeadersInit } from '../../proxy-headers.js';
import {
  type BrowseShSkillSummary,
  fetchBrowseShCatalog,
  normalizeHostname,
} from '../upskill-command.js';
import type { BrowseShSkillMatch, PlaywrightDiscoveryResult } from './types.js';

/**
 * Adapter that lets `discoverLinks` (Web Fetch shape) ride on our
 * `SecureFetch`, inheriting CORS bypass and forbidden-header bridging.
 * Mirrors the helper used by the standalone `discover` command — also
 * forwards `init.headers` so caller-supplied forbidden headers
 * (`Origin`, `Cookie`, `Referer`) survive end-to-end.
 */
export function asWebFetch(secureFetch: SecureFetch): typeof fetch {
  const adapter = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = normalizeHeadersInit(init?.headers);
    const result = await secureFetch(url, {
      method: init?.method ?? 'GET',
      ...(headers ? { headers } : {}),
    });
    return new Response(result.body as BodyInit, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
  return adapter as typeof fetch;
}

/**
 * List installed browse.sh skill directories under `/workspace/skills/`.
 * Returns a Set of directory names (e.g. `browse-weather.gov-get-forecast`).
 * Best-effort: a missing or unreadable dir yields an empty Set so the
 * discovery result still reports `installed: false` instead of failing.
 */
async function listInstalledBrowseShSkills(fs: VirtualFS): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const entries = await fs.readDir('/workspace/skills');
    for (const e of entries) {
      if (e.type === 'directory' && e.name.startsWith('browse-')) {
        names.add(e.name);
      }
    }
  } catch {
    // /workspace/skills may not exist yet — treat as no installs.
  }
  return names;
}

/**
 * Match the destination URL's hostname against the browse.sh catalog.
 *
 * Lazy-warms the in-module catalog cache (one ~200KB CORS-open fetch per
 * shell session, acceptable because `--discover` is opt-in). Reuses the
 * cache on subsequent calls. On catalog fetch failure, returns a warning
 * and omits the skills field — never blocks the surrounding navigation.
 */
async function matchBrowseShSkillsForUrl(
  url: string,
  fs: VirtualFS,
  fetchImpl: SecureFetch
): Promise<{ skills?: BrowseShSkillMatch[]; warning?: string }> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  const normalized = host ? normalizeHostname(host) : '';
  if (!normalized) return {};

  let catalog: BrowseShSkillSummary[];
  try {
    catalog = await fetchBrowseShCatalog(fetchImpl);
  } catch (err) {
    return {
      warning: `playwright-cli: warning: browse.sh catalog unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const installed = await listInstalledBrowseShSkills(fs);
  const matches: BrowseShSkillMatch[] = [];
  for (const s of catalog) {
    if (!s.hostname) continue;
    if (normalizeHostname(s.hostname) !== normalized) continue;
    // Mirror `installFromBrowseSh`'s dirname rule (used by `upskill tabs`
    // as well — single source of truth): prefer the catalog's `name` and
    // only strip the trailing `-xxxxxx` disambiguation hash when falling
    // back to `task`.
    const skillName = s.name || s.task.replace(/-[A-Za-z0-9]{4,8}$/, '') || s.task;
    const dirName = `browse-${s.hostname}-${skillName}`;
    matches.push({
      slug: s.slug,
      name: s.name,
      title: s.title || s.name || s.task,
      recommendedMethod: s.recommendedMethod,
      installed: installed.has(dirName),
      installHint: `upskill browse:${s.hostname}/${s.task}`,
    });
  }
  return { skills: matches };
}

/**
 * Fetch a URL through the proxied fetch, parse RFC 8288 `Link` headers,
 * and (optionally) run P0 discovery. Failures in the primary fetch are
 * surfaced as `error` rather than thrown so callers can still emit a
 * structured payload. Discovery failures are collected per-link by
 * `discoverLinks` and never throw.
 */
export async function fetchAndDiscover(
  url: string,
  options: {
    discover?: boolean;
    method?: string;
    fetchImpl?: SecureFetch;
    fs?: VirtualFS;
  } = {}
): Promise<PlaywrightDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? createProxiedFetch();
  let response: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    response = await fetchImpl(url, { method: options.method ?? 'GET' });
  } catch (err) {
    return {
      url,
      links: [],
      handoff: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const linkValues: string[] = [];
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() === 'link' && typeof value === 'string' && value.length > 0) {
      linkValues.push(value);
    }
  }
  const links = parseLinkHeader(linkValues, url);
  const handoff = extractHandoff(links);

  const result: PlaywrightDiscoveryResult = {
    url,
    status: response.status,
    links,
    handoff,
  };

  if (options.discover && links.length > 0) {
    const discovery = await discoverLinks(links, { fetchImpl: asWebFetch(fetchImpl) });
    result.discovery = {
      catalog: discovery.catalog,
      serviceDesc: discovery.serviceDesc,
      serviceMeta: discovery.serviceMeta,
      status: discovery.status,
      llmsTxt: discovery.llmsTxt,
      failures: discovery.failures,
    };
  } else if (options.discover) {
    // Always emit a discovery slot when the caller asked for one, so
    // downstream parsers can distinguish "no follow-up needed" from
    // "follow-up not requested".
    result.discovery = { failures: [] };
  }

  // Hostname → browse.sh skills lookup. Lazy-warms the catalog cache on
  // cold shells; reuses it on subsequent --discover calls. Catalog fetch
  // failures surface as `browseShWarning` (piped to stderr by the caller)
  // and the field is omitted — discovery proceeds either way.
  if (options.discover && options.fs) {
    const match = await matchBrowseShSkillsForUrl(url, options.fs, fetchImpl);
    if (match.warning) {
      result.browseShWarning = match.warning;
    } else if (match.skills && match.skills.length > 0) {
      result.discovery = {
        ...(result.discovery ?? { failures: [] }),
        browseShSkills: match.skills,
      };
    }
  }

  return result;
}
