export interface Edit {
  type: 'equal' | 'insert' | 'delete';
  line: string;
}

interface DiffRange {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

interface Frontier {
  x: Int32Array;
  start: number;
  end: number;
  reverse: boolean;
}

function matchingEnd(
  a: string[],
  b: string[],
  range: DiffRange,
  x: number,
  y: number,
  reverse: boolean
): number {
  const n = range.aEnd - range.aStart;
  const m = range.bEnd - range.bStart;
  while (
    x < n &&
    y < m &&
    a[reverse ? range.aEnd - x - 1 : range.aStart + x] ===
      b[reverse ? range.bEnd - y - 1 : range.bStart + y]
  ) {
    x++;
    y++;
  }
  return x;
}

function advanceFrontier(
  a: string[],
  b: string[],
  range: DiffRange,
  d: number,
  front: Frontier,
  opposite: Frontier,
  checkOverlap: boolean
): [number, number] | undefined {
  const n = range.aEnd - range.aStart;
  const m = range.bEnd - range.bStart;
  const offset = Math.ceil((n + m) / 2) + 1;
  const v = front.x;

  for (let k = -d + front.start; k <= d - front.end; k += 2) {
    const index = offset + k;
    let x = k === -d || (k !== d && v[index - 1] < v[index + 1]) ? v[index + 1] : v[index - 1] + 1;
    x = matchingEnd(a, b, range, x, x - k, front.reverse);
    const y = x - k;
    v[index] = x;
    if (x > n) front.end += 2;
    else if (y > m) front.start += 2;
    else if (checkOverlap) {
      const otherK = n - m - k;
      const otherIndex = offset + otherK;
      const otherX = otherIndex >= 0 && otherIndex < 2 * offset + 1 ? opposite.x[otherIndex] : -1;
      if (otherX >= 0 && x + otherX >= n) {
        return front.reverse ? [otherX, otherX - otherK] : [x, y];
      }
    }
  }
  return undefined;
}

function findMiddle(
  a: string[],
  b: string[],
  range: DiffRange,
  forwardX: Int32Array,
  reverseX: Int32Array
): [number, number] | undefined {
  const n = range.aEnd - range.aStart;
  const m = range.bEnd - range.bStart;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD + 1;
  forwardX.fill(-1, 0, 2 * maxD + 3);
  reverseX.fill(-1, 0, 2 * maxD + 3);
  forwardX[offset + 1] = 0;
  reverseX[offset + 1] = 0;
  const forward: Frontier = { x: forwardX, start: 0, end: 0, reverse: false };
  const reverse: Frontier = { x: reverseX, start: 0, end: 0, reverse: true };
  const odd = (n - m) % 2 !== 0;

  for (let d = 0; d < maxD; d++) {
    const split =
      advanceFrontier(a, b, range, d, forward, reverse, odd) ??
      advanceFrontier(a, b, range, d, reverse, forward, !odd);
    if (split) return [range.aStart + split[0], range.bStart + split[1]];
  }

  return undefined;
}

export function myersDiff(a: string[], b: string[]): Edit[] {
  const edits: Edit[] = [];
  const pending: DiffRange[] = [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }];
  let scratch: [Int32Array, Int32Array] | undefined;

  while (pending.length > 0) {
    const range = pending.pop()!;
    let { aStart, aEnd, bStart, bEnd } = range;
    while (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
      edits.push({ type: 'equal', line: a[aStart++] });
      bStart++;
    }
    while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }
    if (aEnd < range.aEnd) {
      pending.push({ aStart: aEnd, aEnd: range.aEnd, bStart: bEnd, bEnd: range.bEnd });
    }

    let split: [number, number] | undefined;
    if (aStart < aEnd && bStart < bEnd) {
      if (!scratch) {
        const size = 2 * Math.ceil((aEnd - aStart + bEnd - bStart) / 2) + 3;
        scratch = [new Int32Array(size), new Int32Array(size)];
      }
      split = findMiddle(a, b, { aStart, aEnd, bStart, bEnd }, ...scratch);
    }
    if (split) {
      const [aMiddle, bMiddle] = split;

      pending.push({ aStart: aMiddle, aEnd, bStart: bMiddle, bEnd });
      pending.push({ aStart, aEnd: aMiddle, bStart, bEnd: bMiddle });
    } else {
      for (let i = aStart; i < aEnd; i++) edits.push({ type: 'delete', line: a[i] });
      for (let i = bStart; i < bEnd; i++) edits.push({ type: 'insert', line: b[i] });
    }
  }
  return edits;
}

const ENDS_WITH_NEWLINE = '\n';
const ENDS_WITHOUT_NEWLINE = '\0';

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

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

interface DiffLine {
  sign: ' ' | '-' | '+';
  text: string;

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

function buildHunk(edits: Edit[], hunkStart: number, hunkEnd: number): Hunk {
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

  return {
    oldStart: oldCount === 0 ? oldLine : oldLine + 1,
    oldCount,
    newStart: newCount === 0 ? newLine : newLine + 1,
    newCount,
    lines,
  };
}

function buildHunks(edits: Edit[], contextLines = 3): Hunk[] {
  return hunkRanges(edits, contextLines).map(([start, end]) => buildHunk(edits, start, end));
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

export interface UnifiedDiffOptions {
  oldContent: string;
  newContent: string;
  oldName: string;
  newName: string;
  color?: boolean;

  context?: number;

  absent?: 'old' | 'new';
}

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

      if (line.incomplete) output += `${NO_NEWLINE_MARKER}\n`;
    }
  }

  return output;
}

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

export interface DiffStatEntry {
  name: string;
  oldContent: string;
  newContent: string;

  binary?: { oldSize: number; newSize: number };
}

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

  if (totalInsertions > 0 || totalDeletions === 0)
    output += `, ${totalInsertions} insertion${totalInsertions !== 1 ? 's' : ''}(+)`;
  if (totalDeletions > 0 || totalInsertions === 0)
    output += `, ${totalDeletions} deletion${totalDeletions !== 1 ? 's' : ''}(-)`;
  output += '\n';

  return output;
}
