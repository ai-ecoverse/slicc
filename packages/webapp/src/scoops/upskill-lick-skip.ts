import { parseGitHubRef } from '../shell/supplemental-commands/upskill/github/github-install.js';
import type { UpskillProvenance } from '../shell/supplemental-commands/upskill/provenance.js';

export type UpskillLickCardDecision = 'raise' | 'skip-same-sha' | 'skip-no-provenance';

export interface UpskillLickSkipInput {
  target: string;
  branch?: string;
  path?: string;
  provenanced: Array<{ name: string; provenance: UpskillProvenance }>;
  unattributed: string[];
  resolveSha: (args: {
    owner: string;
    repo: string;
    ref?: string;
    path?: string;
  }) => Promise<string | undefined>;
}

export function normalizeUpskillPath(path?: string): string {
  return (path ?? '').replace(/^\/+|\/+$/g, '');
}

export function shaEqual(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return true;
  return left.startsWith(right) || right.startsWith(left);
}

function skillNameFromPath(path: string): string | undefined {
  const normalized = normalizeUpskillPath(path);
  if (!normalized) return undefined;
  return normalized.split('/').pop() || undefined;
}

function advertisedMatches(
  provenance: UpskillProvenance,
  source: string,
  advertisedPath: string
): boolean {
  if (provenance.kind !== 'github' || provenance.source !== source) return false;
  const installed = normalizeUpskillPath(provenance.path);
  if (!advertisedPath) return true;
  if (installed === advertisedPath) return true;
  if (installed.startsWith(`${advertisedPath}/`)) return true;
  const name = skillNameFromPath(advertisedPath);
  return Boolean(name && (provenance.skill === name || provenance.skill === advertisedPath));
}

export async function shouldSkipNavigateUpskill(
  event: { body?: unknown },
  getConeFs: () => {
    readDir(path: string): Promise<unknown>;
    readTextFile(path: string): Promise<string>;
  } | null
): Promise<boolean> {
  const body = (event.body ?? {}) as {
    verb?: unknown;
    target?: unknown;
    branch?: unknown;
    path?: unknown;
  };
  if (body.verb !== 'upskill' || typeof body.target !== 'string' || !body.target) {
    return false;
  }
  const fs = getConeFs();
  if (!fs) return false;
  const [
    { scanSkillProvenance, resolveCommitSha },
    { createProxiedFetch },
    { createGitHubRequestContext },
  ] = await Promise.all([
    import('../shell/supplemental-commands/upskill/provenance.js'),
    import('../shell/proxied-fetch.js'),
    import('../shell/supplemental-commands/upskill/github/github-auth.js'),
  ]);
  const scan = await scanSkillProvenance(fs as import('../fs/virtual-fs.js').VirtualFS);
  const github = await createGitHubRequestContext(createProxiedFetch());
  const decision = await decideUpskillLickCard({
    target: body.target,
    branch: typeof body.branch === 'string' ? body.branch : undefined,
    path: typeof body.path === 'string' ? body.path : undefined,
    provenanced: scan.provenanced,
    unattributed: scan.unattributed,
    resolveSha: ({ owner, repo, ref, path }) =>
      resolveCommitSha(owner, repo, ref, github, true, path),
  });
  return decision !== 'raise';
}

export async function decideUpskillLickCard(
  input: UpskillLickSkipInput
): Promise<UpskillLickCardDecision> {
  const parsed = parseGitHubRef(input.target);
  if (!parsed) return 'raise';

  const source = `${parsed.owner}/${parsed.repo}`;
  const advertisedPath = normalizeUpskillPath(input.path ?? parsed.path);
  const advertisedRef = input.branch ?? parsed.branch;
  const matching = input.provenanced.filter(({ provenance }) =>
    advertisedMatches(provenance, source, advertisedPath)
  );
  const skillName = skillNameFromPath(advertisedPath);

  if (matching.length === 0) {
    return skillName && input.unattributed.includes(skillName) ? 'skip-no-provenance' : 'raise';
  }

  const recorded = matching
    .map(({ provenance }) => provenance.sha)
    .filter((sha): sha is string => typeof sha === 'string' && sha.length > 0);
  if (recorded.length !== matching.length) return 'skip-no-provenance';

  const upstream = await input.resolveSha({
    owner: parsed.owner,
    repo: parsed.repo,
    ref: advertisedRef,
    path: advertisedPath || undefined,
  });
  if (!upstream) return 'skip-no-provenance';
  return recorded.every((sha) => shaEqual(sha, upstream)) ? 'skip-same-sha' : 'raise';
}
