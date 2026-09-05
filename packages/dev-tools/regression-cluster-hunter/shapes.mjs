/*
 * Regression Cluster Hunter — the recurring defect shapes, from this repo's
 * own history.
 *
 * Why this file exists: a signature distilled from a fix's diff finds siblings
 * that share VOCABULARY, and that is not the same as sharing a BUG. Replaying
 * the selector over #2818 (`fix(webapp): keep jsh fetch binary bodies
 * byte-exact`) makes the gap concrete — its diff-derived tokens were all about
 * `latin1`, because latin1 is the convention the fix *removed*, while the five
 * real siblings (#2883, #2884, #2885, #2886, #2887) were `TextEncoder` /
 * `TextDecoder` / `base64Encoded` sites sharing no vocabulary with it at all.
 * Same bug, different words. Lexical search alone cannot cross that gap.
 *
 * Each shape therefore carries:
 *   - `detect(diff)` — does the fix that just shipped belong to this shape?
 *   - `probe(text)`  — how strongly does some other file smell of it, in ITS
 *                      OWN vocabulary?
 *
 * `probe` is a function rather than a regex list because the most valuable
 * signal is often an ABSENCE. `network-requests.ts` (#2887) reads CDP's
 * `base64Encoded` flag and never decodes it — there is no wrong call to grep
 * for, only a missing right one.
 *
 * Every shape is backed by a cluster that actually happened here; `evidence` is
 * the receipt. Do not add a speculative shape — an unproven probe turns the
 * sweep into a grep dump. Pure logic, no I/O.
 */

/** Count how many of `patterns` match `text`. */
function countMatches(text, patterns) {
  let n = 0;
  for (const re of patterns) if (re.test(text)) n += 1;
  return n;
}

/** Does any pattern match? */
function anyMatch(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/* ── binary-encoding-hop ─────────────────────────────────────────────────── */

/** Things that carry raw bytes. */
const BYTE_CARRIERS = [
  /\bUint8Array\b/,
  /\bArrayBuffer\b/,
  /\bBlob\b/,
  /\bbase64Encoded\b/,
  /\barrayBuffer\(\)/,
  /\bUInt8\b/, // Swift
];

/** Things that turn bytes into text (or claim to). */
const TEXT_CODECS = [
  /new TextDecoder\(/,
  /new TextEncoder\(/,
  /String\.fromCharCode/,
  /\batob\(/,
  /\bbtoa\(/,
  /['"]utf-?8['"]/i,
  /String\(data:.*encoding:/, // Swift
];

/** Ways this repo legitimately decodes base64 back to bytes. */
const BASE64_DECODERS = [
  /\batob\(/,
  /Buffer\.from\([^)]*['"]base64['"]/,
  /fromBase64|base64ToBytes|decodeBase64/i,
  /Data\(base64Encoded:/, // Swift
];

/**
 * Files whose JOB is encoding. Replaying #2818 against the tree it shipped
 * into, every real sibling — `har-recorder.ts`, `network-requests.ts`,
 * `mouse.ts`, `stash.ts` — was a file doing something else that happened to
 * touch bytes, while the top of the unweighted ranking was filled with
 * `base64.ts`, `websocat-encoding.ts` and `apns.ts`: dedicated codecs, all
 * correct. The bug lives where byte-handling is INCIDENTAL, not where it is the
 * point, so a dedicated codec is ranked below an incidental toucher.
 */
const DEDICATED_CODEC_PATH = /(base64|encoding|codec|bytes|utf8|multipart|serializ)/i;

/* ── read-modify-write-swallow ───────────────────────────────────────────── */

const EMPTY_DEFAULT_CATCH = [
  /catch\s*(\([^)]*\))?\s*\{[^{}]{0,160}return\s*(''|""|`{2}|\[\]|\{\})/,
  /catch\s*(\([^)]*\))?\s*\{\s*\}/,
  // The arrow form. `.catch(() => '')` is at least as common here as the block
  // form — #2703's `appendLlmsTxtIgnoreHost` was written exactly this way — and
  // a catalog that only knows the block form silently skips half the family.
  /\.catch\(\s*\(\s*\)\s*=>\s*(''|""|`{2}|\[\]|\{\}|undefined|null)\s*\)/,
  /\.catch\(\s*\(\s*\)\s*=>\s*\(\s*(\[\]|\{\})\s*\)\s*\)/,
];

const PERSISTS_BACK = [/writeFile|writeTextFile|\.set\(|persist|save\b/i];

/* ── the catalog ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{
 *   id: string, name: string, rule: string, evidence: string, minHits?: number,
 *   detect: (diff: string) => boolean,
 *   probe: (text: string) => {hits: number, why: string[]},
 * }} Shape
 */

/** @type {ReadonlyArray<Shape>} */
export const SHAPES = [
  {
    id: 'binary-encoding-hop',
    name: 'Bytes routed through a text codec',
    rule: 'Binary data crosses a boundary as a JS string, so every byte ≥ 0x80 is UTF-8-expanded or replaced with U+FFFD and the payload corrupts. The inverse counts too: a byte-ness flag is read and then ignored.',
    evidence: '#2818 → #2878, #2883, #2884, #2885, #2886, #2887 — six siblings inside one day',
    detect: (diff) =>
      /\b(latin1|TextEncoder|TextDecoder|base64Encoded|fromCharCode|byte-exact)\b/.test(diff) &&
      /\b(binary|bytes?|utf-?8|corrupt)\b/i.test(diff),
    probe(text, file = '') {
      const why = [];
      let hits = 0;
      let precise = false;
      const carriers = countMatches(text, BYTE_CARRIERS);
      const codecs = countMatches(text, TEXT_CODECS);
      if (carriers > 0 && codecs > 0) {
        hits += carriers + codecs;
        why.push(`carries bytes (${carriers}) and converts text (${codecs})`);
      }
      // The absence case: CDP hands back a `base64Encoded` flag and this file
      // never decodes base64. There is no wrong call to grep for, only a
      // missing right one — this is what #2887 looks like.
      if (/\bbase64Encoded\b/.test(text) && !anyMatch(text, BASE64_DECODERS)) {
        hits += 3;
        precise = true;
        why.push('reads `base64Encoded` but never decodes base64');
      }
      // Byte-handling that is incidental to the file's job (see
      // DEDICATED_CODEC_PATH) is where the recorded siblings actually lived.
      const incidental = !DEDICATED_CODEC_PATH.test(file) && codecs <= 2;
      if (hits > 0 && incidental) why.push('byte-handling is incidental to this file');
      return { hits, why, precise, incidental };
    },
  },
  {
    id: 'read-modify-write-swallow',
    name: 'Read-modify-write with a swallowed read error',
    rule: 'A read failure is caught and turned into an empty default, then the caller writes the merged result back — so one transient fault silently erases every previously persisted entry.',
    evidence: '#2071 → #2154 → #2400 → #2703 — four copies, surfaced one per week',
    detect: (diff) => /readFile|readTextFile/.test(diff) && anyMatch(diff, EMPTY_DEFAULT_CATCH),
    probe(text) {
      const why = [];
      let hits = 0;
      if (!/readFile|readTextFile/.test(text)) return { hits: 0, why };
      const swallows = countMatches(text, EMPTY_DEFAULT_CATCH);
      if (swallows > 0 && anyMatch(text, PERSISTS_BACK)) {
        hits += swallows + 2;
        why.push('reads, defaults to empty on failure, then writes back');
        // The full read-default-write triad is the bug itself, not a lookalike.
        return { hits, why, precise: true, incidental: true };
      }
      return { hits, why };
    },
  },
  {
    id: 'silent-unknown-flag',
    name: 'Unrecognised argument accepted and ignored',
    rule: 'A command parses the flags it knows and drops the rest while exiting 0, so a typo or an unsupported flag is indistinguishable from success.',
    evidence:
      '#2166 → #2255 (a sweep issue filed by hand) → #2404, #2405, #2816, #2819, #2863, #2864, #2865, #2880',
    detect: (diff) =>
      /\b(unknown|unrecognis|unrecogniz|unsupported)\b.{0,40}\b(flag|option|arg)/i.test(diff),
    probe(text) {
      const why = [];
      let hits = 0;
      const parsesFlags = /startsWith\(['"]--|\bparseArgs\b|\bargv\b/.test(text);
      if (!parsesFlags) return { hits: 0, why };
      const rejects =
        /\b(unknown|unrecognis|unrecogniz|unsupported)\b.{0,40}\b(flag|option|arg)/i.test(text);
      if (!rejects) {
        hits += 3;
        why.push('parses `--flags` with no unknown-flag rejection');
        return { hits, why, precise: true, incidental: true };
      }
      return { hits, why };
    },
  },
  {
    id: 'cross-runtime-predicate',
    minHits: 2,
    name: 'One contract, re-implemented per runtime',
    rule: 'The same decision is coded independently in TypeScript, Swift and Go. One copy is corrected and the others keep the old behaviour, so the bug survives the fix on every other float.',
    evidence: '#1996 → #2821, #2822 (Node vs Swift fetch-proxy); same shape as #2305 and #2633',
    detect: (diff) =>
      /\.swift\b/.test(diff) || /\.go\b/.test(diff)
        ? /\.tsx?\b/.test(diff)
        : /\b(parity|both servers|Swift|mirrors? (the )?(Node|TS))\b/i.test(diff),
    probe(text) {
      const why = [];
      let hits = 0;
      if (/isText[A-Z]|ContentType|hasPrefix\(|\bpredicate\b/.test(text)) {
        hits += 2;
        why.push('carries a hand-rolled classifier that other runtimes also implement');
      }
      return { hits, why };
    },
  },
];

/**
 * Which shapes does this fix belong to?
 * @param {string} diff unified diff of the fix
 * @returns {Shape[]}
 */
export function matchShapes(diff) {
  const text = String(diff ?? '');
  if (!text) return [];
  return SHAPES.filter((s) => {
    try {
      return s.detect(text) === true;
    } catch {
      return false;
    }
  });
}

/**
 * Files that smell of a shape, strongest first.
 * @param {Shape} shape
 * @param {Map<string, string>} sources tracked file → contents
 * @param {Set<string>|string[]} exclude paths the fix already repaired
 * @param {{minHits?: number, max?: number}} [opts]
 * @returns {Array<{file: string, hits: number, why: string[]}>}
 */
export function probeShape(shape, sources, exclude = [], opts = {}) {
  // A shape may declare its own floor. `cross-runtime-predicate`'s probe awards
  // at most 2, so under the default 3 it rendered an empty list on every run —
  // silently disabling the repo's cross-runtime parity check, the very shape
  // that produced #2821 and #2822. `everyShapeCanClearItsOwnFloor` in the tests
  // now makes that class of bug impossible to reintroduce.
  const minHits = shape.minHits ?? opts.minHits ?? 3;
  const max = opts.max ?? 15;
  const skip = exclude instanceof Set ? exclude : new Set(exclude);
  const out = [];
  for (const [file, text] of sources ?? []) {
    if (skip.has(file)) continue;
    const r = shape.probe(text, file) ?? { hits: 0, why: [] };
    if ((r.hits ?? 0) >= minHits) {
      out.push({
        file,
        hits: r.hits,
        why: r.why ?? [],
        precise: r.precise === true,
        incidental: r.incidental === true,
      });
    }
  }
  // Rank by confidence, not by volume: a precise signal (an absence, or a full
  // read-default-write triad) beats bulk vocabulary, and incidental
  // byte-handling beats a dedicated codec whose job that is.
  //
  // `incidental` is compared BEFORE `hits` on purpose. Both orders were
  // measured against #2818's four known siblings and both recover 2 of 4 within
  // the 25-file cap — they simply swap which two (hits-first surfaces
  // `mouse.ts`, incidental-first surfaces `stash.ts`); three weighted blends
  // were also tried and none beat 2/4. Given the tie, this follows the recorded
  // evidence: every real sibling was a file whose job was something else that
  // happened to touch bytes. 2 of 4 is the static-probe ceiling, which is why
  // the brief tells the model to grep for the concept rather than trust this
  // list.
  return out
    .sort(
      (a, b) =>
        Number(b.precise) - Number(a.precise) ||
        Number(b.incidental) - Number(a.incidental) ||
        b.hits - a.hits ||
        a.file.localeCompare(b.file)
    )
    .slice(0, max);
}

/**
 * Render matched shapes for the brief: the rule to test candidates against, the
 * receipt that it has recurred here, and the files that smell of it.
 * @param {Shape[]} shapes
 * @param {Map<string, Array<{file: string, hits: number, why: string[]}>>} hitsByShape
 * @returns {string}
 */
export function renderShapes(shapes, hitsByShape) {
  if (!shapes?.length) return '';
  return shapes
    .map((s) => {
      const hits = hitsByShape?.get(s.id) ?? [];
      const list = hits.length
        ? hits.map((h) => `- \`${h.file}\` — ${h.why.join('; ')}`).join('\n')
        : '- _(nothing else in the tree smells of this shape)_';
      return `### ${s.name} — \`${s.id}\`

**The rule to test each candidate against:** ${s.rule}

**This shape has clustered here before:** ${s.evidence}

Files that smell of it. These are found by the shape's own vocabulary, so the
list overlaps the token table above only by accident — that is the point:

${list}`;
    })
    .join('\n\n');
}
