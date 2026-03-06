/**
 * Minimal unified diff implementation using Myers diff algorithm.
 * Produces standard unified diff output with @@ hunk headers.
 */

interface Edit {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

/**
 * Myers diff algorithm — computes shortest edit script between two line arrays.
 */
function myersDiff(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ type: 'insert' as const, line }));
  if (m === 0) return a.map((line) => ({ type: 'delete' as const, line }));

  const max = n + m;
  const offset = max;
  const size = 2 * max + 1;

  // Forward pass: compute trace of furthest-reaching points
  const trace: number[][] = [];
  const v = new Array<number>(size).fill(0);

  let finalD = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // insert: come from k+1
      } else {
        x = v[k - 1 + offset] + 1; // delete: come from k-1
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        finalD = d;
        break outer;
      }
    }
  }

  if (finalD === -1) finalD = max;

  // Backtrack from (n, m) to (0, 0) using the trace
  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = finalD; d > 0; d--) {
    // trace[d] holds v state AFTER d-1 was processed (pushed at start of d loop)
    const prev = trace[d];
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && prev[k - 1 + offset] < prev[k + 1 + offset])) {
      prevK = k + 1; // came from insert
    } else {
      prevK = k - 1; // came from delete
    }

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

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Group edits into unified diff hunks with context lines.
 */
function buildHunks(edits: Edit[], contextLines = 3): Hunk[] {
  const hunks: Hunk[] = [];

  // Find ranges of changes
  const changeIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'equal') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group changes that are close together (within 2*context)
  let groupStart = 0;
  const groups: [number, number][] = [];

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - changeIndices[i - 1] > 2 * contextLines) {
      groups.push([groupStart, i - 1]);
      groupStart = i;
    }
  }
  groups.push([groupStart, changeIndices.length - 1]);

  for (const [gStart, gEnd] of groups) {
    const firstChange = changeIndices[gStart];
    const lastChange = changeIndices[gEnd];

    const hunkStart = Math.max(0, firstChange - contextLines);
    const hunkEnd = Math.min(edits.length - 1, lastChange + contextLines);

    const lines: string[] = [];

    // Count old/new line positions up to hunkStart
    let oldLine = 0;
    let newLine = 0;
    for (let i = 0; i < hunkStart; i++) {
      if (edits[i].type === 'equal' || edits[i].type === 'delete') oldLine++;
      if (edits[i].type === 'equal' || edits[i].type === 'insert') newLine++;
    }

    const oldStart = oldLine + 1;
    const newStart = newLine + 1;
    let oldCount = 0;
    let newCount = 0;

    for (let i = hunkStart; i <= hunkEnd; i++) {
      const edit = edits[i];
      switch (edit.type) {
        case 'equal':
          lines.push(` ${edit.line}`);
          oldCount++;
          newCount++;
          break;
        case 'delete':
          lines.push(`-${edit.line}`);
          oldCount++;
          break;
        case 'insert':
          lines.push(`+${edit.line}`);
          newCount++;
          break;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}

export interface UnifiedDiffOptions {
  oldContent: string;
  newContent: string;
  oldName: string;
  newName: string;
  color?: boolean;
}

/**
 * Produce a unified diff string between two texts.
 * Returns empty string if the contents are identical.
 */
export function unifiedDiff(opts: UnifiedDiffOptions): string {
  const { oldContent, newContent, oldName, newName, color = true } = opts;

  if (oldContent === newContent) return '';

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Remove trailing empty element from split if content ends with \n
  // (avoids a phantom empty-line diff)
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();

  const edits = myersDiff(oldLines, newLines);
  const hunks = buildHunks(edits);

  if (hunks.length === 0) return '';

  const RED = color ? '\x1b[31m' : '';
  const GREEN = color ? '\x1b[32m' : '';
  const CYAN = color ? '\x1b[36m' : '';
  const BOLD = color ? '\x1b[1m' : '';
  const RESET = color ? '\x1b[0m' : '';

  let output = '';
  output += `${BOLD}diff --git a/${oldName} b/${newName}${RESET}\n`;
  output += `${BOLD}--- a/${oldName}${RESET}\n`;
  output += `${BOLD}+++ b/${newName}${RESET}\n`;

  for (const hunk of hunks) {
    output += `${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}\n`;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        output += `${GREEN}${line}${RESET}\n`;
      } else if (line.startsWith('-')) {
        output += `${RED}${line}${RESET}\n`;
      } else {
        output += `${line}\n`;
      }
    }
  }

  return output;
}

/**
 * Compute --stat summary for a single file diff.
 * Returns { insertions, deletions } counts.
 */
export function diffStat(oldContent: string, newContent: string): { insertions: number; deletions: number } {
  if (oldContent === newContent) return { insertions: 0, deletions: 0 };

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();

  const edits = myersDiff(oldLines, newLines);

  let insertions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === 'insert') insertions++;
    if (edit.type === 'delete') deletions++;
  }
  return { insertions, deletions };
}
