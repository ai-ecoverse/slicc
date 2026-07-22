/**
 * Deterministic credential pattern scanner for transcript redaction.
 *
 * Applies named regex patterns in priority order (highest first). No entropy
 * heuristic — only structured patterns are matched. Existing ⟦REDACTED:⟧
 * markers in the input are excluded from pattern scanning.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CredentialCategory =
  | 'api-key'
  | 'bearer-token'
  | 'jwt'
  | 'private-key'
  | 'password';

export interface PatternRedactionResult {
  text: string;
  matches: Array<{ id: string; category: CredentialCategory }>;
  nextId: number;
}

// ---------------------------------------------------------------------------
// Pattern table (highest → lowest priority)
// ---------------------------------------------------------------------------

/** Each entry is applied in order; earlier entries claim ranges first. */
interface PatternDef {
  readonly category: CredentialCategory;
  readonly source: string;
  readonly flags: string;
}

const PATTERNS: ReadonlyArray<PatternDef> = [
  // JWT: three base64url segments; headers start with `ey` (base64url of `{"`)
  {
    category: 'jwt',
    source: String.raw`ey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
    flags: 'g',
  },
  // PEM private key block
  {
    category: 'private-key',
    source:
      String.raw`-----BEGIN [A-Z ]* PRIVATE KEY-----` +
      String.raw`[\s\S]*?` +
      String.raw`-----END [A-Z ]* PRIVATE KEY-----`,
    flags: 'g',
  },
  // Bearer authorization header value
  {
    category: 'bearer-token',
    source: String.raw`Bearer [A-Za-z0-9._~+/=!-]+`,
    flags: 'g',
  },
  // Common API key prefixes: sk-live/test/prod/proj, xoxb/xoxp (Slack), AKIA (AWS), ghp_, hf_
  {
    category: 'api-key',
    source:
      String.raw`(?:sk-(?:live|test|prod|proj)-[A-Za-z0-9]{8,}` +
      String.raw`|xoxb-[A-Za-z0-9-]{10,}|xoxp-[A-Za-z0-9-]{10,}` +
      String.raw`|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{34})`,
    flags: 'g',
  },
  // password/passwd/token/secret/api_key keyword assignments
  {
    category: 'password',
    source: String.raw`(?:password|passwd|token|secret|api_key)\s*[=:]\s*\S+`,
    flags: 'gi',
  },
];

// Matches existing ⟦REDACTED:...⟧ markers — these ranges are excluded from scanning
const MARKER_SOURCE = String.raw`⟦REDACTED:[^⟧]*⟧`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Range {
  readonly start: number;
  readonly end: number;
}

interface Claim extends Range {
  readonly id: string;
  readonly category: CredentialCategory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function findExcluded(input: string): Range[] {
  const excluded: Range[] = [];
  for (const m of input.matchAll(new RegExp(MARKER_SOURCE, 'g'))) {
    excluded.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return excluded;
}

// ---------------------------------------------------------------------------
// Public scanner
// ---------------------------------------------------------------------------

/**
 * Scan `input` for named credential patterns and replace each match with
 * `⟦REDACTED:<category>:<idPrefix><n>⟧`. Patterns are processed in priority
 * order; overlapping lower-priority matches are skipped. Existing
 * `⟦REDACTED:⟧` ranges are fully excluded from scanning. No entropy
 * heuristic is applied.
 */
export function redactCredentialPatterns(
  input: string,
  idPrefix: string,
  firstId = 1,
): PatternRedactionResult {
  const excluded = findExcluded(input);
  const claims: Claim[] = [];
  let nextId = firstId;

  for (const { category, source, flags } of PATTERNS) {
    for (const m of input.matchAll(new RegExp(source, flags))) {
      const range: Range = { start: m.index!, end: m.index! + m[0].length };
      const blocked =
        excluded.some((e) => overlaps(e, range)) || claims.some((c) => overlaps(c, range));
      if (blocked) continue;
      claims.push({ ...range, id: `${idPrefix}${nextId++}`, category });
    }
  }

  // Replace in source order
  claims.sort((a, b) => a.start - b.start);
  let text = '';
  let pos = 0;
  for (const { start, end, id, category } of claims) {
    text += input.slice(pos, start);
    text += `⟦REDACTED:${category}:${id}⟧`;
    pos = end;
  }
  text += input.slice(pos);

  return {
    text,
    matches: claims.map(({ id, category }) => ({ id, category })),
    nextId,
  };
}
