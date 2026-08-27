/**
 * Finding base64 payloads in chat text.
 *
 * People paste blobs into chat — a screenshot as a data URL, the output of
 * `base64 < key.pem`, an API response with an embedded attachment. Rendered as
 * prose, a single one of those is thousands of unbroken characters: it either
 * drags the whole transcript sideways or, once wrapped, buries the sentence
 * around it under forty lines of noise.
 *
 * This module does the first half of fixing that: it extracts CANDIDATES.
 * It deliberately cannot tell you whether a candidate is really a payload —
 * that answer comes from DECODING it and looking at the bytes, which is
 * `core/base64-payload.ts`. The split mirrors `file-mentions.ts` and exists for
 * the same reason: guessing and verifying have opposite failure costs.
 *
 * ## Except the costs are not the same as a file mention's
 *
 * A wrong file mention is a link that goes nowhere — cheap. A wrong base64
 * match ELIDES text the user typed, replacing it with a chip. Hiding someone's
 * own words is much worse than failing to decorate them, so this heuristic is
 * the conservative twin of `file-mentions.ts`:
 *
 *  - **Long.** {@link MIN_PAYLOAD_CHARS} characters minimum. Below that the run
 *    is not causing the problem this feature exists to solve, and short
 *    base64-alphabet runs are everywhere (ids, hashes, JWT segments).
 *  - **Well-formed.** A bare run must be a whole number of base64 quanta —
 *    real encoders pad. This alone rejects most accidental alphanumeric runs.
 *  - **Whole-token.** A run must start and end on a boundary, so half of a
 *    longer identifier never gets clipped out of the middle of a word.
 *
 * And then the caller still has to decode it and recognize the bytes.
 *
 * Three shapes are recognized: a `data:<mime>;base64,<payload>` URL, whose
 * declared MIME type is carried out as a hint; a bare single-line run; and the
 * COLUMN-WRAPPED block that `base64`(1) emits by default, whose individual
 * lines are each too short to clear the length bar on their own.
 */

import { normalizeBase64 } from '@slicc/shared-ts';

/**
 * How many alphabet characters a bare run needs before it counts. Padding is
 * not part of the count — it is a property of the encoding, not of the length
 * that makes a payload a problem to read.
 *
 * 128 characters is 96 decoded bytes — comfortably enough for magic bytes or a
 * legible line of text, and long enough that the run is genuinely disruptive to
 * read. It is also above the common false-positive sizes: a sha256 hex digest
 * is 64, a UUID-ish id is shorter still, and the payload segment of a small JWT
 * usually is too. A user who pastes a 100-character token keeps seeing it.
 */
export const MIN_PAYLOAD_CHARS = 128;

/** A base64 payload found in text, with the span it occupies in the source. */
export interface Base64Candidate {
  /** The matched text exactly as it appeared, including any `data:` prefix. */
  raw: string;
  /** The payload, whitespace stripped and padding restored. */
  data: string;
  /** The MIME type a `data:` URL declared, when the candidate was one. */
  declaredMime?: string;
  /** Start offset in the source string (inclusive). */
  start: number;
  /** End offset in the source string (exclusive). */
  end: number;
}

/**
 * `data:<mime>;base64,<payload>`.
 *
 * The MIME type is matched loosely (`[\w.+-]+/[\w.+-]+`) because the parameter
 * list between it and `;base64` is not ours to interpret — a `charset` or a
 * vendor parameter must not stop the payload being recognized.
 */
const DATA_URL_RE = /data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[^;,]*)*;base64,([A-Za-z0-9+/=]+)/g;

/**
 * Characters that may sit immediately before a run, and immediately after it.
 *
 * An explicit, small delimiter set rather than "anything outside the alphabet",
 * because the characters this EXCLUDES are the ones that make a match wrong:
 *
 *  - A leading `.` would match the middle segment of a JWT
 *    (`header.payload.signature`), eliding half a token the user pasted and
 *    leaving the other half beside it. So `.` opens nothing — but it CLOSES a
 *    run, because a payload at the end of a sentence is followed by a period.
 *  - `-` and `_` are the base64url alphabet. A run bounded by one of them is a
 *    slice of a URL-safe token, which `atob` cannot decode anyway.
 *
 * What remains is what a pasted blob is actually surrounded by: whitespace,
 * quotes, brackets, and the separators of a key/value pair.
 */
const RUN_OPENERS = '\\s"\'`(\\[{<,;:=';
const RUN_CLOSERS = '\\s"\'`)\\]}>,;:.!?';

/**
 * A bare run of base64: an opening boundary, the alphabet characters, and up to
 * two padding characters.
 *
 * The leading boundary is CONSUMED rather than expressed as a lookbehind —
 * Safari only grew lookbehind in 16.4, and `file-mentions.ts` already
 * establishes the eat-one-delimiter pattern. Nothing is lost to it: the
 * trailing boundary is a lookahead, so two blobs separated by a single
 * character still both match.
 *
 * A newline is a closer like any other, so a bare run never spans lines. The
 * WRAPPED shape that `base64`(1) actually emits is matched separately, below.
 */
const BARE_RUN_RE = new RegExp(
  `(?:^|[${RUN_OPENERS}])([A-Za-z0-9+/]{${MIN_PAYLOAD_CHARS},}={0,2})(?=$|[${RUN_CLOSERS}])`,
  'g'
);

/**
 * The narrowest wrap column a block is believed at.
 *
 * The widths that actually occur are 64 (PEM), 72 and 76 (`base64`(1) and
 * MIME). A floor well below all of them still admits every real encoder, while
 * refusing the shape a low floor would really buy: a column of short,
 * coincidentally equal-width alphanumeric tokens.
 */
const MIN_WRAP_COLUMNS = 16;

/** A line of `text`, with the span it occupies (the newline excluded). */
interface SourceLine {
  start: number;
  end: number;
  text: string;
}

function scanLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const br = text.indexOf('\n', start);
    const end = br < 0 ? text.length : br;
    // A CRLF file puts the `\r` inside the line; it belongs to the separator.
    const trimmed = text[end - 1] === '\r' ? end - 1 : end;
    lines.push({ start, end: trimmed, text: text.slice(start, trimmed) });
    if (br < 0) return lines;
    start = br + 1;
  }
}

const PURE_ALPHABET_RE = /^[A-Za-z0-9+/]+$/;
const PADDED_TAIL_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Column-wrapped base64: what `base64`(1) writes by default.
 *
 * `base64 < report.pdf` wraps at 76 columns, PEM at 64, MIME at 76 — so the
 * shape a user actually pastes is a stack of lines each far below
 * {@link MIN_PAYLOAD_CHARS}. Matched one line at a time it is invisible to the
 * bare-run pattern, which is the whole advertised scenario missed.
 *
 * Reassembly is deliberately narrow, because gluing lines together is where a
 * heuristic could start eating prose. A block is believed only when it has the
 * exact shape an encoder produces:
 *
 *  - Two or more WHOLE lines — a line must start where a line starts, so a
 *    block can never begin mid-sentence.
 *  - Every line but the last is pure alphabet, of the SAME width, and that
 *    width is a whole number of base64 quanta. Real encoders wrap on a fixed
 *    column; prose does not.
 *  - The last line is no wider, and is the only one allowed to carry padding.
 *  - The lines together clear {@link MIN_PAYLOAD_CHARS} and decode.
 *
 * A stanza of English text fails on the second rule almost immediately: two
 * consecutive lines of identical length, containing no space or punctuation,
 * is not what writing looks like.
 */
function findWrappedBlocks(text: string): Base64Candidate[] {
  const lines = scanLines(text);
  const blocks: Base64Candidate[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const width = wrapWidthAt(lines, i);
    if (width === null) continue;
    const tail = blockEnd(lines, i, width);
    if (tail === i) continue; // a single line is the bare-run pattern's job
    const pieces = lines.slice(i, tail + 1);
    const lead = precedingFragment(lines, i, width);
    if (lead) pieces.unshift(lead);
    const block = claimBlock(text, pieces);
    if (block) blocks.push(block);
    i = tail; // never re-enter a block we already walked
  }

  return blocks;
}

/** The wrap column a block starting at `i` would have, or `null` if none. */
function wrapWidthAt(lines: readonly SourceLine[], i: number): number | null {
  const first = lines[i];
  if (!first) return null;
  const width = first.text.length;
  if (width < MIN_WRAP_COLUMNS || width % 4 !== 0) return null;
  return PURE_ALPHABET_RE.test(first.text) ? width : null;
}

/**
 * Index of the last line belonging to the block that starts at `i`: every
 * following line of exactly `width`, then optionally one narrower final line.
 *
 * That final line is the payload's remainder and the only one allowed to carry
 * padding — but it is a remainder only if nothing MORE of the block follows it.
 * Without that check a ragged pair of prose lines (76 then 72) reads as a
 * complete block, which is exactly the shape a wrapped-text paragraph has.
 */
function blockEnd(lines: readonly SourceLine[], i: number, width: number): number {
  let last = i;
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (!line || line.text.length !== width || !PURE_ALPHABET_RE.test(line.text)) break;
    last = j;
  }
  const next = lines[last + 1];
  if (!next || next.text.length === 0 || next.text.length >= width) return last;
  if (!PADDED_TAIL_RE.test(next.text)) return last;
  const after = lines[last + 2];
  const blockContinues =
    after !== undefined && after.text.length === width && PURE_ALPHABET_RE.test(after.text);
  return blockContinues ? last : last + 1;
}

/**
 * The tail of the line BEFORE a block, when the payload plainly started there.
 *
 * `here it is: <76 chars>` followed by more full-width lines is one paste with
 * the user's own words in front of it — the encoder still wrapped on the same
 * column, it just did not get the whole first line to itself. Without this the
 * block would be claimed from its SECOND line, eliding most of the payload and
 * leaving the first 76 characters stranded as text beside the chip: the
 * clipped-out-of-the-middle failure this module exists to avoid.
 *
 * The run has to be exactly one wrap column wide and start on a boundary. A
 * longer run means the line is not wrap-aligned, so gluing it on would be a
 * guess rather than a reconstruction.
 */
function precedingFragment(
  lines: readonly SourceLine[],
  i: number,
  width: number
): SourceLine | null {
  const prev = lines[i - 1];
  if (!prev || prev.text.length <= width) return null;
  const cut = prev.text.length - width;
  const suffix = prev.text.slice(cut);
  if (!PURE_ALPHABET_RE.test(suffix)) return null;
  if (PURE_ALPHABET_RE.test(prev.text[cut - 1] ?? ' ')) return null;
  return { start: prev.start + cut, end: prev.end, text: suffix };
}

/** Turn a run of lines into a candidate, or `null` if it does not decode. */
function claimBlock(text: string, block: readonly SourceLine[]): Base64Candidate | null {
  const joined = block.map((line) => line.text).join('');
  if (joined.replace(/=+$/, '').length < MIN_PAYLOAD_CHARS) return null;
  if (joined.length % 4 !== 0) return null;
  const data = normalizeBase64(joined);
  if (!data) return null;
  const start = block[0]?.start ?? 0;
  const end = block[block.length - 1]?.end ?? start;
  return { raw: text.slice(start, end), data, start, end };
}

/**
 * Extract every plausible base64 payload from `text`, in order and without
 * overlaps.
 *
 * Collected most-specific first, each shape claiming its spans: `data:` URLs
 * (which carry a declared MIME type that reporting the bytes twice would lose),
 * then column-wrapped blocks, then bare single-line runs. A wide wrap column
 * can exceed the bare-run threshold on its own, so the block has to claim its
 * lines before the bare-run pass sees them.
 */
export function findBase64Mentions(text: string): Base64Candidate[] {
  const found: Base64Candidate[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  DATA_URL_RE.lastIndex = 0;
  for (const match of text.matchAll(DATA_URL_RE)) {
    const payload = match[2] ?? '';
    if (payload.length < MIN_PAYLOAD_CHARS) continue;
    const data = normalizeBase64(payload);
    if (!data) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    found.push({ raw: match[0], data, declaredMime: match[1] ?? '', start, end });
    claimed.push([start, end]);
  }

  for (const block of findWrappedBlocks(text)) {
    if (overlaps(block.start, block.end)) continue;
    found.push(block);
    claimed.push([block.start, block.end]);
  }

  BARE_RUN_RE.lastIndex = 0;
  for (const match of text.matchAll(BARE_RUN_RE)) {
    const raw = match[1] ?? '';
    // The pattern ate one leading delimiter to anchor on a boundary; the
    // candidate itself starts after it.
    const start = (match.index ?? 0) + (match[0].length - raw.length);
    const end = start + raw.length;
    if (overlaps(start, end)) continue;
    // A whole number of quanta. `normalizeBase64` would happily pad an
    // unpadded tail, but a real encoder emits the padding — an unpadded
    // remainder means this run is more likely a slice of something else.
    if (raw.length % 4 !== 0) continue;
    const data = normalizeBase64(raw);
    if (!data) continue;
    found.push({ raw, data, start, end });
    claimed.push([start, end]);
  }

  return found.sort((a, b) => a.start - b.start);
}
