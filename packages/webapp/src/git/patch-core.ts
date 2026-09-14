export const DEV_NULL = '/dev/null';

export interface PatchHunk {
  oldStart: number;

  newStart: number;

  oldLines: string[];

  newLines: string[];

  leadingContext: number;

  trailingContext: number;

  oldNoNewlineAtEof: boolean;

  newNoNewlineAtEof: boolean;

  raw: string[];
}

export interface FilePatch {
  oldName: string;

  newName: string;
  hunks: PatchHunk[];
}

export function isCreation(patch: FilePatch): boolean {
  return patch.oldName === DEV_NULL;
}

export function isDeletion(patch: FilePatch): boolean {
  return patch.newName === DEV_NULL;
}

export function parseHeaderName(rest: string): string {
  const tab = rest.indexOf('\t');
  const name = tab === -1 ? rest.replace(/\s+\d{4}-\d\d-\d\d[ T].*$/, '') : rest.slice(0, tab);
  return name.trimEnd();
}

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string): HunkHeader | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

interface HunkBuilder extends HunkHeader {
  oldLines: string[];
  newLines: string[];
  oldSeen: number;
  newSeen: number;
  changeSeen: boolean;
  leadingContext: number;
  trailingContext: number;

  lastSide: 'old' | 'new' | 'both' | null;
  oldNoNewlineAtEof: boolean;
  newNoNewlineAtEof: boolean;
  raw: string[];
}

function startHunk(header: HunkHeader, raw: string): HunkBuilder {
  return {
    ...header,
    oldLines: [],
    newLines: [],
    oldSeen: 0,
    newSeen: 0,
    changeSeen: false,
    leadingContext: 0,
    trailingContext: 0,
    lastSide: null,
    oldNoNewlineAtEof: false,
    newNoNewlineAtEof: false,
    raw: [raw],
  };
}

function finishHunk(builder: HunkBuilder): PatchHunk {
  return {
    oldStart: builder.oldStart,
    newStart: builder.newStart,
    oldLines: builder.oldLines,
    newLines: builder.newLines,
    leadingContext: builder.leadingContext,
    trailingContext: builder.trailingContext,
    oldNoNewlineAtEof: builder.oldNoNewlineAtEof,
    newNoNewlineAtEof: builder.newNoNewlineAtEof,
    raw: builder.raw,
  };
}

function hunkIsComplete(builder: HunkBuilder): boolean {
  return builder.oldSeen >= builder.oldCount && builder.newSeen >= builder.newCount;
}

function addContext(builder: HunkBuilder, content: string): void {
  builder.oldLines.push(content);
  builder.newLines.push(content);
  builder.oldSeen++;
  builder.newSeen++;
  builder.lastSide = 'both';
  if (builder.changeSeen) builder.trailingContext++;
  else builder.leadingContext++;
}

function addChange(builder: HunkBuilder, side: 'old' | 'new', content: string): void {
  if (side === 'old') {
    builder.oldLines.push(content);
    builder.oldSeen++;
  } else {
    builder.newLines.push(content);
    builder.newSeen++;
  }
  builder.lastSide = side;
  builder.changeSeen = true;
  builder.trailingContext = 0;
}

function addBodyLine(builder: HunkBuilder, line: string): boolean {
  if (line.startsWith('\\')) {
    if (builder.lastSide === 'old' || builder.lastSide === 'both') builder.oldNoNewlineAtEof = true;
    if (builder.lastSide === 'new' || builder.lastSide === 'both') builder.newNoNewlineAtEof = true;
    builder.raw.push(line);
    return true;
  }

  if (line === '') {
    addContext(builder, '');
    builder.raw.push(' ');
    return true;
  }
  const content = line.slice(1);
  switch (line[0]) {
    case ' ':
      addContext(builder, content);
      break;
    case '-':
      addChange(builder, 'old', content);
      break;
    case '+':
      addChange(builder, 'new', content);
      break;
    default:
      return false;
  }
  builder.raw.push(line);
  return true;
}

interface ParseState {
  files: FilePatch[];
  current: FilePatch | null;
  hunk: HunkBuilder | null;

  complete: boolean;

  pendingOld: string | null;
}

function closeHunk(state: ParseState): void {
  if (state.hunk && state.current) state.current.hunks.push(finishHunk(state.hunk));
  state.hunk = null;
  state.complete = false;
}

function feedHunk(state: ParseState, line: string): boolean {
  const hunk = state.hunk;
  if (!hunk) return false;
  if (state.complete) {
    const trailingMarker = line.startsWith('\\');
    if (trailingMarker) addBodyLine(hunk, line);
    closeHunk(state);
    return trailingMarker;
  }
  if (!addBodyLine(hunk, line)) {
    closeHunk(state);
    return false;
  }
  if (hunkIsComplete(hunk)) state.complete = true;
  return true;
}

export function parseUnifiedDiff(text: string): FilePatch[] {
  const state: ParseState = {
    files: [],
    current: null,
    hunk: null,
    complete: false,
    pendingOld: null,
  };
  for (const line of text.split('\n')) {
    if (feedHunk(state, line)) continue;
    if (line.startsWith('--- ')) {
      state.pendingOld = parseHeaderName(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ') && state.pendingOld !== null) {
      state.current = {
        oldName: state.pendingOld,
        newName: parseHeaderName(line.slice(4)),
        hunks: [],
      };
      state.files.push(state.current);
      state.pendingOld = null;
      continue;
    }
    state.pendingOld = null;
    const header = parseHunkHeader(line);
    if (header && state.current) state.hunk = startHunk(header, line);
  }
  closeHunk(state);
  return state.files.filter((file) => file.hunks.length > 0);
}

export function reversePatch(patch: FilePatch): FilePatch {
  return {
    oldName: patch.newName,
    newName: patch.oldName,
    hunks: patch.hunks.map((hunk) => ({
      oldStart: hunk.newStart,
      newStart: hunk.oldStart,
      oldLines: hunk.newLines,
      newLines: hunk.oldLines,
      leadingContext: hunk.leadingContext,
      trailingContext: hunk.trailingContext,
      oldNoNewlineAtEof: hunk.newNoNewlineAtEof,
      newNoNewlineAtEof: hunk.oldNoNewlineAtEof,
      raw: reverseRaw(hunk),
    })),
  };
}

function reverseRaw(hunk: PatchHunk): string[] {
  return hunk.raw.map((line, index) => {
    if (index === 0) {
      return (
        `@@ -${hunk.newStart},${hunk.newLines.length} ` +
        `+${hunk.oldStart},${hunk.oldLines.length} @@`
      );
    }
    if (line.startsWith('-')) return `+${line.slice(1)}`;
    if (line.startsWith('+')) return `-${line.slice(1)}`;
    return line;
  });
}

export interface FileText {
  lines: string[];

  newlineAtEof: boolean;
}

export function splitLines(text: string): FileText {
  if (text === '') return { lines: [], newlineAtEof: true };
  const newlineAtEof = text.endsWith('\n');
  const lines = text.split('\n');
  if (newlineAtEof) lines.pop();
  return { lines, newlineAtEof };
}

export function joinLines(file: FileText): string {
  if (file.lines.length === 0) return '';
  return file.lines.join('\n') + (file.newlineAtEof ? '\n' : '');
}

export interface HunkOutcome {
  index: number;
  applied: boolean;

  offset: number;

  fuzz: number;

  line: number;
}

export interface ApplyPatchResult {
  text: string;
  outcomes: HunkOutcome[];

  rejected: PatchHunk[];
}

export interface ApplyPatchOptions {
  fuzz?: number;
}

function matchesAt(lines: string[], pattern: string[], at: number): boolean {
  if (at < 0 || at + pattern.length > lines.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (lines[at + i] !== pattern[i]) return false;
  }
  return true;
}

interface Placement {
  at: number;
  lead: number;
  trail: number;
  fuzz: number;
}

function searchOutward(lines: string[], pattern: string[], guess: number): number | null {
  if (matchesAt(lines, pattern, guess)) return guess;
  const reach = Math.max(guess, lines.length - guess) + pattern.length;
  for (let distance = 1; distance <= reach; distance++) {
    if (matchesAt(lines, pattern, guess - distance)) return guess - distance;
    if (matchesAt(lines, pattern, guess + distance)) return guess + distance;
  }
  return null;
}

function findPlacement(
  hunk: PatchHunk,
  lines: string[],
  guess: number,
  maxFuzz: number
): Placement | null {
  let previous = '';
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz++) {
    const lead = Math.min(fuzz, hunk.leadingContext);
    const trail = Math.min(fuzz, hunk.trailingContext);
    const signature = `${lead}:${trail}`;
    if (fuzz > 0 && signature === previous) continue;
    previous = signature;
    const pattern = hunk.oldLines.slice(lead, hunk.oldLines.length - trail);
    if (fuzz > 0 && pattern.length === 0) continue;
    const found = searchOutward(lines, pattern, guess + lead);
    if (found !== null) return { at: found - lead, lead, trail, fuzz };
  }
  return null;
}

function spliceHunk(file: FileText, hunk: PatchHunk, placement: Placement): void {
  const { at, lead, trail } = placement;
  const replaced = hunk.oldLines.length - lead - trail;
  const replacement = hunk.newLines.slice(lead, hunk.newLines.length - trail);
  file.lines.splice(at + lead, replaced, ...replacement);
  const endsFile = at + lead + replacement.length === file.lines.length;
  if (endsFile && hunk.newLines.length > 0) file.newlineAtEof = !hunk.newNoNewlineAtEof;
}

export function applyPatch(
  source: string,
  patch: FilePatch,
  options: ApplyPatchOptions = {}
): ApplyPatchResult {
  const maxFuzz = options.fuzz ?? 2;
  const file = splitLines(source);
  const outcomes: HunkOutcome[] = [];
  const rejected: PatchHunk[] = [];
  let drift = 0;

  for (const [position, hunk] of patch.hunks.entries()) {
    const guess = Math.max(0, hunk.oldStart - 1 + drift);
    const placement = findPlacement(hunk, file.lines, guess, maxFuzz);
    if (!placement) {
      const line = Math.max(1, hunk.oldStart + drift);
      outcomes.push({ index: position + 1, applied: false, offset: 0, fuzz: 0, line });
      rejected.push(hunk);
      continue;
    }
    spliceHunk(file, hunk, placement);
    outcomes.push({
      index: position + 1,
      applied: true,
      offset: placement.at - guess,
      fuzz: placement.fuzz,
      line: placement.at + 1,
    });
    drift += placement.at - guess + (hunk.newLines.length - hunk.oldLines.length);
  }

  return { text: joinLines(file), outcomes, rejected };
}

export function formatRejects(patch: FilePatch, rejected: PatchHunk[]): string {
  const lines = [`--- ${patch.oldName}`, `+++ ${patch.newName}`];
  for (const hunk of rejected) lines.push(...hunk.raw);
  return `${lines.join('\n')}\n`;
}
