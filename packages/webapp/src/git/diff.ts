/**
 * Minimal unified diff implementation using Myers diff algorithm.
 * Produces standard unified diff output with @@ hunk headers.
 */

export interface Edit {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

/**
 * Decide whether step `d` on diagonal `k` was reached from the insert
 * neighbour (k+1) rather than the delete neighbour (k-1). Shared by the
 * forward pass and the backtrack so both stay in lockstep.
 */
function cameFromInsert(v: number[], k: number, d: number, offset: number): boolean {
  return k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]);
}

/**
 * Forward pass: compute the trace of furthest-reaching points and the number
 * of edits (`finalD`) needed to reach (n, m).
 */
function computeForwardTrace(
  a: string[],
  b: string[],
  n: number,
  m: number,
  max: number,
  offset: number
): { trace: number[][]; finalD: number } {
  const trace: number[][] = [];
  const v = new Array<number>(2 * max + 1).fill(0);

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = cameFromInsert(v, k, d, offset)
        ? v[k + 1 + offset] // insert: come from k+1
        : v[k - 1 + offset] + 1; // delete: come from k-1
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return { trace, finalD: d };
    }
  }

  return { trace, finalD: max };
}

/**
 * Backtrack from (n, m) to (0, 0) using the forward-pass trace, emitting the
 * edit script in forward order.
 */
function backtrackTrace(
  a: string[],
  b: string[],
  n: number,
  m: number,
  offset: number,
  trace: number[][],
  finalD: number
): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = finalD; d > 0; d--) {
    // trace[d] holds v state AFTER d-1 was processed (pushed at start of d loop)
    const prev = trace[d];
    const k = x - y;
    const prevK = cameFromInsert(prev, k, d, offset) ? k + 1 : k - 1;
    const prevX = prev[prevK + offset];
    const prevY = prevX - prevK;

    // Diagonal (equal) moves after the edit at step d
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ type: 'equal', line: a[x] });
    }

    // The actual edit at step d
    if (x === prevX && y > prevY) {
      y--;
      edits.push({ type: 'insert', line: b[y] });
    } else if (y === prevY && x > prevX) {
      x--;
      edits.push({ type: 'delete', line: a[x] });
    }
  }

  // Remaining diagonal at d=0 (matches from the very beginning)
  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.push({ type: 'equal', line: a[x] });
  }

  edits.reverse();
  return edits;
}

/**
 * Myers diff algorithm — computes shortest edit script between two line arrays.
 * Exported as an internal helper for the three-way merge core (`merge-file-core.ts`).
 */
export function myersDiff(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ type: 'insert' as const, line }));
  if (m === 0) return a.map((line) => ({ type: 'delete' as const, line }));

  const max = n + m;
  const offset = max;

  const { trace, finalD } = computeForwardTrace(a, b, n, m, max, offset);
  return backtrackTrace(a, b, n, m, offset, trace, finalD);
}

/**
 * How a line ended, carried as a one-character PREFIX on every line handed to
 * `myersDiff`. It is what makes an incomplete final line compare UNEQUAL to the
 * same text followed by a newline, so `a\nb\n` vs `a\nb` produces a real hunk
 * instead of an empty diff. A prefix is collision-free where a sentinel suffix
 * would not be: exactly one character is added and exactly one is stripped,
 * whatever the line itself contains.
 */
const ENDS_WITH_NEWLINE = '\n';
const ENDS_WITHOUT_NEWLINE = '\0';

/** git's marker for a side whose last line has no terminating newline. */
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/**
 * Split content into terminator-tagged lines. Empty content has no lines at
 * all, and a terminating newline leaves a trailing `''` that is not one.
 */
function taggedLines(content: string): string[] {
  if (content === '') return [];
  const incomplete = !content.endsWith('\n');
  const lines = content.split('\n');
  if (!incomplete) lines.pop();
  const last = lines.length - 1;
  return lines.map(
    (line, i) => `${incomplete && i === last ? ENDS_WITHOUT_NEWLINE : ENDS_WITH_NEWLINE}${line}`
  );
}

/** One rendered diff line: its marker, its text, and git's no-newline flag. */
interface DiffLine {
  sign: ' ' | '-' | '+';
  text: string;
  /** This line is its side's last and had no terminating newline. */
  incomplete: boolean;
}

function diffLine(sign: DiffLine['sign'], tagged: string): DiffLine {
  return { sign, text: tagged.slice(1), incomplete: tagged[0] === ENDS_WITHOUT_NEWLINE };
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

/**
 * Index ranges of `edits` that become one hunk each: every run of changes,
 * padded by `contextLines` on both sides, with runs closer together than twice
 * the context merged into a single range.
 */
function hunkRanges(edits: Edit[], contextLines: number): [number, number][] {
  const changes: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'equal') changes.push(i);
  }
  if (changes.length === 0) return [];

  const runs: [number, number][] = [];
  let first = changes[0];
  let last = changes[0];
  for (const index of changes.slice(1)) {
    if (index - last > 2 * contextLines) {
      runs.push([first, last]);
      first = index;
    }
    last = index;
  }
  runs.push([first, last]);

  return runs.map(([runStart, runEnd]) => [
    Math.max(0, runStart - contextLines),
    Math.min(edits.length - 1, runEnd + contextLines),
  ]);
}

/** Render the hunk covering the edit range `[hunkStart, hunkEnd]` inclusive. */
function buildHunk(edits: Edit[], hunkStart: number, hunkEnd: number): Hunk {
  // Old/new line positions consumed before the hunk starts.
  let oldLine = 0;
  let newLine = 0;
  for (let i = 0; i < hunkStart; i++) {
    if (edits[i].type !== 'insert') oldLine++;
    if (edits[i].type !== 'delete') newLine++;
  }

  const lines: DiffLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (let i = hunkStart; i <= hunkEnd; i++) {
    const edit = edits[i];
    switch (edit.type) {
      case 'equal':
        lines.push(diffLine(' ', edit.line));
        oldCount++;
        newCount++;
        break;
      case 'delete':
        lines.push(diffLine('-', edit.line));
        oldCount++;
        break;
      case 'insert':
        lines.push(diffLine('+', edit.line));
        newCount++;
        break;
    }
  }

  // A side that contributes no lines is numbered by what came BEFORE the hunk,
  // not by its first line: git heads an addition to an empty file
  // `@@ -0,0 +1,3 @@`, and a `-U0` insertion after line 2 `@@ -2,0 +3 @@`.
  // `oldLine + 1` there would name a line the old file does not have.
  return {
    oldStart: oldCount === 0 ? oldLine : oldLine + 1,
    oldCount,
    newStart: newCount === 0 ? newLine : newLine + 1,
    newCount,
    lines,
  };
}

/** Group edits into unified diff hunks with `contextLines` of context. */
function buildHunks(edits: Edit[], contextLines = 3): Hunk[] {
  return hunkRanges(edits, contextLines).map(([start, end]) => buildHunk(edits, start, end));
}

/** git omits the `,<count>` of a one-line side: `@@ -1 +0,0 @@`, not `-1,1`. */
function hunkRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

export interface UnifiedDiffOptions {
  oldContent: string;
  newContent: string;
  oldName: string;
  newName: string;
  color?: boolean;
  /** Context lines kept around each hunk (git's `-U<n>`). Defaults to 3. */
  context?: number;
  /**
   * Render one side as `/dev/null`, the way git heads a pure addition or
   * deletion, instead of `a/<name>` / `b/<name>`. The caller passes the
   * PRESENT path as both `oldName` and `newName` — that is what git puts on
   * the `diff --git` line for an add or a delete.
   */
  absent?: 'old' | 'new';
}

/**
 * Produce a unified diff string between two texts.
 * Returns empty string if the contents are identical.
 */
export function unifiedDiff(opts: UnifiedDiffOptions): string {
  const { oldContent, newContent, oldName, newName, color = true, context = 3, absent } = opts;

  if (oldContent === newContent) return '';

  const edits = myersDiff(taggedLines(oldContent), taggedLines(newContent));
  const hunks = buildHunks(edits, context);

  if (hunks.length === 0) return '';

  const RED = color ? '\x1b[31m' : '';
  const GREEN = color ? '\x1b[32m' : '';
  const CYAN = color ? '\x1b[36m' : '';
  const BOLD = color ? '\x1b[1m' : '';
  const RESET = color ? '\x1b[0m' : '';

  const oldLabel = absent === 'old' ? '/dev/null' : `a/${oldName}`;
  const newLabel = absent === 'new' ? '/dev/null' : `b/${newName}`;

  let output = '';
  output += `${BOLD}diff --git a/${oldName} b/${newName}${RESET}\n`;
  output += `${BOLD}--- ${oldLabel}${RESET}\n`;
  output += `${BOLD}+++ ${newLabel}${RESET}\n`;

  for (const hunk of hunks) {
    const oldRange = hunkRange(hunk.oldStart, hunk.oldCount);
    const newRange = hunkRange(hunk.newStart, hunk.newCount);
    output += `${CYAN}@@ -${oldRange} +${newRange} @@${RESET}\n`;
    for (const line of hunk.lines) {
      const color = line.sign === '+' ? GREEN : line.sign === '-' ? RED : '';
      output += `${color}${line.sign}${line.text}${color ? RESET : ''}\n`;
      // git puts the marker on the line it applies to, and never counts it.
      if (line.incomplete) output += `${NO_NEWLINE_MARKER}\n`;
    }
  }

  return output;
}

/**
 * Compute --stat summary for a single file diff.
 * Returns { insertions, deletions } counts.
 */
export function diffStat(
  oldContent: string,
  newContent: string
): { insertions: number; deletions: number } {
  if (oldContent === newContent) return { insertions: 0, deletions: 0 };

  const edits = myersDiff(taggedLines(oldContent), taggedLines(newContent));

  let insertions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === 'insert') insertions++;
    if (edit.type === 'delete') deletions++;
  }
  return { insertions, deletions };
}

/** One row of a `--stat` summary. */
export interface DiffStatEntry {
  /** Row label. Usually a path; `git diff --no-index` renders `a => b` forms. */
  name: string;
  oldContent: string;
  newContent: string;
  /**
   * Byte sizes when the pair is binary. Set it and the row renders git's
   * `Bin <old> -> <new> bytes` instead of a +/- bar, and contributes no
   * insertions or deletions to the summary line.
   */
  binary?: { oldSize: number; newSize: number };
}

/**
 * Render git's `--stat` block (one row per entry plus the summary line).
 *
 * Shared by every diff producer — the commit/index/workdir walks in
 * `commands/diff.ts` and `git diff --no-index` — so the row layout and the
 * "N files changed" arithmetic have exactly one implementation.
 */
export function formatDiffStatText(entries: readonly DiffStatEntry[]): string {
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const RESET = '\x1b[0m';

  let output = '';
  let totalInsertions = 0;
  let totalDeletions = 0;
  let maxNameLen = 0;

  const rows = entries.map((entry) => {
    const counts = entry.binary
      ? { insertions: 0, deletions: 0 }
      : diffStat(entry.oldContent, entry.newContent);
    if (entry.name.length > maxNameLen) maxNameLen = entry.name.length;
    totalInsertions += counts.insertions;
    totalDeletions += counts.deletions;
    return { name: entry.name, binary: entry.binary, ...counts };
  });

  for (const row of rows) {
    const label = row.name.padEnd(maxNameLen);
    if (row.binary) {
      output += ` ${label} | Bin ${row.binary.oldSize} -> ${row.binary.newSize} bytes\n`;
      continue;
    }
    const total = row.insertions + row.deletions;
    const bar = `${GREEN}${'+'.repeat(row.insertions)}${RESET}${RED}${'-'.repeat(row.deletions)}${RESET}`;
    output += ` ${label} | ${String(total).padStart(4)} ${bar}\n`;
  }

  output += ` ${entries.length} file${entries.length !== 1 ? 's' : ''} changed`;
  // git suppresses a zero clause only when the OTHER one is non-zero, so a
  // binary-only change still reports `0 insertions(+), 0 deletions(-)`.
  if (totalInsertions > 0 || totalDeletions === 0)
    output += `, ${totalInsertions} insertion${totalInsertions !== 1 ? 's' : ''}(+)`;
  if (totalDeletions > 0 || totalInsertions === 0)
    output += `, ${totalDeletions} deletion${totalDeletions !== 1 ? 's' : ''}(-)`;
  output += '\n';

  return output;
}
