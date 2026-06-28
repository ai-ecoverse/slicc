/**
 * upskill — `upskill tabs` discovery subcommand.
 *
 * Extracted verbatim from `upskill-command.ts`. Surfaces skill suggestions for
 * the user's open browser tabs: origin-advertised `upskill` rels (parsed from
 * Link headers) plus browse.sh catalog matches by hostname. All network I/O
 * routes through the injected `fetch: SecureFetch`.
 *
 * `normalizeHostname` lives in `../registries/browse-sh.js` (moved there in
 * Wave 2 to break a cycle); we import it here rather than redefining it.
 */

import type { SecureFetch } from 'just-bash';
import type { BrowserAPI, PageInfo } from '../../../cdp/index.js';
import type { VirtualFS } from '../../../fs/index.js';
import { extractHandoff, UPSKILL_REL } from '../../../net/handoff-link.js';
import { parseLinkHeader } from '../../../net/link-header.js';
import { getInstalledSkillNames } from './catalog/catalog.js';
import { fetchBrowseShCatalog, normalizeHostname } from './registries/browse-sh.js';
import type {
  BrowseShSkillSummary,
  TabCatalogMatch,
  TabUpskillLink,
  TabUpskillResult,
} from './types.js';

export { normalizeHostname };

/**
 * Build the install-hint shell line for an origin-advertised upskill rel.
 * Mirrors the dispatch contract the cone's handoff SKILL renders, so the
 * line we print to the terminal is exactly what the user (or the cone, if
 * they pipe it) should run.
 */
function buildOriginInstallHint(target: string, branch?: string, path?: string): string {
  let cmd = `upskill ${target}`;
  if (branch) cmd += ` --branch ${branch}`;
  if (path) cmd += ` --path ${path}`;
  return cmd;
}

/**
 * Fetch a single tab's URL, parse Link headers, and surface every
 * origin-advertised `upskill` rel. Failures are returned in the result's
 * `failures` array (matches `discoverLinks`' contract) rather than thrown
 * so one bad tab doesn't sink the whole listing.
 */
async function discoverTabUpskill(
  url: string,
  fetchFn: SecureFetch
): Promise<{ links: TabUpskillLink[]; failures: TabUpskillResult['failures'] }> {
  const failures: TabUpskillResult['failures'] = [];
  let response: Awaited<ReturnType<SecureFetch>>;
  try {
    response = await fetchFn(url, { method: 'GET' });
  } catch (err) {
    failures.push({
      rel: UPSKILL_REL,
      href: url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { links: [], failures };
  }

  const linkValues: string[] = [];
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (name.toLowerCase() === 'link' && typeof value === 'string' && value.length > 0) {
      linkValues.push(value);
    }
  }
  if (linkValues.length === 0) return { links: [], failures };

  const parsed = parseLinkHeader(linkValues, url);
  const links: TabUpskillLink[] = [];
  // Surface every upskill rel on the page (extractHandoff returns only the
  // first match — for the tabs listing we want each one so users can choose).
  for (const link of parsed) {
    if (!link.rel.includes(UPSKILL_REL)) continue;
    const single = extractHandoff([link]);
    if (single?.verb !== 'upskill') continue;
    links.push({
      target: single.target,
      branch: single.branch,
      path: single.path,
      instruction: single.instruction,
      installHint: buildOriginInstallHint(single.target, single.branch, single.path),
    });
  }
  return { links, failures };
}

function buildCatalogMatchesForTab(
  normalized: string,
  catalog: BrowseShSkillSummary[],
  installed: Set<string>
): TabCatalogMatch[] {
  if (!normalized || catalog.length === 0) return [];
  const matches: TabCatalogMatch[] = [];
  for (const s of catalog) {
    if (!s.hostname) continue;
    if (normalizeHostname(s.hostname) !== normalized) continue;
    // Mirror `installFromBrowseSh`'s dirname rule: prefer the catalog's
    // `name` (parsed from upstream frontmatter at publish time) and
    // only strip the trailing `-xxxxxx` disambiguation hash when we
    // have to fall back to `task`.
    const skillName = s.name || s.task.replace(/-[A-Za-z0-9]{4,8}$/, '') || s.task;
    const dirName = `browse-${s.hostname}-${skillName}`;
    matches.push({
      slug: s.slug,
      hostname: s.hostname,
      task: s.task,
      title: s.title || s.name || s.task,
      description: s.description,
      installed: installed.has(dirName),
      installHint: `upskill browse:${s.hostname}/${s.task}`,
    });
  }
  return matches;
}

function formatTabText(tab: TabUpskillResult): string {
  const activeMark = tab.active ? ' [active]' : '';
  let out = `${tab.title || '(untitled)'}${activeMark}\n`;
  out += `  ${tab.url}\n`;
  if (tab.origin.length > 0) {
    out += `  Origin-advertised:\n`;
    for (const link of tab.origin) {
      out += `    ${link.installHint}`;
      if (link.instruction) out += `   # ${link.instruction}`;
      out += '\n';
    }
  }
  if (tab.catalog.length > 0) {
    out += `  Browse.sh catalog:\n`;
    for (const match of tab.catalog) {
      const marker = match.installed ? '✓' : ' ';
      out += `    ${marker} ${match.title.padEnd(40)} ${match.installHint}\n`;
    }
  }
  if (tab.origin.length === 0 && tab.catalog.length === 0 && !tab.failures.length) {
    out += `  No skill suggestions for this tab.\n`;
  }
  for (const f of tab.failures) {
    out += `  (discovery failed: ${f.error})\n`;
  }
  out += '\n';
  return out;
}

/**
 * Handle the `upskill tabs` subcommand.
 */
export async function handleTabs(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  browser: BrowserAPI | undefined,
  jsonMode: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!browser) {
    return {
      stdout: '',
      stderr: 'upskill: browser APIs unavailable in this environment\n',
      exitCode: 1,
    };
  }

  let pages: PageInfo[];
  try {
    pages = await browser.listPages();
  } catch {
    try {
      pages = await browser.listAllTargets();
    } catch (err) {
      return {
        stdout: '',
        stderr: `upskill: failed to list browser tabs: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  if (pages.length === 0) {
    if (jsonMode) {
      return { stdout: JSON.stringify({ tabs: [] }, null, 2) + '\n', stderr: '', exitCode: 0 };
    }
    return {
      stdout: 'No open browser tabs.\n',
      stderr: '',
      exitCode: 0,
    };
  }

  // Browse.sh catalog fetch — non-fatal. If it fails, we still surface
  // origin-advertised rels and log a warning to stderr.
  let catalog: BrowseShSkillSummary[] = [];
  let catalogWarning = '';
  try {
    catalog = await fetchBrowseShCatalog(fetchFn);
  } catch (err) {
    catalogWarning = `upskill: warning: browse.sh catalog unavailable: ${err instanceof Error ? err.message : String(err)}\n`;
  }

  const installed = await getInstalledSkillNames(fs);

  const results: TabUpskillResult[] = [];
  for (const page of pages) {
    let host = '';
    try {
      host = new URL(page.url).hostname;
    } catch {
      // Non-HTTP URLs (chrome://, about:, etc.) — skip discovery/catalog match.
    }
    const normalized = host ? normalizeHostname(host) : '';

    let origin: TabUpskillLink[] = [];
    let failures: TabUpskillResult['failures'] = [];
    if (host && /^https?:/i.test(page.url)) {
      const discovered = await discoverTabUpskill(page.url, fetchFn);
      origin = discovered.links;
      failures = discovered.failures;
    }

    const catalogMatches = buildCatalogMatchesForTab(normalized, catalog, installed);

    results.push({
      targetId: page.targetId,
      title: page.title,
      url: page.url,
      hostname: normalized,
      active: page.active,
      origin,
      catalog: catalogMatches,
      failures,
    });
  }

  if (jsonMode) {
    return {
      stdout: JSON.stringify({ tabs: results }, null, 2) + '\n',
      stderr: catalogWarning,
      exitCode: 0,
    };
  }

  let output = '';
  for (const tab of results) {
    output += formatTabText(tab);
  }

  return { stdout: output, stderr: catalogWarning, exitCode: 0 };
}
