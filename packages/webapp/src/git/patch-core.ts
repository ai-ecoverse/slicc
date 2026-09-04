/**
 * Unified-diff parsing and application — the read side of `diff.ts`.
 *
 * `diff.ts` produces unified diffs (Myers) and `merge-file-core.ts` merges
 * three versions of a file; neither could take a diff back apart, which is
 * why `patch` answered 127 (#2819). This module is the missing inverse: it
 * parses a unified diff into hunks and replays them onto file text, with
 * GNU-patch-style offset search and context fuzz.
 *
 * Everything here is pure text in / text out. The VFS-facing CLI lives in
 * `shell/supplemental-commands/patch/run.ts`; keeping the core beside
 * `diff.ts` means a future `git apply` can reuse it without importing from
 * the shell layer.
 */

/** A file name a patch uses to mean "this side does not exist". */
export const DEV_NULL = '/dev/null';

export interface PatchHunk {
  /** 1-based first line of the hunk on the old side. */
  oldStart: number;
  /** 1-based first line of the hunk on the new side. */
  newStart: number;
  /** Lines removed or kept, in order (the `-` and ` ` lines, marker stripped). */
  oldLines: string[];
  /** Lines added or kept, in order (the `+` and ` ` lines, marker stripped). */
  newLines: string[];
  /** Context lines before the first change — the only ones fuzz may ignore. */
  leadingContext: number;
  /** Context lines after the last change — likewise. */
  trailingContext: number;
  /** The old side ended at EOF without a trailing newline. */
  oldNoNewlineAtEof: boolean;
  /** The new side ends at EOF without a trailing newline. */
  newNoNewlineAtEof: boolean;
  /** Raw hunk text (header + body) — replayed verbatim into a `.rej` file. */
  raw: string[];
}

export interface FilePatch {
  /** Name from the `---` header, before any `-p` stripping. */
  oldName: string;
  /** Name from the `+++` header, before any `-p` stripping. */
  newName: string;
  hunks: PatchHunk[];
}

/** The old side is `/dev/null`: the patch creates the file. */
export function isCreation(patch: FilePatch): boolean {
  return patch.oldName === DEV_NULL;
}

/** The new side is `/dev/null`: the patch deletes the file. */
export function isDeletion(patch: FilePatch): boolean {
  return patch.newName === DEV_NULL;
}

/**
 * Strip the timestamp GNU diff appends to a `---`/`+++` header.
 *
 * diff separates name from timestamp with a TAB, so that split is exact when
 * present. Some producers (and hand-written patches) use spaces instead; only
 * a trailing field that actually looks like a timestamp is dropped, so file
 * names containing spaces survive.
 */
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

/** Mutable accumulator for one hunk while its body lines are consumed. */
interface HunkBuilder extends HunkHeader {
  oldLines: string[];
  newLines: string[];
  oldSeen: number;
  newSeen: number;
  changeSeen: boolean;
  leadingContext: number;
  trailingContext: number;
  /** Which side the previous body line belonged to, for `\ No newline`. */
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

/** Record a context line: it counts toward both sides and toward the fuzz run. */
function addContext(builder: HunkBuilder, content: string): void {
  builder.oldLines.push(content);
  builder.newLines.push(content);
  builder.oldSeen++;
  builder.newSeen++;
  builder.lastSide = 'both';
  if (builder.changeSeen) builder.trailingContext++;
  else builder.leadingContext++;
}

/** Record a `-` or `+` line, which ends the leading-context run. */
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

/**
 * Consume one body line into the open hunk. Returns false when the line does
 * not belong to a hunk body, which ends the hunk.
 */
function addBodyLine(builder: HunkBuilder, line: string): boolean {
  if (line.startsWith('\\')) {
    // `\ No newline at end of file` applies to the side of the line above it.
    if (builder.lastSide === 'old' || builder.lastSide === 'both') builder.oldNoNewlineAtEof = true;
    if (builder.lastSide === 'new' || builder.lastSide === 'both') builder.newNoNewlineAtEof = true;
    builder.raw.push(line);
    return true;
  }
  // An empty line in a hunk body is a context line whose trailing space was
  // stripped (mail clients and copy-paste do this routinely).
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

/** Mutable accumulator for the whole parse. */
interface ParseState {
  files: FilePatch[];
  current: FilePatch | null;
  hunk: HunkBuilder | null;
  /**
   * The open hunk has all the lines its header promised. It stays open for
   * exactly one more line so a trailing `\ No newline at end of file` still
   * lands on it; anything else closes it.
   */
  complete: boolean;
  /** `---` seen, waiting for its `+++` partner. */
  pendingOld: string | null;
}

function closeHunk(state: ParseState): void {
  if (state.hunk && state.current) state.current.hunks.push(finishHunk(state.hunk));
  state.hunk = null;
  state.complete = false;
}

/**
 * Feed one line to the open hunk. Returns true when the line was consumed;
 * false means the hunk is closed and the line must be reconsidered as a header.
 */
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

/**
 * Parse a unified diff into one {@link FilePatch} per `---`/`+++` header pair.
 *
 * Leading prose (mail headers, `commit`/`Index:` lines, review comments) is
 * skipped the way GNU patch skips it: anything that is not a recognised header
 * outside a hunk body is ignored.
 */
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

/** Swap the two sides of a patch, so applying it undoes it (`patch -R`). */
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
  /** The text ended with a newline (an empty file counts as "yes"). */
  newlineAtEof: boolean;
}

/** Split text into lines without the phantom trailing element `split` leaves. */
export function splitLines(text: string): FileText {
  if (text === '') return { lines: [], newlineAtEof: true };
  const newlineAtEof = text.endsWith('\n');
  const lines = text.split('\n');
  if (newlineAtEof) lines.pop();
  return { lines, newlineAtEof };
}

/** Inverse of {@link splitLines}. */
export function joinLines(file: FileText): string {
  if (file.lines.length === 0) return '';
  return file.lines.join('\n') + (file.newlineAtEof ? '\n' : '');
}

export interface HunkOutcome {
  /** 1-based hunk number within its file, as GNU patch reports it. */
  index: number;
  applied: boolean;
  /** Line delta from the hunk's recorded position (`Hunk #1 succeeded … offset N`). */
  offset: number;
  /** Context lines ignored to make the hunk fit. */
  fuzz: number;
  /** Where the hunk landed (or was tried), 1-based, for the report line. */
  line: number;
}

export interface ApplyPatchResult {
  text: string;
  outcomes: HunkOutcome[];
  /** Hunks that could not be placed — the `.rej` payload. */
  rejected: PatchHunk[];
}

export interface ApplyPatchOptions {
  /** Maximum context lines to ignore per side. GNU patch's default is 2. */
  fuzz?: number;
}

/** Does `pattern` sit at `at` in `lines`? */
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

/** Exact search for `pattern`, nearest-first around `guess`. */
function searchOutward(lines: string[], pattern: string[], guess: number): number | null {
  if (matchesAt(lines, pattern, guess)) return guess;
  const reach = Math.max(guess, lines.length - guess) + pattern.length;
  for (let distance = 1; distance <= reach; distance++) {
    if (matchesAt(lines, pattern, guess - distance)) return guess - distance;
    if (matchesAt(lines, pattern, guess + distance)) return guess + distance;
  }
  return null;
}

/**
 * Search outward from `guess` for a position where the hunk's old side sits.
 *
 * Mirrors GNU patch: try the recorded position first, walking outward one line
 * at a time in both directions, then repeat with progressively more context
 * ignored. Only genuine context lines at the ends may be dropped — ignoring a
 * `-` line would silently apply a hunk to text it does not describe.
 */
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

/**
 * Splice one hunk into `file`, leaving the fuzz-ignored context lines that the
 * hunk did not actually match in place.
 */
function spliceHunk(file: FileText, hunk: PatchHunk, placement: Placement): void {
  const { at, lead, trail } = placement;
  const replaced = hunk.oldLines.length - lead - trail;
  const replacement = hunk.newLines.slice(lead, hunk.newLines.length - trail);
  file.lines.splice(at + lead, replaced, ...replacement);
  const endsFile = at + lead + replacement.length === file.lines.length;
  if (endsFile && hunk.newLines.length > 0) file.newlineAtEof = !hunk.newNoNewlineAtEof;
}

/**
 * Apply every hunk of `patch` to `source`, in order.
 *
 * Hunks are placed independently: one that cannot be found is rejected and the
 * rest still apply, which is what makes a partially-applied patch recoverable
 * from the `.rej` file.
 */
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

/** Render rejected hunks as a `.rej` file, in the shape GNU patch writes. */
export function formatRejects(patch: FilePatch, rejected: PatchHunk[]): string {
  const lines = [`--- ${patch.oldName}`, `+++ ${patch.newName}`];
  for (const hunk of rejected) lines.push(...hunk.raw);
  return `${lines.join('\n')}\n`;
}
