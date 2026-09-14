import type { LocalVfsClient } from '../kernel/local-vfs-client.js';

export interface ResolvedMention {
  query: string;

  matches: string[];
}

export interface FileMentionResolverOptions {
  roots?: string[];

  ignoredDirs?: Set<string>;

  maxEntries?: number;

  maxDepth?: number;

  ttlMs?: number;
}

const DEFAULT_ROOTS = ['/workspace', '/shared', '/memory', '/scoops', '/mnt'];

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.next',
  '.turbo',
  'python_wheels',
]);

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_DEPTH = 12;

const DEFAULT_TTL_MS = 30_000;

function normalizeQuery(query: string): string {
  let path = query.trim();

  while (path.startsWith('./') || path.startsWith('../')) {
    path = path.slice(path.startsWith('./') ? 2 : 3);
  }
  if (path.startsWith('~/')) path = path.slice(2);
  return path.replace(/\/{2,}/g, '/');
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function matchesSuffix(candidate: string, query: string): boolean {
  if (candidate === query) return true;
  if (!candidate.endsWith(query)) return false;
  const boundary = candidate[candidate.length - query.length - 1];
  return boundary === '/';
}

function sameFile(hint: string, query: string): boolean {
  const path = normalizeQuery(hint);
  if (query.includes('/')) return matchesSuffix(path, query);
  return basenameOf(path) === query;
}

function relevantHints(query: string, hints: readonly string[]): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (let i = hints.length - 1; i >= 0; i -= 1) {
    const hint = hints[i];
    if (hint === undefined || seen.has(hint)) continue;
    if (!sameFile(hint, query)) continue;
    seen.add(hint);
    picked.push(normalizeQuery(hint));
    if (picked.length >= MAX_HINTS_PER_QUERY) break;
  }
  return picked;
}

const MAX_HINTS_PER_QUERY = 4;

export class FileMentionResolver {
  readonly #fs: LocalVfsClient;
  readonly #roots: string[];
  readonly #ignoredDirs: Set<string>;
  readonly #maxEntries: number;
  readonly #maxDepth: number;
  readonly #ttlMs: number;

  #builtAt = 0;

  #index: Map<string, string[]> | null = null;
  #indexBuild: Promise<Map<string, string[]>> | null = null;

  readonly #answers = new Map<string, Promise<ResolvedMention>>();

  readonly #hintChecks = new Map<string, Promise<boolean>>();

  constructor(fs: LocalVfsClient, options: FileMentionResolverOptions = {}) {
    this.#fs = fs;
    this.#roots = options.roots ?? DEFAULT_ROOTS;
    this.#ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  resolve(query: string, hints: readonly string[] = []): Promise<ResolvedMention> {
    this.#expireStaleIndex();
    const normalized = normalizeQuery(query);
    const base = this.#baseAnswer(normalized);
    const relevant = relevantHints(normalized, hints);
    if (relevant.length === 0) return base;
    return this.#withHints(normalized, base, relevant);
  }

  resolveAll(queries: string[], hints: readonly string[] = []): Promise<ResolvedMention[]> {
    return Promise.all(queries.map((query) => this.resolve(query, hints)));
  }

  invalidate(): void {
    this.#index = null;
    this.#indexBuild = null;
    this.#answers.clear();
    this.#hintChecks.clear();
  }

  #baseAnswer(normalized: string): Promise<ResolvedMention> {
    const cached = this.#answers.get(normalized);
    if (cached) return cached;

    const pending = this.#resolveUncached(normalized).catch(
      (): ResolvedMention => ({ query: normalized, matches: [] })
    );
    this.#answers.set(normalized, pending);
    return pending;
  }

  async #withHints(
    query: string,
    base: Promise<ResolvedMention>,
    hints: string[]
  ): Promise<ResolvedMention> {
    const { matches } = await base;
    const known = new Set(matches);

    const verified: string[] = [];
    for (const hint of hints) {
      if (!hint.startsWith('/') || known.has(hint)) continue;
      if (await this.#hintIsFile(hint)) verified.push(hint);
    }

    const rank = (path: string): number => hints.findIndex((hint) => matchesSuffix(path, hint));
    const corroborated = matches
      .filter((path) => rank(path) >= 0)
      .sort((a, b) => rank(a) - rank(b));
    const promoted = new Set(corroborated);
    const rest = matches.filter((path) => !promoted.has(path));

    return { query, matches: [...verified, ...corroborated, ...rest] };
  }

  #hintIsFile(path: string): Promise<boolean> {
    const cached = this.#hintChecks.get(path);
    if (cached) return cached;
    const pending = this.#isFile(path);
    this.#hintChecks.set(path, pending);
    return pending;
  }

  async #resolveUncached(query: string): Promise<ResolvedMention> {
    if (query.startsWith('/')) {
      return { query, matches: (await this.#isFile(query)) ? [query] : [] };
    }

    const index = await this.#ensureIndex();
    const candidates = index.get(basenameOf(query)) ?? [];

    if (!query.includes('/')) {
      return { query, matches: [...candidates].sort(byPathPreference) };
    }

    const matches = candidates.filter((path) => matchesSuffix(path, query));
    return { query, matches: matches.sort(byPathPreference) };
  }

  async #isFile(path: string): Promise<boolean> {
    try {
      return (await this.#fs.stat(path)).type === 'file';
    } catch {
      return false;
    }
  }

  #expireStaleIndex(): void {
    if (!this.#index || this.#ttlMs === Number.POSITIVE_INFINITY) return;
    if (Date.now() - this.#builtAt < this.#ttlMs) return;
    this.invalidate();
  }

  #ensureIndex(): Promise<Map<string, string[]>> {
    if (this.#index) return Promise.resolve(this.#index);
    this.#indexBuild ??= this.#buildIndex().then((index) => {
      this.#index = index;
      this.#builtAt = Date.now();
      return index;
    });
    return this.#indexBuild;
  }

  async #buildIndex(): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>();
    const budget = { left: this.#maxEntries };

    for (const root of this.#roots) {
      if (budget.left <= 0) break;
      await this.#walk(root, 0, index, budget);
    }

    return index;
  }

  async #walk(
    dir: string,
    depth: number,
    index: Map<string, string[]>,
    budget: { left: number }
  ): Promise<void> {
    if (budget.left <= 0 || depth > this.#maxDepth) return;

    let entries: Awaited<ReturnType<LocalVfsClient['readDir']>>;
    try {
      entries = await this.#fs.readDir(dir);
    } catch {
      return;
    }

    const subdirs = this.#indexEntries(dir, entries, index, budget);

    for (const sub of subdirs) {
      if (budget.left <= 0) break;
      await this.#walk(sub, depth + 1, index, budget);
    }
  }

  #indexEntries(
    dir: string,
    entries: Awaited<ReturnType<LocalVfsClient['readDir']>>,
    index: Map<string, string[]>,
    budget: { left: number }
  ): string[] {
    const subdirs: string[] = [];

    for (const entry of entries) {
      if (budget.left <= 0) break;
      const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;

      if (entry.type === 'directory') {
        if (!this.#ignoredDirs.has(entry.name)) subdirs.push(full);
        continue;
      }

      const bucket = index.get(entry.name);
      if (bucket) bucket.push(full);
      else index.set(entry.name, [full]);
      budget.left -= 1;
    }

    return subdirs;
  }
}

function byPathPreference(a: string, b: string): number {
  const depthA = a.split('/').length;
  const depthB = b.split('/').length;
  if (depthA !== depthB) return depthA - depthB;
  return a.localeCompare(b);
}
