import type { SecureFetch } from 'just-bash';
import { parseFetchJson } from '../../../fetch-body.js';
import { describeFetchError } from '../fetch-error.js';
import { parseGitHubUrl } from '../github/github-install.js';
import type { TesslSearchResponse, UnifiedSearchResult } from '../types.js';
import { TESSL_API } from '../types.js';

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

  const seen = new Map<string, UnifiedSearchResult>();
  for (const item of data.data) {
    if (item.type !== 'skill') continue;
    const a = item.attributes;
    const gh = parseGitHubUrl(a.sourceUrl);
    const repo = gh ? `${gh.owner}/${gh.repo}` : undefined;
    const score = a.scores.aggregate != null ? Math.round(a.scores.aggregate * 100) : null;
    const key = a.sourceUrl || item.id;
    const existing = seen.get(key);

    if (
      existing &&
      existing.qualityScore != null &&
      score != null &&
      existing.qualityScore >= score
    )
      continue;

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

  const match = data.data?.find((item) => item.type === 'skill' && item.attributes.name === name);
  if (!match) {
    return { error: `skill "${name}" not found on Tessl registry` };
  }
  const gh = parseGitHubUrl(match.attributes.sourceUrl);
  if (!gh) {
    return { error: `skill "${name}" has no GitHub source URL` };
  }

  const skillDir = match.attributes.path.replace(/\/SKILL\.md$/i, '');
  return { owner: gh.owner, repo: gh.repo, skillPath: skillDir, skillName: name };
}
