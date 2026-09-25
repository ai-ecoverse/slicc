/**
 * Blind reads — the paths a memory pass probed outside its visible roots
 * (#3459). Pure and dependency-free, so `fs/`, `tools/` and `scoops/` can all
 * share one ledger without a layer back-edge.
 *
 * A memory pass runs in a `RestrictedFS` sandbox whose reads outside
 * `visiblePaths` answer exactly like a missing file: `ENOENT`, `[]`, `false`.
 * That is the right default for a shell — PATH probes must not error — but a
 * pass reading `/etc/llmstxtignore` and getting `No such file or directory`
 * concluded the file was gone and wrote that refutation into durable memory
 * as a resolved contradiction. Two of four nightly dreamers did it on one
 * night, both exiting `ok` with a clean merge.
 *
 * The shell's own commands (`cat`, `ls`, `stat`, `grep`, `test`) swallow every
 * filesystem error and print `No such file or directory` regardless of its
 * code, so a distinct error at the fs boundary never reaches the model on
 * its own. The ledger is what closes the loop: the fs decorator records each
 * blind read, the `bash` tool appends a note naming them to the command's
 * result, and `memory_write` refuses a new line that records one of them as
 * absent or refuted.
 */

/**
 * How a probe fell outside the sandbox: `outside` is a path under no visible
 * root (answered as "not found"); `filtered` is a listing of an ancestor of a
 * visible root (`/`, `/cones`) whose entries outside the roots were dropped —
 * `ls /` showing no `etc` is the same false absence by another route.
 */
export type BlindReadKind = 'outside' | 'filtered';

/** Strip a trailing slash so `/etc/` and `/etc` name the same blind spot. */
function canonical(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Ledger of one unit's blind reads for the life of its context. Records are
 * keyed by canonical path; a path is reported to the model once (the first
 * `takeNote` after it was recorded) but stays in `outsidePaths()` for the
 * whole run, because the claim it could poison may be written much later.
 */
export class BlindReadLog {
  private readonly kinds = new Map<string, BlindReadKind>();
  private readonly unreported = new Set<string>();

  constructor(readonly visiblePaths: readonly string[]) {}

  record(path: string, kind: BlindReadKind): void {
    const key = canonical(path);
    if (this.kinds.has(key)) return;
    this.kinds.set(key, kind);
    this.unreported.add(key);
  }

  /** Every path answered as "not found" because it lay outside the visible roots. */
  outsidePaths(): string[] {
    return [...this.kinds].filter(([, kind]) => kind === 'outside').map(([path]) => path);
  }

  /**
   * The note to append to the next command result, naming the blind reads
   * recorded since the last note — or `undefined` when there were none.
   */
  takeNote(): string | undefined {
    if (this.unreported.size === 0) return undefined;
    const outside: string[] = [];
    const filtered: string[] = [];
    for (const path of this.unreported) {
      (this.kinds.get(path) === 'filtered' ? filtered : outside).push(path);
    }
    this.unreported.clear();
    return formatBlindReadNote(this.visiblePaths, outside, filtered);
  }
}

/** The one-line explanation every surface repeats: a blind miss is unknown, never absent. */
export const BLIND_READ_RULE =
  '"No such file or directory" there means UNKNOWN, not absent: never record such a path as missing, and never refute a stored claim about it.';

/**
 * The note appended to a `bash` result whose command probed outside the
 * visible roots. Written for the model, so it names the paths, the roots, and
 * the rule in one breath.
 */
export function formatBlindReadNote(
  visiblePaths: readonly string[],
  outside: readonly string[],
  filtered: readonly string[]
): string {
  const roots = visiblePaths.length > 0 ? visiblePaths.join(', ') : '(none)';
  const parts: string[] = [];
  if (outside.length > 0) {
    parts.push(
      `[not visible from this pass] ${outside.join(', ')} — outside visiblePaths (${roots}). ${BLIND_READ_RULE}`
    );
  }
  if (filtered.length > 0) {
    parts.push(
      `[filtered listing] ${filtered.join(', ')} lists only entries leading to visiblePaths (${roots}); anything else there is hidden, not absent.`
    );
  }
  return parts.join('\n');
}

/**
 * Phrases that turn a mention of a path into a claim that it is gone. The
 * `not:` form is the contract's own `## Not true` grammar; the rest are how
 * the two poisoned passes phrased it and the obvious variants. A tripwire,
 * not a parser — the fs note above is the primary defence, this is the
 * backstop at the one write path durable memory has.
 */
const ABSENCE_MARKERS =
  /\bnot:|\bENOENT\b|no such file|\bnot found\b|\bdoes(?:n't| not) exist|\bno longer exists?\b|\bnever existed\b|\bnon-?existent\b|\bmissing\b|\babsent\b|\bremoved\b|\bdeleted\b|\bgone\b|\bnot (?:present|there|installed|seeded|shipped|in this copy)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A newly written line that records a blind path as absent or refuted. */
export interface BlindNegativeClaim {
  line: string;
  path: string;
}

/**
 * Find the first line of `next` that is not in `current` and records one of
 * the `blindPaths` as absent — by an absence marker on the line, or by `not`
 * directly before the path (`… live in /shared/, not /etc/MEMORY.md`).
 * Lines carried over unchanged are never flagged: the guard is against a
 * pass writing a refutation, not against the file mentioning the path.
 */
export function findBlindNegativeClaim(
  current: string,
  next: string,
  blindPaths: readonly string[]
): BlindNegativeClaim | null {
  if (blindPaths.length === 0) return null;
  const paths = blindPaths.map(canonical).filter((path) => path.length > 1);
  if (paths.length === 0) return null;
  const existing = new Set(current.split('\n').map((line) => line.trim()));
  for (const raw of next.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || existing.has(line)) continue;
    for (const path of paths) {
      if (!line.includes(path)) continue;
      const notBefore = new RegExp(`\\bnot\\s+[\`"'(]*${escapeRegExp(path)}`, 'i');
      if (ABSENCE_MARKERS.test(line) || notBefore.test(line)) return { line, path };
    }
  }
  return null;
}
