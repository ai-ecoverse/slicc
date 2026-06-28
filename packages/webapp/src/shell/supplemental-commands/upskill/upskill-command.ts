/**
 * upskill — argv parsing + dispatch + `createUpskillCommand`.
 *
 * All direct fetch() calls in this file are intentionally shadowed by the
 * `fetch: SecureFetch` parameter passed from createProxiedFetch() in the
 * outer caller. This ensures network requests route through the fetch proxy
 * in CLI mode (forbidden-header bridging) and direct fetch in extension mode
 * (CORS bypass via host_permissions).
 */

import type { Command, CommandContext, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { BrowserAPI } from '../../../cdp/index.js';
import type { VirtualFS } from '../../../fs/index.js';
import { isSafeUpskillBranch, isSafeUpskillPath } from '../../../net/handoff-link.js';
import { parseFetchJson } from '../../fetch-body.js';
import {
  buildInstallCmd,
  getInstalledSkillNames,
  mergeCatalogs,
  parseRemoteCatalog,
  scoreSkills,
} from './catalog/catalog.js';
import { fetchCompanyCatalog } from './catalog/catalog-fetch.js';
import { createGitHubRequestContext } from './github/github-auth.js';
import { installFromGitHub, listGitHubSkills, parseGitHubRef } from './github/github-install.js';
import { fetchRepoZip, stripZipPrefix } from './github/github-zip.js';
import {
  formatDiscoveredSkills,
  formatDiscoveryScope,
  formatSkillInfo,
  upskillHelp,
} from './help.js';
import { installSkillFromZip, runPostInstallHooks } from './install-pipeline.js';
import { installRecommendedSkills } from './recommendations.js';
import { installFromBrowseSh, parseBrowseShRef } from './registries/browse-sh.js';
import { searchRegistries } from './registries/search.js';
import { resolveTesslRef } from './registries/tessl.js';
import { handleTabs } from './tabs.js';
import type {
  CatalogSkill,
  GitHubRequestContext,
  ParsedUpskillFlags,
  RemoteCatalogRow,
  UserProfile,
} from './types.js';
import { SKILL_CATALOG_URL } from './types.js';

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
  const skills = await import('../../../skills/index.js');
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
  const skills = await import('../../../skills/index.js');
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
