/**
 * Turning a file MENTION into a file PATH.
 *
 * `findFileMentions` is a guess made from prose. This is the half that checks
 * the guess against the VFS, because the two are asymmetric: the heuristic can
 * afford to be wrong, but the link the user clicks cannot be.
 *
 * ## Why a basename index and not a walk per mention
 *
 * Agents name files without paths — "I rewrote check.js" — so most lookups start
 * from a basename with nowhere to `stat()`. Answering those one at a time would
 * mean re-walking the tree for every mention in every message. Instead the first
 * unqualified lookup builds one bounded index of basename → paths, and every
 * later lookup is a map hit. A full path, by contrast, skips the index entirely
 * and goes straight to `stat()`, which is both cheaper and exact.
 *
 * ## Why the index is bounded and lazily built
 *
 * A VFS containing `node_modules` is effectively unbounded, and a transcript
 * scroll must not touch every inode to render. The walk therefore skips the
 * directories that hold orders of magnitude more files than a human ever names,
 * and stops outright at a hard entry ceiling. A mention that would only have
 * resolved past the ceiling stays plain text — the correct failure, since the
 * alternative is a stalled UI.
 *
 * ## Ambiguity
 *
 * `main.ts` may exist in ten packages. Rather than guess, the resolver reports
 * every match and lets the caller decide (the linker shows a disambiguation
 * affordance). A mention that names enough of its path to be unique — the common
 * `packages/webapp/src/main.ts` — resolves cleanly on the suffix rule below.
 */

import type { LocalVfsClient } from '../kernel/local-vfs-client.js';

/** The outcome of checking one mention against the VFS. */
export interface ResolvedMention {
  /** The candidate text that was looked up. */
  query: string;
  /** Every real VFS path the candidate could mean, best match first. */
  matches: string[];
}

export interface FileMentionResolverOptions {
  /** Where to start walking when building the basename index. */
  roots?: string[];
  /**
   * Directory names skipped during the walk. These hold far more files than a
   * transcript ever names, and walking them is most of the cost.
   */
  ignoredDirs?: Set<string>;
  /** Hard ceiling on indexed files, so a pathological VFS can't stall the UI. */
  maxEntries?: number;
  /** Deepest directory level the walk descends to. */
  maxDepth?: number;
  /**
   * How long an index stays fresh, in milliseconds.
   *
   * Agents create files mid-conversation and then name them, so an index cached
   * for the life of the view would leave exactly those mentions unlinkable.
   * Pass `Infinity` to cache forever (tests do, to assert the walk happens once).
   */
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

/**
 * Long enough that scrolling a transcript never re-walks, short enough that a
 * file the agent just wrote becomes clickable while the user is still reading
 * the message that named it.
 */
const DEFAULT_TTL_MS = 30_000;

/**
 * Normalize a mention into something comparable with a VFS path.
 *
 * The detector emits the prefixes people actually type — `./`, `../`, `~/` —
 * and none of them survive a suffix match: no absolute VFS path ends with a
 * literal `~/` or `../` segment, so a mention like `~/.config/app.toml` could
 * never resolve. Each is stripped to the meaningful tail (`.config/app.toml`),
 * which the suffix rule then matches at a segment boundary wherever it really
 * lives. That is deliberately looser than expanding `~` to a specific home
 * directory: the VFS has several plausible roots, and a suffix match is both
 * simpler and more forgiving of a mention written relative to a cwd we cannot
 * know.
 */
function normalizeQuery(query: string): string {
  let path = query.trim();
  // Repeated `../` from a deeply relative mention all collapse the same way.
  while (path.startsWith('./') || path.startsWith('../')) {
    path = path.slice(path.startsWith('./') ? 2 : 3);
  }
  if (path.startsWith('~/')) path = path.slice(2);
  return path.replace(/\/{2,}/g, '/');
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether `candidate` (a full VFS path) satisfies the partial path `query`.
 *
 * Matching on a path SUFFIX at a segment boundary is what makes
 * `webapp/src/main.ts` resolve to `/packages/webapp/src/main.ts` while refusing
 * to match `/other/xwebapp/src/main.ts`. Basename-only queries are handled by
 * the index and never reach here with more than one segment.
 */
function matchesSuffix(candidate: string, query: string): boolean {
  if (candidate === query) return true;
  if (!candidate.endsWith(query)) return false;
  const boundary = candidate[candidate.length - query.length - 1];
  return boundary === '/';
}

/**
 * Whether a hinted path could be what `query` names.
 *
 * A query with segments must match the hint's tail at a boundary — the same
 * rule the index uses. A bare basename matches on basename alone, which is the
 * whole point: prose says `foo.md` and the hint supplies the directory.
 */
function sameFile(hint: string, query: string): boolean {
  const path = normalizeQuery(hint);
  if (query.includes('/')) return matchesSuffix(path, query);
  return basenameOf(path) === query;
}

/**
 * The hints worth checking for one query, most recent first, deduped.
 *
 * Later tool calls win ties because a turn that touches the same basename twice
 * almost always means the file it touched LAST. The cap bounds the `stat()`
 * calls one mention can trigger, however long the transcript grows.
 */
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

/** How many hinted paths a single mention may `stat()`. */
const MAX_HINTS_PER_QUERY = 4;

/**
 * Resolves file mentions against a VFS, caching both the index and individual
 * answers for the lifetime of the instance.
 *
 * One instance is meant to live as long as the transcript view that uses it —
 * long enough for the index to pay for itself, short enough that a rebuilt UI
 * picks up files created since.
 */
export class FileMentionResolver {
  readonly #fs: LocalVfsClient;
  readonly #roots: string[];
  readonly #ignoredDirs: Set<string>;
  readonly #maxEntries: number;
  readonly #maxDepth: number;
  readonly #ttlMs: number;
  /** When the current index was built, for the TTL check. */
  #builtAt = 0;

  /** basename → every path with that basename. Built once, on first need. */
  #index: Map<string, string[]> | null = null;
  #indexBuild: Promise<Map<string, string[]>> | null = null;
  /** Memoized answers, keyed by normalized query. */
  readonly #answers = new Map<string, Promise<ResolvedMention>>();
  /** Memoized `stat()` verdicts for hinted paths, keyed by absolute path. */
  readonly #hintChecks = new Map<string, Promise<boolean>>();

  constructor(fs: LocalVfsClient, options: FileMentionResolverOptions = {}) {
    this.#fs = fs;
    this.#roots = options.roots ?? DEFAULT_ROOTS;
    this.#ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Resolve one mention. Repeated calls for the same query share a single
   * in-flight promise, so a message mentioning `main.ts` six times costs one
   * lookup.
   *
   * `hints` are paths the turn already named in a tool call (see
   * `core/tool-call-paths.ts`). They do two things no index lookup can: they
   * rank an ambiguous basename toward the file this turn actually touched, and
   * they resolve a file that lives OUTSIDE the indexed roots — `/home/lars/foo.md`
   * from `echo test > /home/lars/foo.md` is never in the index, but it is still
   * a real file the user can preview. A hint is only ever believed after a
   * `stat()` confirms it, so a stale or wrong one costs nothing but the check.
   */
  resolve(query: string, hints: readonly string[] = []): Promise<ResolvedMention> {
    this.#expireStaleIndex();
    const normalized = normalizeQuery(query);
    const base = this.#baseAnswer(normalized);
    const relevant = relevantHints(normalized, hints);
    if (relevant.length === 0) return base;
    return this.#withHints(normalized, base, relevant);
  }

  /** Resolve many mentions concurrently, preserving input order. */
  resolveAll(queries: string[], hints: readonly string[] = []): Promise<ResolvedMention[]> {
    return Promise.all(queries.map((query) => this.resolve(query, hints)));
  }

  /** Drop the index and every memoized answer, so the next lookup re-reads. */
  invalidate(): void {
    this.#index = null;
    this.#indexBuild = null;
    this.#answers.clear();
    this.#hintChecks.clear();
  }

  /** The hint-free answer, memoized. Hinted answers are layered on top of it. */
  #baseAnswer(normalized: string): Promise<ResolvedMention> {
    const cached = this.#answers.get(normalized);
    if (cached) return cached;

    const pending = this.#resolveUncached(normalized).catch(
      (): ResolvedMention => ({ query: normalized, matches: [] })
    );
    this.#answers.set(normalized, pending);
    return pending;
  }

  /**
   * Fold the turn's own paths into an answer.
   *
   * Two distinct effects, in this order:
   *
   *  1. An ABSOLUTE hint the index never saw is `stat()`ed and, if it is a real
   *     file, becomes the preferred match. This is the `/home/lars/foo.md` case.
   *  2. Index matches that a hint corroborates float to the front, so an
   *     ambiguous `main.ts` opens the one this turn was working on.
   *
   * Hint verification is memoized separately from the answer cache: the same
   * path is typically named by several mentions in the same message.
   */
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

    // Stable partition: corroborated index matches keep their relative order,
    // as do the rest. Nothing is dropped — an ambiguous mention still reports
    // every candidate so the caller can show the alternatives.
    // `hints` arrives most-recent-first, so ranking by hint position is what
    // makes the file the turn touched LAST outrank one it touched earlier.
    // Ties keep index order (a stable sort), which is the depth preference.
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
    // An absolute path is a claim we can check directly — no index needed.
    if (query.startsWith('/')) {
      return { query, matches: (await this.#isFile(query)) ? [query] : [] };
    }

    const index = await this.#ensureIndex();
    const candidates = index.get(basenameOf(query)) ?? [];

    if (!query.includes('/')) {
      return { query, matches: [...candidates].sort(byPathPreference) };
    }

    // A partial path: keep only the candidates whose tail it matches.
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

  /**
   * Drop an index that has outlived its TTL.
   *
   * Checked on lookup rather than on a timer so an idle transcript costs
   * nothing — the work happens only when someone actually asks a question.
   * Memoized ANSWERS are cleared with it: a negative answer ("no such file") is
   * exactly the one most likely to have gone stale.
   */
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

  /**
   * Index every file under `dir`, then recurse into its subdirectories.
   *
   * `budget` is shared by reference across the whole walk so the entry ceiling
   * is global rather than per-directory.
   */
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
      return; // a missing or unreadable root is not an error worth surfacing
    }

    const subdirs = this.#indexEntries(dir, entries, index, budget);

    for (const sub of subdirs) {
      if (budget.left <= 0) break;
      await this.#walk(sub, depth + 1, index, budget);
    }
  }

  /**
   * Add this directory's files to the index and return the subdirectories worth
   * descending into.
   */
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

/**
 * Rank ambiguous matches so the most likely intent sorts first: shallower paths
 * beat deeply nested ones (a top-level `main.ts` is likelier meant than one
 * buried six directories down), and ties break alphabetically for stability.
 */
function byPathPreference(a: string, b: string): number {
  const depthA = a.split('/').length;
  const depthB = b.split('/').length;
  if (depthA !== depthB) return depthA - depthB;
  return a.localeCompare(b);
}
