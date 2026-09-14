import { unzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../../fs/index.js';
import { consumeCachedBinaryByUrl } from '../../../binary-cache.js';
import { getFetchBodyBytes, parseFetchJson } from '../../../fetch-body.js';
import { canWriteSkillFile, hasDotSegment } from '../dotfiles.js';
import { describeFetchError } from '../fetch-error.js';
import { isSafeSkillRelativePath } from '../skill-paths.js';
import type { GitHubContent, GitHubRequestContext } from '../types.js';
import { formatGitHubFailure } from './github-errors.js';

type ZipResult =
  | { status: 'ok'; files: Record<string, Uint8Array> }
  | { status: 'error'; message: string };

export async function fetchRepoZip(
  owner: string,
  repo: string,
  fetch: SecureFetch,
  branch: string = 'main'
): Promise<ZipResult> {
  const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'slicc-upskill' },
    });
  } catch (err) {
    return { status: 'error', message: describeFetchError(err, url) };
  }
  if (response.status === 404) {
    if (branch === 'main') {
      return fetchRepoZip(owner, repo, fetch, 'master');
    }
    return { status: 'error', message: 'codeload returned HTTP 404' };
  }
  if (response.status !== 200) {
    return { status: 'error', message: `codeload returned HTTP ${response.status}` };
  }

  let zipBytes = consumeCachedBinaryByUrl(url);
  if (!zipBytes) {
    zipBytes = getFetchBodyBytes(response.body);
  }

  try {
    return { status: 'ok', files: unzipSync(zipBytes) };
  } catch (e) {
    return {
      status: 'error',
      message: `failed to unzip: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function stripZipPrefix(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    const slashIdx = path.indexOf('/');
    if (slashIdx < 0) continue;
    const stripped = path.slice(slashIdx + 1);
    if (stripped) result[stripped] = content;
  }
  return result;
}

export async function writeZipFilesToDir(
  files: Record<string, Uint8Array>,
  prefix: string,
  destDir: string,
  fs: VirtualFS,
  keepExistingDotfiles = true
): Promise<string[]> {
  const written: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const relativePath = path.slice(prefix.length);
    if (path.endsWith('/')) continue;

    if (!isSafeSkillRelativePath(relativePath)) continue;
    if (keepExistingDotfiles && !(await canWriteSkillFile(fs, destDir, relativePath))) continue;
    const filePath = `${destDir}/${relativePath}`;
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (parentDir !== destDir) await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(filePath, content);
    written.push(relativePath);
  }
  return written.sort();
}

export async function fetchGitHubDirFiles(
  owner: string,
  repo: string,
  path: string,
  branch: string | undefined,
  github: GitHubRequestContext,
  into: Map<string, Uint8Array> = new Map(),
  relPrefix = ''
): Promise<Map<string, Uint8Array>> {
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const url = branch ? `${base}?ref=${encodeURIComponent(branch)}` : base;
  const response = await github.request(url);
  if (response.status !== 200) {
    throw new Error(
      formatGitHubFailure(response, `${owner}/${repo}${path ? `/${path}` : ''}`, github.hasToken)
    );
  }
  for (const item of parseFetchJson<GitHubContent[]>(response.body)) {
    const relative = relPrefix ? `${relPrefix}/${item.name}` : item.name;
    if (!isSafeSkillRelativePath(relative)) continue;
    if (item.type === 'file' && item.download_url) {
      const fileResponse = await github.request(item.download_url, '*/*');
      if (fileResponse.status !== 200) {
        throw new Error(
          formatGitHubFailure(fileResponse, `${owner}/${repo}/${item.path}`, github.hasToken)
        );
      }
      const cached = consumeCachedBinaryByUrl(item.download_url);
      into.set(relative, cached ?? getFetchBodyBytes(fileResponse.body));
    } else if (item.type === 'dir') {
      await fetchGitHubDirFiles(owner, repo, item.path, branch, github, into, relative);
    }
  }
  return into;
}

export async function downloadGitHubDir(
  items: GitHubContent[],
  destBase: string,
  owner: string,
  repo: string,
  branch: string | undefined,
  fs: VirtualFS,
  github: GitHubRequestContext,
  written: string[] = [],
  relPrefix = ''
): Promise<string[]> {
  for (const item of items) {
    const relativePath = relPrefix ? `${relPrefix}/${item.name}` : item.name;
    if (!isSafeSkillRelativePath(relativePath)) continue;
    if (item.type === 'file' && item.download_url) {
      if (hasDotSegment(relativePath) && (await fs.exists(`${destBase}/${item.name}`))) continue;
      const fileResponse = await github.request(item.download_url, '*/*');
      if (fileResponse.status !== 200) {
        throw new Error(
          formatGitHubFailure(fileResponse, `${owner}/${repo}/${item.path}`, github.hasToken)
        );
      }
      const cached = consumeCachedBinaryByUrl(item.download_url);
      await fs.writeFile(`${destBase}/${item.name}`, cached ?? fileResponse.body);
      written.push(relativePath);
    } else if (item.type === 'dir') {
      const subBase = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`;
      const subUrl = branch ? `${subBase}?ref=${encodeURIComponent(branch)}` : subBase;
      const subResponse = await github.request(subUrl);
      if (subResponse.status !== 200) {
        throw new Error(
          formatGitHubFailure(subResponse, `${owner}/${repo}/${item.path}`, github.hasToken)
        );
      }
      const subContents = parseFetchJson<GitHubContent[]>(subResponse.body);
      await fs.mkdir(`${destBase}/${item.name}`, { recursive: true });
      await downloadGitHubDir(
        subContents,
        `${destBase}/${item.name}`,
        owner,
        repo,
        branch,
        fs,
        github,
        written,
        relativePath
      );
    }
  }
  return written.sort();
}
