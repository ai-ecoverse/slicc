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
 * Two shapes are recognized: a `data:<mime>;base64,<payload>` URL, whose
 * declared MIME type is carried out as a hint, and a bare run of base64.
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
 * Whitespace is not crossed. A `base64`(1) payload wrapped at 76 columns is
 * therefore matched one line at a time; each line still has to clear the length
 * bar on its own, and gluing lines back together would mean deciding which
 * surrounding newlines are part of the blob — a guess with no upside.
 */
const BARE_RUN_RE = new RegExp(
  `(?:^|[${RUN_OPENERS}])([A-Za-z0-9+/]{${MIN_PAYLOAD_CHARS},}={0,2})(?=$|[${RUN_CLOSERS}])`,
  'g'
);

/**
 * Extract every plausible base64 payload from `text`, in order and without
 * overlaps.
 *
 * `data:` URLs are collected first and claim their spans, so the payload inside
 * one is never also reported as a bare run — the URL carries a declared MIME
 * type, and reporting the same bytes twice would lose it.
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
