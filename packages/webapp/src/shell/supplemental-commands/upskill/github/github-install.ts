import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../../fs/index.js';
import { parseFetchJson } from '../../../fetch-body.js';
import { clearSkillDirPreservingDotfiles } from '../dotfiles.js';
import {
  discardFailedInstall,
  managedFiles,
  refreshSprinklesAfterInstall,
  reloadSkillsAfterInstall,
  runPostInstallHooks,
} from '../install-pipeline.js';
import { resolveCommitSha, writeProvenance } from '../provenance.js';
import type { GitHubContent, GitHubRequestContext } from '../types.js';
import { SKILLS_DIR } from '../types.js';
import { formatGitHubFailure } from './github-errors.js';
import {
  downloadGitHubDir,
  fetchRepoZip,
  stripZipPrefix,
  writeZipFilesToDir,
} from './github-zip.js';

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

export async function listGitHubSkills(
  owner: string,
  repo: string,
  github: GitHubRequestContext,
  subPath?: string,
  fetch?: SecureFetch,
  branch?: string
): Promise<{ skills: Array<{ name: string; path: string }>; error?: string }> {
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
  }

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

async function recordGitHubProvenance(
  fs: VirtualFS,
  owner: string,
  repo: string,
  skillPath: string,
  skillName: string,
  branch: string | undefined,
  github: GitHubRequestContext,
  files: string[]
): Promise<void> {
  const sha = await resolveCommitSha(owner, repo, branch, github);
  await writeProvenance(fs, skillName, {
    kind: 'github',
    source: `${owner}/${repo}`,
    skill: skillName,
    ref: branch,
    path: skillPath.replace(/^\/|\/$/g, ''),
    sha,
    files,
  });
}

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
  let existed = false;
  try {
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
      existed = true;

      await clearSkillDirPreservingDotfiles(fs, destDir, await managedFiles(fs, skillName));
    } catch {}

    if (fetch) {
      const zip = await fetchRepoZip(owner, repo, fetch, branch);
      if (zip.status === 'ok') {
        const files = stripZipPrefix(zip.files);
        const prefix = skillPath.replace(/^\/|\/$/g, '') + '/';

        await fs.mkdir(destDir, { recursive: true });
        const written = await writeZipFilesToDir(files, prefix, destDir, fs);

        if (written.length > 0) {
          await recordGitHubProvenance(
            fs,
            owner,
            repo,
            skillPath,
            skillName,
            branch,
            github,
            written
          );
          await refreshSprinklesAfterInstall();
          await reloadSkillsAfterInstall();
          return {
            stdout: `Installed skill "${skillName}" from ${owner}/${repo}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
      }
    }

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

    let written: string[];
    try {
      written = await downloadGitHubDir(contents, destDir, owner, repo, branch, fs, github);
    } catch (downloadErr) {
      await discardFailedInstall(fs, destDir, existed);
      throw downloadErr;
    }

    await recordGitHubProvenance(fs, owner, repo, skillPath, skillName, branch, github, written);
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

export function parseGitHubRef(
  ref: string
): { owner: string; repo: string; branch?: string; path?: string } | null {
  const url = ref.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+?)(?:\/(.+?))?)?\/?$/
  );
  if (url) {
    return { owner: url[1], repo: url[2], branch: url[3], path: url[4] };
  }

  const match = ref.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_./-]+))?$/);
  if (match) {
    return { owner: match[1], repo: match[2], branch: match[3] };
  }
  return null;
}
