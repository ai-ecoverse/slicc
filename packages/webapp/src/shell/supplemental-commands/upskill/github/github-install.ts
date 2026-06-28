/**
 * upskill — GitHub install path: ref/URL parsing, skill discovery, and install.
 *
 * Extracted verbatim from `upskill-command.ts`. Tries ZIP-based install first
 * (not rate-limited) and falls back to the Contents API. All network I/O routes
 * through the injected `fetch: SecureFetch`.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../../fs/index.js';
import { parseFetchJson } from '../../../fetch-body.js';
import {
  refreshSprinklesAfterInstall,
  reloadSkillsAfterInstall,
  runPostInstallHooks,
} from '../install-pipeline.js';
import type { GitHubContent, GitHubRequestContext } from '../types.js';
import { SKILLS_DIR } from '../types.js';
import { formatGitHubFailure } from './github-errors.js';
import {
  downloadGitHubDir,
  fetchRepoZip,
  stripZipPrefix,
  writeZipFilesToDir,
} from './github-zip.js';

/**
 * Extract owner/repo from a GitHub URL.
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/**
 * List skills in a GitHub repository.
 * Tries the codeload ZIP first (not rate-limited), falls back to the Contents API.
 */
export async function listGitHubSkills(
  owner: string,
  repo: string,
  github: GitHubRequestContext,
  subPath?: string,
  fetch?: SecureFetch,
  branch?: string
): Promise<{ skills: Array<{ name: string; path: string }>; error?: string }> {
  // Try ZIP-based discovery first (no rate limit)
  if (fetch) {
    const zip = await fetchRepoZip(owner, repo, fetch, branch);
    if (zip.status === 'ok') {
      const files = stripZipPrefix(zip.files);
      const skills: Array<{ name: string; path: string }> = [];
      const prefix = subPath ? subPath.replace(/^\/|\/$/g, '') + '/' : '';

      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const basename = path.split('/').pop() || '';
        if (basename === 'SKILL.md') {
          const skillPath = path.replace(/\/SKILL\.md$/, '');
          const skillName = skillPath.split('/').pop() || skillPath;
          skills.push({ name: skillName, path: skillPath });
        }
      }
      return { skills };
    }
    // zip.status === 'error' — fall through to API
  }

  // Fallback: Contents API (rate-limited for anonymous users)
  const skills: Array<{ name: string; path: string }> = [];

  async function scanDir(path: string): Promise<void> {
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const url = branch ? `${base}?ref=${encodeURIComponent(branch)}` : base;
    const response = await github.request(url);

    if (response.status !== 200) {
      throw new Error(
        formatGitHubFailure(response, `${owner}/${repo}${path ? `/${path}` : ''}`, github.hasToken)
      );
    }

    const contents = parseFetchJson<GitHubContent[]>(response.body);

    for (const item of contents) {
      if (item.type === 'file' && item.name === 'SKILL.md') {
        const skillPath = item.path.replace('/SKILL.md', '');
        const skillName = skillPath.split('/').pop() || skillPath;
        skills.push({ name: skillName, path: skillPath });
      } else if (item.type === 'dir') {
        await scanDir(item.path);
      }
    }
  }

  try {
    await scanDir(subPath || '');
    return { skills };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { skills: [], error: msg };
  }
}

/**
 * Install a skill from GitHub repository.
 * Tries ZIP-based install first (not rate-limited), falls back to the Contents API.
 */
export async function installFromGitHub(
  owner: string,
  repo: string,
  skillPath: string,
  skillName: string,
  fs: VirtualFS,
  github: GitHubRequestContext,
  force: boolean = false,
  fetch?: SecureFetch,
  branch?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    // Check if skill already exists
    const destDir = `${SKILLS_DIR}/${skillName}`;
    try {
      await fs.stat(destDir);
      if (!force) {
        return {
          stdout: '',
          stderr: `upskill: skill "${skillName}" already exists (use --force to overwrite)\n`,
          exitCode: 1,
        };
      }
      await fs.rm(destDir, { recursive: true });
    } catch {
      // Doesn't exist, continue
    }

    // Try ZIP-based install first (no rate limit)
    if (fetch) {
      const zip = await fetchRepoZip(owner, repo, fetch, branch);
      if (zip.status === 'ok') {
        const files = stripZipPrefix(zip.files);
        const prefix = skillPath.replace(/^\/|\/$/g, '') + '/';

        await fs.mkdir(destDir, { recursive: true });
        const fileCount = await writeZipFilesToDir(files, prefix, destDir, fs);

        if (fileCount > 0) {
          await refreshSprinklesAfterInstall();
          await reloadSkillsAfterInstall();
          return {
            stdout: `Installed skill "${skillName}" from ${owner}/${repo}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        // No files found under path — fall through to API
      }
    }

    // Fallback: Contents API
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/${skillPath}`;
    const url = branch ? `${base}?ref=${encodeURIComponent(branch)}` : base;
    const response = await github.request(url);

    if (response.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: ${formatGitHubFailure(response, `${owner}/${repo}/${skillPath}`, github.hasToken)}\n`,
        exitCode: 1,
      };
    }

    const contents = parseFetchJson<GitHubContent[]>(response.body);

    await fs.mkdir(destDir, { recursive: true });

    try {
      await downloadGitHubDir(contents, destDir, owner, repo, branch, fs, github);
    } catch (downloadErr) {
      try {
        await fs.rm(destDir, { recursive: true });
      } catch {
        /* best-effort */
      }
      throw downloadErr;
    }

    await runPostInstallHooks();
    return {
      stdout: `Installed skill "${skillName}" from ${owner}/${repo}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: failed to install from GitHub: ${msg}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Parse GitHub repo reference.
 *
 * Accepts either:
 * - bare `owner/repo` or `owner/repo@branch`
 * - full URL `https://github.com/owner/repo[.git][/tree/<branch>[/<subpath>]][/]`
 *
 * For URL form, `/tree/<branch>/<path>` decomposes into `branch` plus an
 * implicit `path`. The caller decides precedence with any explicit `--branch`
 * / `--path` flags.
 *
 * URL form is **https-only and host-anchored** — `http://`, hosts that merely
 * contain `github.com` as a path segment (`evil.com/github.com/...`), and
 * suffix typosquats (`github.com.evil.com`, `github.co`) are rejected.
 */
export function parseGitHubRef(
  ref: string
): { owner: string; repo: string; branch?: string; path?: string } | null {
  // URL form: https://github.com/owner/repo[.git][/tree/<branch>[/<subpath>]][/]
  // Anchored: scheme MUST be https; host MUST be exactly `github.com`.
  const url = ref.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+?)(?:\/(.+?))?)?\/?$/
  );
  if (url) {
    return { owner: url[1], repo: url[2], branch: url[3], path: url[4] };
  }
  // Handle owner/repo or owner/repo@branch format
  const match = ref.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_./-]+))?$/);
  if (match) {
    return { owner: match[1], repo: match[2], branch: match[3] };
  }
  return null;
}
