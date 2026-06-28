/**
 * upskill — Tessl registry backend.
 *
 * Extracted verbatim from `upskill-command.ts`. Searches the Tessl registry
 * and resolves `tessl:<name>` refs to their GitHub source. All network I/O
 * routes through the injected `fetch: SecureFetch`.
 */

import type { SecureFetch } from 'just-bash';
import { parseFetchJson } from '../../../fetch-body.js';
import { describeFetchError } from '../fetch-error.js';
import { parseGitHubUrl } from '../github/github-install.js';
import type { TesslSearchResponse, UnifiedSearchResult } from '../types.js';
import { TESSL_API } from '../types.js';

/**
 * Search Tessl registry for skills, returning unified results.
 */
export async function fetchTesslResults(
  query: string,
  fetch: SecureFetch
): Promise<UnifiedSearchResult[]> {
  const url = `${TESSL_API}/experimental/search?q=${encodeURIComponent(query)}&contentType=skills&page%5Bsize%5D=20`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  if (response.status !== 200) throw new Error(`Tessl returned HTTP ${response.status}`);
  const data = parseFetchJson<TesslSearchResponse>(response.body);
  if (!data.data) return [];

  // Filter to skills only (exclude tiles), deduplicate by sourceUrl
  const seen = new Map<string, UnifiedSearchResult>();
  for (const item of data.data) {
    if (item.type !== 'skill') continue;
    const a = item.attributes;
    const gh = parseGitHubUrl(a.sourceUrl);
    const repo = gh ? `${gh.owner}/${gh.repo}` : undefined;
    const score = a.scores.aggregate != null ? Math.round(a.scores.aggregate * 100) : null;
    const key = a.sourceUrl || item.id;
    const existing = seen.get(key);
    // Keep the highest-scored entry per source repo
    if (
      existing &&
      existing.qualityScore != null &&
      score != null &&
      existing.qualityScore >= score
    )
      continue;
    // Derive skill directory from path (parent of SKILL.md)
    const skillDir = a.path.replace(/\/SKILL\.md$/i, '');
    const skillId = skillDir.split('/').pop() || a.name;
    const installHint = gh
      ? `upskill ${gh.owner}/${gh.repo} --path ${skillDir.split('/').slice(0, -1).join('/') || '.'} --skill ${skillId}`
      : `upskill tessl:${a.name}`;
    seen.set(key, {
      name: a.name,
      displayName: a.name,
      summary: a.description || '',
      source: 'tessl' as const,
      qualityScore: score,
      installHint,
      featured: a.featured,
      sourceRepo: repo,
    });
  }
  return Array.from(seen.values());
}

/**
 * Parse Tessl reference (tessl:name) and resolve to GitHub source.
 */
export async function resolveTesslRef(
  name: string,
  fetch: SecureFetch
): Promise<
  { owner: string; repo: string; skillPath: string; skillName: string } | { error: string }
> {
  const url = `${TESSL_API}/experimental/search?q=${encodeURIComponent(name)}&contentType=skills&page%5Bsize%5D=5`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    return { error: `Tessl search failed: ${describeFetchError(err, url)}` };
  }
  if (response.status !== 200) {
    return { error: `Tessl search failed (HTTP ${response.status})` };
  }
  const data = parseFetchJson<TesslSearchResponse>(response.body);
  // Find exact name match among skills
  const match = data.data?.find((item) => item.type === 'skill' && item.attributes.name === name);
  if (!match) {
    return { error: `skill "${name}" not found on Tessl registry` };
  }
  const gh = parseGitHubUrl(match.attributes.sourceUrl);
  if (!gh) {
    return { error: `skill "${name}" has no GitHub source URL` };
  }
  // Derive skill directory path (parent of SKILL.md)
  const skillDir = match.attributes.path.replace(/\/SKILL\.md$/i, '');
  return { owner: gh.owner, repo: gh.repo, skillPath: skillDir, skillName: name };
}
