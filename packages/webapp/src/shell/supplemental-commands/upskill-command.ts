/**
 * upskill — skill package manager for SLICC
 *
 * All direct fetch() calls in this file are intentionally shadowed by the
 * `fetch: SecureFetch` parameter passed from createProxiedFetch() in the
 * outer caller. This ensures network requests route through the fetch proxy
 * in CLI mode (forbidden-header bridging) and direct fetch in extension mode
 * (CORS bypass via host_permissions).
 */

import type { Command, CommandContext, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { BrowserAPI, PageInfo } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import {
  extractHandoff,
  isSafeUpskillBranch,
  isSafeUpskillPath,
  UPSKILL_REL,
} from '../../net/handoff-link.js';
import { parseLinkHeader } from '../../net/link-header.js';
import { parseFetchJson } from '../fetch-body.js';
import {
  buildInstallCmd,
  getInstalledSkillNames,
  mergeCatalogs,
  normalizeProfile,
  parseRemoteCatalog,
  scoreSkills,
} from './upskill/catalog/catalog.js';
import { fetchCompanyCatalog, fetchGlobalCatalog } from './upskill/catalog/catalog-fetch.js';
import { _resetGlobalFsCache, createGitHubRequestContext } from './upskill/github/github-auth.js';
import {
  installFromGitHub,
  listGitHubSkills,
  parseGitHubRef,
} from './upskill/github/github-install.js';
import { fetchRepoZip, stripZipPrefix } from './upskill/github/github-zip.js';
import {
  formatDiscoveredSkills,
  formatDiscoveryScope,
  formatSkillInfo,
  upskillHelp,
} from './upskill/help.js';
import { installSkillFromZip, runPostInstallHooks } from './upskill/install-pipeline.js';
import {
  _resetBrowseShCatalogCache,
  fetchBrowseShCatalog,
  installFromBrowseSh,
  normalizeHostname,
  parseBrowseShRef,
} from './upskill/registries/browse-sh.js';
import { searchRegistries } from './upskill/registries/search.js';
import { resolveTesslRef } from './upskill/registries/tessl.js';
import type {
  BrowseShSkillSummary,
  CatalogSkill,
  GitHubRequestContext,
  ParsedUpskillFlags,
  RemoteCatalogRow,
  ScoredSkill,
  TabCatalogMatch,
  TabUpskillLink,
  TabUpskillResult,
  UserProfile,
} from './upskill/types.js';
import { SKILL_CATALOG_URL } from './upskill/types.js';

export type { BrowseShSkillSummary, TabCatalogMatch, TabUpskillLink, TabUpskillResult };
// ── Re-exports (preserve the monolith's public surface during the upskill split) ──
export {
  _resetBrowseShCatalogCache,
  _resetGlobalFsCache,
  fetchBrowseShCatalog,
  normalizeHostname,
  parseBrowseShRef,
  parseGitHubRef,
  scoreSkills,
};

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

// ── upskill tabs ──

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
async function handleTabs(
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

/**
 * Handle the `upskill recommendations` subcommand.
 */
async function handleRecommendations(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  install: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (install) {
    const result = await installRecommendedSkills(fs, fetchFn);

    if (result.skipped === 'no-profile') {
      return {
        stdout: '',
        stderr:
          'upskill: no user profile found. Complete the welcome onboarding first, or create /home/<name>/.welcome.json manually.\n',
        exitCode: 1,
      };
    }
    if (result.skipped === 'catalog-fetch') {
      return {
        stdout: '',
        stderr: result.errors.map((e) => `${e}\n`).join(''),
        exitCode: 1,
      };
    }
    if (result.skipped === 'all-installed') {
      return {
        stdout: 'No new skill recommendations — all matching skills are already installed.\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: result.log,
      stderr: result.errors.map((e) => `${e}\n`).join(''),
      exitCode: result.errors.length > 0 ? 1 : 0,
    };
  }

  // Display-only path (no install) — keep the original recommendation listing.
  let profile: UserProfile | null = null;
  try {
    const homeDirs = await fs.readDir('/home');
    for (const entry of homeDirs) {
      try {
        const raw = await fs.readTextFile(`/home/${entry.name}/.welcome.json`);
        profile = JSON.parse(raw) as UserProfile;
        break;
      } catch {
        // no .welcome.json in this dir
      }
    }
  } catch {
    // /home doesn't exist
  }

  if (!profile) {
    return {
      stdout: '',
      stderr:
        'upskill: no user profile found. Complete the welcome onboarding first, or create /home/<name>/.welcome.json manually.\n',
      exitCode: 1,
    };
  }

  let catalogSkills: CatalogSkill[];
  let installed: Set<string>;
  try {
    const [catalogResult, companyResult, installedResult] = await Promise.all([
      (async () => {
        const response = await fetchFn(SKILL_CATALOG_URL, {
          headers: { Accept: 'application/json' },
        });
        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = parseFetchJson<{ data: RemoteCatalogRow[] }>(response.body);
        return parseRemoteCatalog(data.data);
      })(),
      fetchCompanyCatalog(fetchFn, profile.company),
      getInstalledSkillNames(fs),
    ]);
    catalogSkills = mergeCatalogs(catalogResult, companyResult);
    installed = installedResult;
  } catch (err) {
    return {
      stdout: '',
      stderr: `upskill: failed to fetch skill catalog from ${SKILL_CATALOG_URL}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const scored = scoreSkills(catalogSkills, profile).filter((s) => !installed.has(s.entry.name));

  if (scored.length === 0) {
    return {
      stdout: 'No new skill recommendations — all matching skills are already installed.\n',
      stderr: '',
      exitCode: 0,
    };
  }

  // Display recommendations
  let output = 'Recommended skills for you:\n\n';
  let idx = 0;
  for (const rec of scored) {
    idx++;
    const installCmd = buildInstallCmd(rec.entry.source);
    output += `  ${idx}. ${rec.entry.displayName.padEnd(35)} score: ${Math.round(rec.score)}\n`;
    output += `     ${rec.entry.description}\n`;
    output += `     Match: ${rec.matchReasons.join(', ')}\n`;
    output += `     Install: ${installCmd}\n\n`;
  }

  output += 'To install all recommended: upskill recommendations --install\n';
  return { stdout: output, stderr: '', exitCode: 0 };
}

// ── createUpskillCommand helpers ──

function validateBranchArg(val: string | undefined): ParsedUpskillFlags['earlyReturn'] | null {
  if (!val || val.startsWith('-')) {
    return { stdout: '', stderr: 'upskill: --branch requires a value\n', exitCode: 1 };
  }
  // Defense-in-depth: branch names must satisfy `git check-ref-format`-style
  // allowlist so a mis-quoted splice from a Link header cannot inject commands.
  if (!isSafeUpskillBranch(val)) {
    return {
      stdout: '',
      stderr:
        'upskill: --branch must be a git ref of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", trailing "/" or ".lock", or shell metacharacters\n',
      exitCode: 1,
    };
  }
  return null;
}

function parseUpskillFlags(args: string[]): ParsedUpskillFlags {
  const parsed: ParsedUpskillFlags = {
    selectedSkills: [],
    listOnly: false,
    installAll: false,
    force: false,
    sourceRef: '',
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--skill') {
      parsed.selectedSkills.push(args[++i]);
    } else if (arg === '--path' || arg === '-p') {
      const val = args[++i];
      // Defense-in-depth: even though `handoff-link.ts` already drops
      // unsafe Link-param values before they reach the cone, re-validate
      // here so a future dispatch path (or a hand-typed CLI invocation
      // that splices unsanitized input) still cannot smuggle shell
      // metachars past argv. The allowlist matches the one in
      // `handoff-link.ts` — keep them in sync.
      if (typeof val !== 'string' || !isSafeUpskillPath(val)) {
        parsed.earlyReturn = {
          stdout: '',
          stderr:
            'upskill: --path must be a repo-relative sub-path of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", or shell metacharacters\n',
          exitCode: 1,
        };
        return parsed;
      }
      parsed.subPath = val;
    } else if (arg === '--list') {
      parsed.listOnly = true;
    } else if (arg === '--all') {
      parsed.installAll = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--branch' || arg === '-b') {
      const branchErr = validateBranchArg(args[i + 1]);
      if (branchErr) {
        parsed.earlyReturn = branchErr;
        return parsed;
      }
      parsed.branch = args[++i];
    } else if (!arg.startsWith('-')) {
      parsed.sourceRef = arg;
    }
    i++;
  }
  return parsed;
}

async function handleUpskillList(
  fs: VirtualFS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const skills = await import('../../skills/index.js');
  const discovered = await skills.discoverSkills(fs);
  if (discovered.length === 0) {
    return {
      stdout: `No discoverable local skills found.\n\n${formatDiscoveryScope()}`,
      stderr: '',
      exitCode: 0,
    };
  }
  return {
    stdout: formatDiscoveredSkills(discovered, 'Discoverable local skills'),
    stderr: '',
    exitCode: 0,
  };
}

async function handleUpskillInfoRead(
  arg: string,
  skillName: string | undefined,
  fs: VirtualFS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!skillName) {
    return { stdout: '', stderr: `upskill: ${arg} requires a skill name\n`, exitCode: 1 };
  }
  const skills = await import('../../skills/index.js');
  if (arg === 'info') {
    const skill = await skills.getSkillInfo(fs, skillName);
    if (!skill) {
      return { stdout: '', stderr: `upskill: skill "${skillName}" not found\n`, exitCode: 1 };
    }
    return { stdout: formatSkillInfo(skill), stderr: '', exitCode: 0 };
  }
  const instructions = await skills.readSkillInstructions(fs, skillName);
  if (instructions === null) {
    return { stdout: '', stderr: `upskill: no SKILL.md found for "${skillName}"\n`, exitCode: 1 };
  }
  return { stdout: instructions + '\n', stderr: '', exitCode: 0 };
}

async function installGitHubBatchViaZip(
  skillsToInstall: Array<{ name: string; path: string }>,
  owner: string,
  repo: string,
  files: Record<string, Uint8Array>,
  fs: VirtualFS,
  force: boolean,
  startTime: number
): Promise<{ output: string; errors: string; successCount: number }> {
  let output = '';
  let errors = '';
  let successCount = 0;
  const totalSkills = skillsToInstall.length;
  for (let si = 0; si < skillsToInstall.length; si++) {
    const skill = skillsToInstall[si];
    const result = await installSkillFromZip(skill.path, skill.name, files, fs, force);
    const idx = si + 1;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgTime = (Date.now() - startTime) / idx;
    const eta =
      idx < totalSkills
        ? ` (~${Math.round(((totalSkills - idx) * avgTime) / 1000)}s remaining)`
        : '';
    if (result.ok) {
      output += `[${idx}/${totalSkills}] Installed "${skill.name}" from ${owner}/${repo} (${elapsed}s)${eta}\n`;
      successCount++;
    } else {
      output += `[${idx}/${totalSkills}] Failed "${skill.name}": ${result.error}${eta}\n`;
      errors += `upskill: ${result.error}\n`;
    }
  }
  return { output, errors, successCount };
}

async function installGitHubBatchViaApi(
  skillsToInstall: Array<{ name: string; path: string }>,
  owner: string,
  repo: string,
  github: GitHubRequestContext,
  fs: VirtualFS,
  force: boolean,
  effectiveBranch: string | undefined,
  startTime: number
): Promise<{ output: string; errors: string; successCount: number }> {
  let output = '';
  let errors = '';
  let successCount = 0;
  const totalSkills = skillsToInstall.length;
  // ZIP unavailable — fall back to Contents API per skill
  for (let si = 0; si < skillsToInstall.length; si++) {
    const skill = skillsToInstall[si];
    const installResult = await installFromGitHub(
      owner,
      repo,
      skill.path,
      skill.name,
      fs,
      github,
      force,
      undefined,
      effectiveBranch
    );
    const idx = si + 1;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgTime = (Date.now() - startTime) / idx;
    const eta =
      idx < totalSkills
        ? ` (~${Math.round(((totalSkills - idx) * avgTime) / 1000)}s remaining)`
        : '';
    if (installResult.exitCode === 0) {
      output += `[${idx}/${totalSkills}] Installed "${skill.name}" from ${owner}/${repo} (${elapsed}s)${eta}\n`;
      successCount++;
    } else {
      output += `[${idx}/${totalSkills}] Failed "${skill.name}": ${installResult.stderr.trim()}${eta}\n`;
      errors += installResult.stderr;
    }
  }
  return { output, errors, successCount };
}

async function installGitHubSingle(
  skillsToInstall: Array<{ name: string; path: string }>,
  owner: string,
  repo: string,
  github: GitHubRequestContext,
  fs: VirtualFS,
  force: boolean,
  fetchFn: SecureFetch,
  effectiveBranch: string | undefined
): Promise<{ output: string; errors: string; successCount: number }> {
  let output = '';
  let errors = '';
  let successCount = 0;
  for (const skill of skillsToInstall) {
    const r = await installFromGitHub(
      owner,
      repo,
      skill.path,
      skill.name,
      fs,
      github,
      force,
      fetchFn,
      effectiveBranch
    );
    if (r.exitCode === 0) {
      output += r.stdout;
      successCount++;
    } else {
      errors += r.stderr;
    }
  }
  return { output, errors, successCount };
}

function listAvailableSkills(
  skills: Array<{ name: string; path: string }>,
  owner: string,
  repo: string
): string {
  let out = `Available skills in ${owner}/${repo}:\n\n`;
  for (const skill of skills) out += `  ${skill.name.padEnd(30)} ${skill.path}\n`;
  out += `\nFound ${skills.length} skill(s)\n`;
  return out;
}

async function handleGitHubInstall(
  githubRef: NonNullable<ReturnType<typeof parseGitHubRef>>,
  parsed: ParsedUpskillFlags,
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { owner, repo } = githubRef;
  // --branch flag takes precedence over @branch / URL /tree/<branch>
  const effectiveBranch = parsed.branch ?? githubRef.branch;
  // --path/-p takes precedence over implicit subpath from URL /tree/<branch>/<path>
  const effectiveSubPath = parsed.subPath ?? githubRef.path;
  const github = await createGitHubRequestContext(fetchFn);

  const result = await listGitHubSkills(
    owner,
    repo,
    github,
    effectiveSubPath,
    fetchFn,
    effectiveBranch
  );
  if (result.error) {
    return { stdout: '', stderr: `upskill: failed to list skills: ${result.error}\n`, exitCode: 1 };
  }
  if (result.skills.length === 0) {
    return {
      stdout: `No skills found in ${owner}/${repo}${effectiveSubPath ? '/' + effectiveSubPath : ''}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  // Just list if --list flag
  if (parsed.listOnly) {
    const out =
      listAvailableSkills(result.skills, owner, repo) +
      `\nTo install: upskill ${parsed.sourceRef} --skill <name>\n` +
      `To install all: upskill ${parsed.sourceRef} --all\n`;
    return { stdout: out, stderr: '', exitCode: 0 };
  }

  // Determine which skills to install
  let skillsToInstall = result.skills;
  if (parsed.selectedSkills.length > 0) {
    skillsToInstall = result.skills.filter((s) => parsed.selectedSkills.includes(s.name));
    for (const name of parsed.selectedSkills) {
      if (!result.skills.find((s) => s.name === name)) {
        return {
          stdout: '',
          stderr: `upskill: skill "${name}" not found in ${owner}/${repo}\n`,
          exitCode: 1,
        };
      }
    }
  } else if (!parsed.installAll) {
    // No selection made — show list and prompt
    const out =
      listAvailableSkills(result.skills, owner, repo) +
      `\nTo install specific skills: upskill ${parsed.sourceRef} --skill <name>\n` +
      `To install all: upskill ${parsed.sourceRef} --all\n`;
    return { stdout: out, stderr: '', exitCode: 0 };
  }

  // Install selected skills — download ZIP once, extract all skills from it
  const totalSkills = skillsToInstall.length;
  const startTime = Date.now();
  let output = '';
  let errors = '';
  let successCount = 0;

  // For batch installs (--all or multiple --skill), use ZIP and skip per-skill hooks
  if (totalSkills > 1) {
    const zip = await fetchRepoZip(owner, repo, fetchFn, effectiveBranch);
    if (zip.status === 'ok') {
      const batch = await installGitHubBatchViaZip(
        skillsToInstall,
        owner,
        repo,
        stripZipPrefix(zip.files),
        fs,
        parsed.force,
        startTime
      );
      ({ output, errors, successCount } = batch);
    } else {
      const batch = await installGitHubBatchViaApi(
        skillsToInstall,
        owner,
        repo,
        github,
        fs,
        parsed.force,
        effectiveBranch,
        startTime
      );
      ({ output, errors, successCount } = batch);
    }
  } else {
    // Single skill — use the existing installFromGitHub path
    ({ output, errors, successCount } = await installGitHubSingle(
      skillsToInstall,
      owner,
      repo,
      github,
      fs,
      parsed.force,
      fetchFn,
      effectiveBranch
    ));
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (successCount > 0) {
    output += `\nInstalled ${successCount} skill(s)${totalSkills > 1 ? ` in ${totalElapsed}s` : ''}\n`;
    await runPostInstallHooks();
  }

  return { stdout: output, stderr: errors, exitCode: errors ? 1 : 0 };
}

/**
 * Create the upskill command with access to the virtual filesystem.
 *
 * @param browser Optional BrowserAPI used by the `tabs` subcommand. When
 *   omitted (e.g. headless tests or pre-CDP boot), `upskill tabs` exits
 *   non-zero with a clear "browser APIs unavailable" message.
 */
export function createUpskillCommand(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  browser?: BrowserAPI
): Command {
  return defineCommand('upskill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return upskillHelp();
    }

    // `upskill tabs [--json]` — surface skill suggestions for open browser
    // tabs. Handled up-front so the rest of the arg parser doesn't try to
    // interpret `tabs` as a GitHub `owner/repo` ref.
    if (args[0] === 'tabs') {
      return handleTabs(fs, fetchFn, browser, args.includes('--json'));
    }
    if (args[0] === 'recommendations') {
      return handleRecommendations(fs, fetchFn, args.includes('--install'));
    }
    if (args[0] === 'list') return handleUpskillList(fs);
    if (args[0] === 'info' || args[0] === 'read') {
      return handleUpskillInfoRead(args[0], args[1], fs);
    }

    if (args[0] === 'search') return handleUpskillSearch(args, fetchFn);

    const parsed = parseUpskillFlags(args);
    if (parsed.earlyReturn) return parsed.earlyReturn;
    if (!parsed.sourceRef) return upskillHelp();

    // Check if it's a Tessl reference (tessl:name)
    if (parsed.sourceRef.startsWith('tessl:')) {
      return handleTesslInstall(parsed.sourceRef, parsed.force, fs, fetchFn);
    }

    // Check if it's a browse.sh reference (browse:<hostname>/<task> or URL form)
    const browseShRef = parseBrowseShRef(parsed.sourceRef);
    if (browseShRef) {
      return installFromBrowseSh(browseShRef.hostname, browseShRef.task, fs, fetchFn, parsed.force);
    }

    // Check if it's a GitHub reference
    const githubRef = parseGitHubRef(parsed.sourceRef);
    if (githubRef) return handleGitHubInstall(githubRef, parsed, fs, fetchFn);

    // Unknown source format
    return {
      stdout: '',
      stderr: `upskill: unrecognized source "${parsed.sourceRef}"\n\nExpected: owner/repo, tessl:<name>, or browse:<hostname>/<task>\n`,
      exitCode: 1,
    };
  });
}

async function handleUpskillSearch(
  args: string[],
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Collect the search query (excluding --page flag)
  const rest = [...args.slice(1)];
  const pageIdx = rest.indexOf('--page');
  let page = 1;
  if (pageIdx >= 0) {
    page = parseInt(rest[pageIdx + 1], 10) || 1;
    rest.splice(pageIdx, 2);
  }
  const searchQuery = rest.join(' ');
  if (searchQuery) return searchRegistries(searchQuery, fetchFn, page);
  return upskillHelp();
}

async function handleTesslInstall(
  sourceRef: string,
  force: boolean,
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const tesslName = sourceRef.slice(6);
  if (!tesslName) {
    return { stdout: '', stderr: 'upskill: tessl: requires a skill name\n', exitCode: 1 };
  }
  const resolved = await resolveTesslRef(tesslName, fetchFn);
  if ('error' in resolved) {
    return { stdout: '', stderr: `upskill: ${resolved.error}\n`, exitCode: 1 };
  }
  const github = await createGitHubRequestContext(fetchFn);
  return installFromGitHub(
    resolved.owner,
    resolved.repo,
    resolved.skillPath,
    resolved.skillName,
    fs,
    github,
    force,
    fetchFn
  );
}

/**
 * Create skill command as an alias for upskill with local operations only.
 */
export function createSkillCommand(fs: VirtualFS): Command {
  return defineCommand('skill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `usage: skill <command> [options]

Commands:
  list                   List discoverable skills
  info <name>            Show details about a skill
  read <name>            Read the SKILL.md instructions

${formatDiscoveryScope()}
For installing skills from registries or GitHub, use 'upskill':
  upskill search "query"           Search registries (Tessl + browse.sh)
  upskill owner/repo --list        List skills in GitHub repo
  upskill owner/repo --all         Install from GitHub
  upskill tessl:<name>             Install from Tessl registry
  upskill browse:<host>/<task>     Install from browse.sh catalog

Examples:
  skill list
  skill info bluebubbles
  skill read bluebubbles
`,
        stderr: '',
        exitCode: 0,
      };
    }

    const subcommand = args[0];
    const skills = await import('../../skills/index.js');

    try {
      switch (subcommand) {
        case 'list': {
          const discovered = await skills.discoverSkills(fs);

          if (discovered.length === 0) {
            return {
              stdout: `No discoverable skills found.\n\n${formatDiscoveryScope()}Install skills with: upskill owner/repo --all\n`,
              stderr: '',
              exitCode: 0,
            };
          }

          return {
            stdout: formatDiscoveredSkills(discovered, 'Discoverable skills'),
            stderr: '',
            exitCode: 0,
          };
        }

        case 'info': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: info requires a skill name\n', exitCode: 1 };
          }

          const skill = await skills.getSkillInfo(fs, name);
          if (!skill) {
            return { stdout: '', stderr: `skill: "${name}" not found\n`, exitCode: 1 };
          }

          return { stdout: formatSkillInfo(skill), stderr: '', exitCode: 0 };
        }

        case 'read': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: read requires a skill name\n', exitCode: 1 };
          }

          const instructions = await skills.readSkillInstructions(fs, name);
          if (instructions === null) {
            return { stdout: '', stderr: `skill: no SKILL.md found for "${name}"\n`, exitCode: 1 };
          }

          return { stdout: instructions + '\n', stderr: '', exitCode: 0 };
        }

        default:
          return { stdout: '', stderr: `skill: unknown command "${subcommand}"\n`, exitCode: 1 };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `skill: ${msg}\n`, exitCode: 1 };
    }
  });
}
