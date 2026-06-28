/**
 * upskill — registry search aggregation.
 *
 * Extracted verbatim from `upskill-command.ts`. Fans out to each registry
 * backend, interleaves the results round-robin, and paginates. All network I/O
 * routes through the injected `fetch: SecureFetch`.
 */

import type { SecureFetch } from 'just-bash';
import type { UnifiedSearchResult } from '../types.js';
import { BROWSE_SH_API, TESSL_API } from '../types.js';
import { fetchBrowseShResults } from './browse-sh.js';
import { fetchTesslResults } from './tessl.js';

/**
 * Search registries for skills, merge and paginate results.
 *
 * Structured as a list of registry fetchers so additional backends (e.g.
 * browse.sh) can plug in alongside Tessl without restructuring the merge,
 * pagination, or error-handling logic below.
 */
const SEARCH_PAGE_SIZE = 10;

interface RegistrySource {
  label: string;
  host: string;
  fetch: (query: string, fetch: SecureFetch) => Promise<UnifiedSearchResult[]>;
}

const REGISTRY_SOURCES: RegistrySource[] = [
  { label: 'Tessl', host: new URL(TESSL_API).host, fetch: fetchTesslResults },
  { label: 'browse.sh', host: new URL(BROWSE_SH_API).host, fetch: fetchBrowseShResults },
];

/**
 * Round-robin interleave per-source result lists, preserving within-source
 * order. Take the first hit from each source in order, then the second from
 * each, etc., skipping any source that has been exhausted. This gives each
 * registry visibility in the top page of results rather than burying browse.sh
 * behind Tessl (or vice versa).
 */
export function interleaveResults(perSource: UnifiedSearchResult[][]): UnifiedSearchResult[] {
  const merged: UnifiedSearchResult[] = [];
  const maxLen = perSource.reduce((m, list) => Math.max(m, list.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of perSource) {
      if (i < list.length) merged.push(list[i]);
    }
  }
  return merged;
}

export async function searchRegistries(
  query: string,
  fetch: SecureFetch,
  page: number = 1
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const settled = await Promise.allSettled(REGISTRY_SOURCES.map((src) => src.fetch(query, fetch)));

  const perSource = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  const allFailed = settled.every((s) => s.status === 'rejected');
  const merged: UnifiedSearchResult[] = interleaveResults(perSource);

  // Per-source visibility: surface each failing registry on stderr so the user
  // can tell which host went down (e.g. api.tessl.io vs browse.sh) rather than
  // seeing a single generic "no results" line.
  let warnings = '';
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'rejected') {
      const src = REGISTRY_SOURCES[i];
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      warnings += `warning: ${src.label} registry unavailable (${src.host}): ${msg}\n`;
    }
  }

  if (merged.length === 0) {
    const stderr = allFailed ? `${warnings}upskill: registries failed to respond\n` : warnings;
    return {
      stdout: `No skills found for "${query}"\n\nTry a different search term or browse the registries at https://tessl.io/registry or https://browse.sh\n`,
      stderr,
      exitCode: allFailed ? 1 : 0,
    };
  }

  const totalResults = merged.length;
  const totalPages = Math.ceil(totalResults / SEARCH_PAGE_SIZE);
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIdx = (safePage - 1) * SEARCH_PAGE_SIZE;
  const pageResults = merged.slice(startIdx, startIdx + SEARCH_PAGE_SIZE);

  let output = `Search results for "${query}" (page ${safePage}/${totalPages}, ${totalResults} total):\n\n`;

  for (const skill of pageResults) {
    const scoreStr = skill.qualityScore != null ? String(skill.qualityScore).padStart(3) : '   ';
    const tag = `[${skill.source}]`;
    const repoStr = skill.sourceRepo ? `  ${skill.sourceRepo}` : '';
    output += `  ${skill.name.padEnd(30)} ${scoreStr} ${tag.padEnd(10)}${repoStr}\n`;
    if (skill.summary) {
      output += `    ${skill.summary}\n`;
    }
    output += '\n';
  }

  if (safePage < totalPages) {
    output += `Showing ${startIdx + 1}-${startIdx + pageResults.length} of ${totalResults}. `;
    output += `Next page: upskill search ${query} --page ${safePage + 1}\n\n`;
  }

  output += `To install:\n`;
  output += `  From Tessl:    upskill <owner/repo> --skill <name>\n`;
  output += `  From browse.sh: upskill browse:<hostname>/<task>\n`;

  return { stdout: output, stderr: '', exitCode: 0 };
}
