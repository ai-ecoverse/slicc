function countMatches(text, patterns) {
  let n = 0;
  for (const re of patterns) if (re.test(text)) n += 1;
  return n;
}

function anyMatch(text, patterns) {
  return patterns.some((re) => re.test(text));
}

const BYTE_CARRIERS = [
  /\bUint8Array\b/,
  /\bArrayBuffer\b/,
  /\bBlob\b/,
  /\bbase64Encoded\b/,
  /\barrayBuffer\(\)/,
  /\bUInt8\b/,
];

const TEXT_CODECS = [
  /new TextDecoder\(/,
  /new TextEncoder\(/,
  /String\.fromCharCode/,
  /\batob\(/,
  /\bbtoa\(/,
  /['"]utf-?8['"]/i,
  /String\(data:.*encoding:/,
];

const BASE64_DECODERS = [
  /\batob\(/,
  /Buffer\.from\([^)]*['"]base64['"]/,
  /fromBase64|base64ToBytes|decodeBase64/i,
  /Data\(base64Encoded:/,
];

const DEDICATED_CODEC_PATH = /(base64|encoding|codec|bytes|utf8|multipart|serializ)/i;

const EMPTY_DEFAULT_CATCH = [
  /catch\s*(\([^)]*\))?\s*\{[^{}]{0,160}return\s*(''|""|`{2}|\[\]|\{\})/,
  /catch\s*(\([^)]*\))?\s*\{\s*\}/,

  /\.catch\(\s*\(\s*\)\s*=>\s*(''|""|`{2}|\[\]|\{\}|undefined|null)\s*\)/,
  /\.catch\(\s*\(\s*\)\s*=>\s*\(\s*(\[\]|\{\})\s*\)\s*\)/,
];

const PERSISTS_BACK = [/writeFile|writeTextFile|\.set\(|persist|save\b/i];

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

      if (/\bbase64Encoded\b/.test(text) && !anyMatch(text, BASE64_DECODERS)) {
        hits += 3;
        precise = true;
        why.push('reads `base64Encoded` but never decodes base64');
      }

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

export function probeShape(shape, sources, exclude = [], opts = {}) {
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
