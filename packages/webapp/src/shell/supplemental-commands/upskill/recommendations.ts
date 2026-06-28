/**
 * upskill — recommendations engine.
 *
 * Extracted verbatim from `upskill-command.ts`. Installs all recommended
 * skills for the current user profile, grouping by repo so each ZIP is
 * downloaded only once. All network I/O routes through the injected
 * `fetch: SecureFetch`. Consumed by `upskill recommendations --install` and
 * the onboarding orchestrator; the monolith re-exports `installRecommendedSkills`.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import {
  getInstalledSkillNames,
  mergeCatalogs,
  normalizeProfile,
  scoreSkills,
} from './catalog/catalog.js';
import { fetchCompanyCatalog, fetchGlobalCatalog } from './catalog/catalog-fetch.js';
import { createGitHubRequestContext } from './github/github-auth.js';
import { installFromGitHub, listGitHubSkills } from './github/github-install.js';
import { fetchRepoZip, stripZipPrefix } from './github/github-zip.js';
import { installSkillFromZip, runPostInstallHooks } from './install-pipeline.js';
import type { CatalogSkill, GitHubRequestContext, ScoredSkill, UserProfile } from './types.js';
import { SKILL_CATALOG_URL } from './types.js';

type RecommendInstallRecord = { ok: boolean; name: string; error?: string };
type RepoGroupResult = { errors: string[]; results: RecommendInstallRecord[]; output: string };

function resolveZipSkillPath(
  rec: ScoredSkill,
  repoKey: string,
  skillIndex: Map<string, string>
): { skillPath: string; skillName: string } | { error: string } {
  const src = rec.entry.source;
  if (src.skill) {
    const p = skillIndex.get(src.skill);
    if (p) return { skillPath: p, skillName: src.skill };
    if (src.path) return { skillPath: src.path.replace(/^\/|\/$/g, ''), skillName: src.skill };
    return { error: `skill "${src.skill}" not found in ${repoKey}` };
  }
  if (src.path) return { skillPath: src.path.replace(/^\/|\/$/g, ''), skillName: rec.entry.name };
  const p = skillIndex.get(rec.entry.name);
  if (p) return { skillPath: p, skillName: rec.entry.name };
  return {
    error: `skill "${rec.entry.name}" not found in ${repoKey} and no explicit path provided`,
  };
}

async function installZipBundleForRec(
  rec: ScoredSkill,
  repoKey: string,
  files: Record<string, Uint8Array>,
  skillIndex: Map<string, string>,
  installed: Set<string>,
  fs: VirtualFS,
  completedCount: number,
  totalSkills: number,
  startTime: number
): Promise<{ results: RecommendInstallRecord[]; line: string }> {
  const src = rec.entry.source;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const pathPrefix = src.path!.replace(/^\/|\/$/g, '');
  const eta =
    completedCount < totalSkills
      ? ` (~${Math.round(((totalSkills - completedCount) * (Date.now() - startTime)) / completedCount / 1000)}s remaining)`
      : '';
  const targets: Array<{ name: string; path: string }> = [];
  for (const [name, p] of skillIndex) {
    if (p === pathPrefix || p.startsWith(`${pathPrefix}/`)) targets.push({ name, path: p });
  }
  if (targets.length === 0) {
    const error = `no skills found under "${src.path}" in ${repoKey}`;
    return {
      results: [{ ok: false, name: rec.entry.name, error }],
      line: `[${completedCount}/${totalSkills}] Failed "${rec.entry.name}" bundle from ${repoKey}: ${error}${eta}\n`,
    };
  }
  const bundleStart = Date.now();
  let bundleSuccess = 0;
  let bundleFailed = 0;
  const results: RecommendInstallRecord[] = [];
  for (const target of targets) {
    // Per-sub-skill dedup so a partially-installed bundle still
    // gets the missing companions filled in.
    if (installed.has(target.name)) continue;
    const r = await installSkillFromZip(target.path, target.name, files, fs, false);
    if (r.ok) {
      results.push({ ok: true, name: target.name });
      bundleSuccess++;
    } else {
      results.push({ ok: false, name: target.name, error: r.error });
      bundleFailed++;
    }
  }
  const dur = ((Date.now() - bundleStart) / 1000).toFixed(1);
  let line: string;
  if (bundleSuccess === 0 && bundleFailed === 0)
    line = `[${completedCount}/${totalSkills}] Skipped "${rec.entry.name}" bundle from ${repoKey}: all sub-skills already installed${eta}\n`;
  else if (bundleFailed === 0)
    line = `[${completedCount}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess} skill(s)) from ${repoKey} (${dur}s)${eta}\n`;
  else
    line = `[${completedCount}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess}/${bundleSuccess + bundleFailed} skill(s)) from ${repoKey} (${dur}s)${eta}\n`;
  return { results, line };
}

async function installApiBundleForRec(
  rec: ScoredSkill,
  repoKey: string,
  owner: string,
  repo: string,
  github: GitHubRequestContext,
  installed: Set<string>,
  fs: VirtualFS,
  completedCount: number,
  totalSkills: number,
  startTime: number
): Promise<{ results: RecommendInstallRecord[]; line: string }> {
  const src = rec.entry.source;
  const eta =
    completedCount < totalSkills
      ? ` (~${Math.round(((totalSkills - completedCount) * (Date.now() - startTime)) / completedCount / 1000)}s remaining)`
      : '';
  const listResult = await listGitHubSkills(owner, repo, github, src.path);
  if (listResult.error) {
    return {
      results: [{ ok: false, name: rec.entry.name, error: listResult.error }],
      line: `[${completedCount}/${totalSkills}] Failed "${rec.entry.name}" bundle from ${repoKey}: ${listResult.error}${eta}\n`,
    };
  }
  const bundleStart = Date.now();
  let bundleSuccess = 0;
  let bundleFailed = 0;
  const results: RecommendInstallRecord[] = [];
  for (const skill of listResult.skills) {
    if (installed.has(skill.name)) continue;
    const r = await installFromGitHub(owner, repo, skill.path, skill.name, fs, github, false);
    if (r.exitCode === 0) {
      results.push({ ok: true, name: skill.name });
      bundleSuccess++;
    } else {
      results.push({ ok: false, name: skill.name, error: r.stderr.trim() });
      bundleFailed++;
    }
  }
  const dur = ((Date.now() - bundleStart) / 1000).toFixed(1);
  let line: string;
  if (bundleSuccess === 0 && bundleFailed === 0)
    line = `[${completedCount}/${totalSkills}] Skipped "${rec.entry.name}" bundle from ${repoKey}: all sub-skills already installed${eta}\n`;
  else if (bundleFailed === 0)
    line = `[${completedCount}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess} skill(s)) from ${repoKey} (${dur}s)${eta}\n`;
  else
    line = `[${completedCount}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess}/${bundleSuccess + bundleFailed} skill(s)) from ${repoKey} (${dur}s)${eta}\n`;
  return { results, line };
}

async function installRepoViaZip(
  repoKey: string,
  recs: ScoredSkill[],
  files: Record<string, Uint8Array>,
  completedRef: { count: number },
  totalSkills: number,
  startTime: number,
  installed: Set<string>,
  fs: VirtualFS
): Promise<RepoGroupResult> {
  // Precompute skill index: map skillName → path for all SKILL.md entries
  const skillIndex = new Map<string, string>();
  for (const p of Object.keys(files)) {
    if (p.endsWith('/SKILL.md')) {
      const skillDir = p.replace(/\/SKILL\.md$/, '');
      skillIndex.set(skillDir.split('/').pop() || skillDir, skillDir);
    }
  }
  const results: RecommendInstallRecord[] = [];
  let output = '';
  for (const rec of recs) {
    const src = rec.entry.source;
    // Bundle install: install ALL skills under src.path.
    if (src.installAll && src.path) {
      completedRef.count++;
      const bundle = await installZipBundleForRec(
        rec,
        repoKey,
        files,
        skillIndex,
        installed,
        fs,
        completedRef.count,
        totalSkills,
        startTime
      );
      results.push(...bundle.results);
      output += bundle.line;
      continue;
    }
    const resolved = resolveZipSkillPath(rec, repoKey, skillIndex);
    if ('error' in resolved) {
      results.push({ ok: false, name: rec.entry.name, error: resolved.error });
      completedRef.count++;
      const eta =
        completedRef.count < totalSkills
          ? ` (~${Math.round(((totalSkills - completedRef.count) * (Date.now() - startTime)) / completedRef.count / 1000)}s remaining)`
          : '';
      output += `[${completedRef.count}/${totalSkills}] Failed "${rec.entry.name}" from ${repoKey}: ${resolved.error}${eta}\n`;
      continue;
    }
    const { skillPath, skillName } = resolved;
    const skillStart = Date.now();
    const result = await installSkillFromZip(skillPath, skillName, files, fs, false);
    completedRef.count++;
    const skillDuration = ((Date.now() - skillStart) / 1000).toFixed(1);
    const avgTime = (Date.now() - startTime) / completedRef.count;
    const remaining = Math.round(((totalSkills - completedRef.count) * avgTime) / 1000);
    const eta = completedRef.count < totalSkills ? ` (~${remaining}s remaining)` : '';
    if (result.ok) {
      results.push({ ok: true, name: skillName });
      output += `[${completedRef.count}/${totalSkills}] Installed "${skillName}" from ${repoKey} (${skillDuration}s)${eta}\n`;
    } else {
      results.push({ ok: false, name: skillName, error: result.error });
      output += `[${completedRef.count}/${totalSkills}] Failed "${skillName}" from ${repoKey}: ${result.error}${eta}\n`;
    }
  }
  return { errors: [], results, output };
}

async function installRepoViaApi(
  repoKey: string,
  recs: ScoredSkill[],
  owner: string,
  repo: string,
  completedRef: { count: number },
  totalSkills: number,
  startTime: number,
  installed: Set<string>,
  fetchFn: SecureFetch,
  fs: VirtualFS
): Promise<RepoGroupResult> {
  const github = await createGitHubRequestContext(fetchFn);
  const results: RecommendInstallRecord[] = [];
  let output = '';
  for (const rec of recs) {
    const src = rec.entry.source;
    completedRef.count++;
    const eta =
      completedRef.count < totalSkills
        ? ` (~${Math.round(((totalSkills - completedRef.count) * (Date.now() - startTime)) / completedRef.count / 1000)}s remaining)`
        : '';
    if (src.installAll && src.path) {
      const bundle = await installApiBundleForRec(
        rec,
        repoKey,
        owner,
        repo,
        github,
        installed,
        fs,
        completedRef.count,
        totalSkills,
        startTime
      );
      results.push(...bundle.results);
      output += bundle.line;
      continue;
    }
    const skillPath = src.path ? src.path.replace(/^\/|\/$/g, '') : rec.entry.name;
    const skillName = src.skill || rec.entry.name;
    const r = await installFromGitHub(owner, repo, skillPath, skillName, fs, github, false);
    if (r.exitCode === 0) {
      output += `[${completedRef.count}/${totalSkills}] Installed "${skillName}" from ${repoKey}${eta}\n`;
      results.push({ ok: true, name: skillName });
    } else {
      output += `[${completedRef.count}/${totalSkills}] Failed "${skillName}" from ${repoKey}: ${r.stderr.trim()}${eta}\n`;
      results.push({ ok: false, name: skillName, error: r.stderr.trim() });
    }
  }
  return { errors: [], results, output };
}

/**
 * Result of {@link installRecommendedSkills}.
 *
 * - `installedNames`: skills that successfully landed under `/workspace/skills/`.
 * - `errors`: human-readable failure lines (one per failed skill / repo).
 * - `skipped`: present when the install was a non-error no-op:
 *     - `'no-profile'`     — `/home/<name>/.welcome.json` is missing.
 *     - `'all-installed'`  — every recommended skill was already on disk.
 *     - `'catalog-fetch'`  — the catalog HTTP request failed; details in `errors`.
 *
 * The shell command (`upskill recommendations --install`) and the onboarding
 * orchestrator both consume this — the shell renders it into stdout/stderr;
 * the orchestrator just logs it and moves on.
 */
export interface InstallRecommendationsResult {
  installedNames: string[];
  errors: string[];
  skipped: 'no-profile' | 'all-installed' | 'catalog-fetch' | null;
  /** Per-skill install log, ready to print verbatim into stdout. */
  log: string;
  /** Total wall-clock seconds for the install pass. */
  elapsedSeconds: number;
}

function collectRepoGroupResults(
  settled: PromiseSettledResult<RepoGroupResult>[],
  errors: string[],
  installedNames: string[]
): string {
  let log = '';
  for (const result of settled) {
    if (result.status === 'rejected') {
      errors.push(`upskill: unexpected error: ${result.reason}`);
      continue;
    }
    log += result.value.output;
    for (const e of result.value.errors) errors.push(e);
    for (const r of result.value.results) {
      if (r.ok) installedNames.push(r.name);
      else if (r.error) errors.push(`upskill: ${r.error}`);
    }
  }
  return log;
}

/**
 * Install all recommended skills for the current user profile, bypassing
 * the shell. Used both by `upskill recommendations --install` and by the
 * onboarding orchestrator (which fires this in the background after the
 * welcome wizard completes).
 *
 * When called from the orchestrator, the in-memory profile is passed
 * directly via `profileOverride` to avoid racing with the parallel
 * `persistProfile` write — the install otherwise lands before the
 * `/home/<user>/.welcome.json` file exists on disk and skips with
 * `skipped: 'no-profile'`.
 *
 * Errors are collected into the result; this function does not throw.
 * Post-install hooks (`__slicc_reloadSkills`, sprinkle refresh) run iff
 * at least one skill was installed successfully.
 */
export async function installRecommendedSkills(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  profileOverride?: Partial<UserProfile> | null
): Promise<InstallRecommendationsResult> {
  const startTime = Date.now();
  const empty = (
    skipped: InstallRecommendationsResult['skipped'],
    errors: string[] = []
  ): InstallRecommendationsResult => ({
    installedNames: [],
    errors,
    skipped,
    log: '',
    elapsedSeconds: (Date.now() - startTime) / 1000,
  });

  let profile: UserProfile | null = null;

  // Fast path — caller (orchestrator) supplied the freshly-collected
  // profile so we don't have to wait for the parallel persistProfile()
  // write to land on disk.
  if (profileOverride) {
    profile = normalizeProfile(profileOverride);
  } else {
    // Fallback path — read from disk (`upskill recommendations --install`
    // shell command, or any caller that doesn't have the profile in hand).
    try {
      const homeDirs = await fs.readDir('/home');
      for (const entry of homeDirs) {
        try {
          const raw = await fs.readTextFile(`/home/${entry.name}/.welcome.json`);
          profile = normalizeProfile(JSON.parse(raw) as Partial<UserProfile>);
          break;
        } catch {
          // no .welcome.json in this dir
        }
      }
    } catch {
      // /home doesn't exist
    }
  }

  if (!profile) return empty('no-profile');

  // Fetch catalog, optional company catalog, and installed names in parallel.
  // The company catalog (when profile.company is set) is best-effort — its
  // failure is silently ignored so an unrecognized company never blocks
  // recommendations from the global catalog.
  let catalogSkills: CatalogSkill[];
  let installed: Set<string>;
  try {
    const [catalogResult, companyResult, installedResult] = await Promise.all([
      fetchGlobalCatalog(fetchFn),
      fetchCompanyCatalog(fetchFn, profile.company),
      getInstalledSkillNames(fs),
    ]);
    catalogSkills = mergeCatalogs(catalogResult, companyResult);
    installed = installedResult;
  } catch (err) {
    return empty('catalog-fetch', [
      `upskill: failed to fetch skill catalog from ${SKILL_CATALOG_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ]);
  }

  const scored = scoreSkills(catalogSkills, profile).filter((s) => !installed.has(s.entry.name));
  if (scored.length === 0) return empty('all-installed');

  // Group scored entries by repo so each ZIP is downloaded only once
  const repoGroups = new Map<string, ScoredSkill[]>();
  for (const rec of scored) {
    const repoKey = rec.entry.source.repo;
    const group = repoGroups.get(repoKey);
    if (group) group.push(rec);
    else repoGroups.set(repoKey, [rec]);
  }

  const totalSkills = scored.length;
  const completedRef = { count: 0 };
  const errors: string[] = [];
  const installedNames: string[] = [];
  let log = '';

  // Process repos in parallel, skills within each repo sequentially (shared ZIP)
  const repoResults = await Promise.allSettled(
    Array.from(repoGroups.entries()).map(async ([repoKey, recs]) => {
      const [owner, repo] = repoKey.split('/');
      const zip = await fetchRepoZip(owner, repo, fetchFn);
      if (zip.status === 'error') {
        // ZIP unavailable — fall back to Contents API per skill/bundle
        return installRepoViaApi(
          repoKey,
          recs,
          owner,
          repo,
          completedRef,
          totalSkills,
          startTime,
          installed,
          fetchFn,
          fs
        );
      }
      return installRepoViaZip(
        repoKey,
        recs,
        stripZipPrefix(zip.files),
        completedRef,
        totalSkills,
        startTime,
        installed,
        fs
      );
    })
  );

  log = collectRepoGroupResults(repoResults, errors, installedNames);

  const elapsedSeconds = (Date.now() - startTime) / 1000;
  if (installedNames.length > 0) {
    await runPostInstallHooks();
    log += `\nInstalled ${installedNames.length} recommended skill(s) in ${elapsedSeconds.toFixed(1)}s\n`;
  }

  return {
    installedNames,
    errors,
    skipped: null,
    log,
    elapsedSeconds,
  };
}
