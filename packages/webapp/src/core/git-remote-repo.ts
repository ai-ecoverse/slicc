/**
 * Which GitHub repository a directory belongs to, read from its git remote.
 *
 * The fallback for a bare `#123` when the turn never named a repository
 * outright: the file paths its tool calls touched (`core/tool-call-paths.ts`)
 * sit inside some checkout, and that checkout's `.git/config` says where it
 * came from. Walking up from a touched path to the nearest `.git/config` is
 * the same move a person makes — "this is in the slicc repo, so #123 is a
 * slicc issue".
 */

import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import { githubRepoHints } from './github-mentions.js';

/** How many directories up from a path the walk looks for `.git/config`. */
const MAX_ASCENT = 12;

/** How many distinct paths one lookup considers. */
const MAX_PATHS = 6;

/**
 * The GitHub `owner/repo` of a git config's remotes, preferring `origin`
 * (then `upstream`, then whichever comes first).
 */
export function repoFromGitConfig(config: string): string | null {
  const remotes = new Map<string, string>();
  let current: string | null = null;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (section) {
      current = section[1] ?? null;
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (current && url && !remotes.has(current)) remotes.set(current, (url[1] ?? '').trim());
  }
  const ordered = [remotes.get('origin'), remotes.get('upstream'), ...remotes.values()].filter(
    (url): url is string => Boolean(url)
  );
  for (const url of ordered) {
    const slug = githubRepoHints(url)[0];
    if (slug) return slug;
  }
  return null;
}

/** The directories a path's `.git/config` could live in, nearest first. */
export function candidateGitDirs(path: string): string[] {
  if (!path.startsWith('/')) return [];
  const segments = path.split('/').filter(Boolean);
  // A path names a file; its directory is the first candidate.
  segments.pop();
  const dirs: string[] = [];
  while (segments.length > 0 && dirs.length < MAX_ASCENT) {
    dirs.push(`/${segments.join('/')}`);
    segments.pop();
  }
  return dirs;
}

/**
 * Resolves paths to the GitHub repository of their checkout, memoizing every
 * directory it has looked at so a transcript's worth of lookups costs a
 * handful of reads.
 */
export class GitRemoteRepoResolver {
  readonly #fs: LocalVfsClient;
  readonly #byDir = new Map<string, Promise<string | null>>();

  constructor(fs: LocalVfsClient) {
    this.#fs = fs;
  }

  /**
   * The repository of the MOST RECENT path (last in `paths`) that is inside a
   * GitHub checkout, or `null`.
   */
  async repoFor(paths: readonly string[]): Promise<string | null> {
    const recent = [...new Set(paths.filter((p) => p.startsWith('/')))].slice(-MAX_PATHS).reverse();
    for (const path of recent) {
      for (const dir of candidateGitDirs(path)) {
        const slug = await this.#repoAt(dir);
        if (slug) return slug;
      }
    }
    return null;
  }

  #repoAt(dir: string): Promise<string | null> {
    const cached = this.#byDir.get(dir);
    if (cached) return cached;
    const pending = this.#read(`${dir}/.git/config`);
    this.#byDir.set(dir, pending);
    return pending;
  }

  async #read(configPath: string): Promise<string | null> {
    try {
      const raw = await this.#fs.readFile(configPath, { encoding: 'utf-8' });
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      return repoFromGitConfig(text);
    } catch {
      return null;
    }
  }
}
