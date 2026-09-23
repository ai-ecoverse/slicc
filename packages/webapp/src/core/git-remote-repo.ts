import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import { githubRepoHints } from './github-mentions.js';

const MAX_ASCENT = 12;

const MAX_PATHS = 6;

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

export function candidateGitDirs(path: string): string[] {
  if (!path.startsWith('/')) return [];
  const segments = path.split('/').filter(Boolean);

  segments.pop();
  const dirs: string[] = [];
  while (segments.length > 0 && dirs.length < MAX_ASCENT) {
    dirs.push(`/${segments.join('/')}`);
    segments.pop();
  }
  return dirs;
}

export class GitRemoteRepoResolver {
  readonly #fs: LocalVfsClient;
  readonly #byDir = new Map<string, Promise<string | null>>();

  constructor(fs: LocalVfsClient) {
    this.#fs = fs;
  }

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
