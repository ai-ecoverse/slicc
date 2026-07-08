/**
 * Pure, dependency-free three-way (diff3) merge.
 *
 * Aligns current↔base and other↔base using the shared Myers line-diff, walks the
 * stable (common) base regions, and emits changed regions. A region conflicts when
 * both sides changed the same base region divergently. Produces merged text plus a
 * conflict count. No file I/O or CLI parsing lives here.
 */
import { myersDiff } from './diff.js';

export interface ThreeWayMergeOptions {
  diff3?: boolean;
  favor?: 'ours' | 'theirs' | 'union';
  labels?: { current: string; base: string; other: string };
}

export interface ThreeWayMergeResult {
  content: string;
  conflicts: number;
}

/** Split into lines that each retain their trailing `\n`, so concatenation is exact. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function linesEqual(x: string[], y: string[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

interface Hunk {
  side: 'a' | 'b';
  baseStart: number;
  baseLen: number;
  sideStart: number;
  sideLen: number;
}

/** Changed regions between `base` and `side`, expressed in base offsets. */
function diffHunks(base: string[], side: string[], tag: 'a' | 'b'): Hunk[] {
  const edits = myersDiff(base, side);
  const hunks: Hunk[] = [];
  let baseIdx = 0;
  let sideIdx = 0;
  let i = 0;
  while (i < edits.length) {
    if (edits[i].type === 'equal') {
      baseIdx++;
      sideIdx++;
      i++;
      continue;
    }
    const baseStart = baseIdx;
    const sideStart = sideIdx;
    while (i < edits.length && edits[i].type !== 'equal') {
      if (edits[i].type === 'delete') baseIdx++;
      else sideIdx++;
      i++;
    }
    hunks.push({
      side: tag,
      baseStart,
      baseLen: baseIdx - baseStart,
      sideStart,
      sideLen: sideIdx - sideStart,
    });
  }
  return hunks;
}

type Region =
  | { stable: true; lines: string[] }
  | { stable: false; aLines: string[]; oLines: string[]; bLines: string[] };

/** diff3 region walk: stable base spans, one-sided auto-merges, and conflict windows. */
function diff3Regions(a: string[], o: string[], b: string[]): Region[] {
  const hunks = [...diffHunks(o, a, 'a'), ...diffHunks(o, b, 'b')];
  hunks.sort((x, y) => x.baseStart - y.baseStart || x.baseLen - y.baseLen);

  const regions: Region[] = [];
  let currOffset = 0;
  const advanceTo = (end: number) => {
    if (end > currOffset) {
      regions.push({ stable: true, lines: o.slice(currOffset, end) });
      currOffset = end;
    }
  };

  let i = 0;
  while (i < hunks.length) {
    const hunk = hunks[i];
    i++;
    const regionStart = hunk.baseStart;
    let regionEnd = hunk.baseStart + hunk.baseLen;
    const regionHunks = [hunk];
    advanceTo(regionStart);
    while (i < hunks.length && hunks[i].baseStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[i].baseStart + hunks[i].baseLen);
      regionHunks.push(hunks[i]);
      i++;
    }

    if (regionHunks.length === 1) {
      const sideArr = hunk.side === 'a' ? a : b;
      if (hunk.sideLen > 0) {
        regions.push({
          stable: true,
          lines: sideArr.slice(hunk.sideStart, hunk.sideStart + hunk.sideLen),
        });
      }
    } else {
      const bounds = { a: [a.length, -1, o.length, -1], b: [b.length, -1, o.length, -1] };
      for (const h of regionHunks) {
        const bd = bounds[h.side];
        bd[0] = Math.min(h.sideStart, bd[0]);
        bd[1] = Math.max(h.sideStart + h.sideLen, bd[1]);
        bd[2] = Math.min(h.baseStart, bd[2]);
        bd[3] = Math.max(h.baseStart + h.baseLen, bd[3]);
      }
      const aStart = bounds.a[0] + (regionStart - bounds.a[2]);
      const aEnd = bounds.a[1] + (regionEnd - bounds.a[3]);
      const bStart = bounds.b[0] + (regionStart - bounds.b[2]);
      const bEnd = bounds.b[1] + (regionEnd - bounds.b[3]);
      regions.push({
        stable: false,
        aLines: a.slice(aStart, aEnd),
        oLines: o.slice(regionStart, regionEnd),
        bLines: b.slice(bStart, bEnd),
      });
    }
    currOffset = regionEnd;
  }
  advanceTo(o.length);
  return regions;
}

/**
 * Three-way merge of `current` (ours) and `other` (theirs) against `base`.
 * Disjoint or identical changes auto-merge; divergent overlaps produce conflict
 * hunks (or resolve per `favor`). Line content is preserved exactly.
 */
export function threeWayMerge(
  current: string,
  base: string,
  other: string,
  opts: ThreeWayMergeOptions = {}
): ThreeWayMergeResult {
  const diff3 = opts.diff3 ?? false;
  const favor = opts.favor;
  const labels = {
    current: opts.labels?.current ?? 'current',
    base: opts.labels?.base ?? 'base',
    other: opts.labels?.other ?? 'other',
  };

  const a = splitLines(current);
  const o = splitLines(base);
  const b = splitLines(other);
  const regions = diff3Regions(a, o, b);

  let out = '';
  let conflicts = 0;
  const push = (lines: string[]) => {
    for (const line of lines) out += line;
  };
  const pushMarker = (text: string) => {
    if (out.length > 0 && !out.endsWith('\n')) out += '\n';
    out += `${text}\n`;
  };

  for (const region of regions) {
    if (region.stable) {
      push(region.lines);
      continue;
    }
    if (linesEqual(region.aLines, region.bLines)) {
      push(region.aLines);
      continue;
    }

    conflicts++;
    if (favor === 'ours') {
      push(region.aLines);
    } else if (favor === 'theirs') {
      push(region.bLines);
    } else if (favor === 'union') {
      push(region.aLines);
      if (out.length > 0 && !out.endsWith('\n') && region.bLines.length > 0) out += '\n';
      push(region.bLines);
    } else {
      pushMarker(`<<<<<<< ${labels.current}`);
      push(region.aLines);
      if (diff3) {
        pushMarker(`||||||| ${labels.base}`);
        push(region.oLines);
      }
      pushMarker('=======');
      push(region.bLines);
      pushMarker(`>>>>>>> ${labels.other}`);
    }
  }

  return { content: out, conflicts };
}
