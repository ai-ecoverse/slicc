export type CredentialCategory = 'api-key' | 'bearer-token' | 'jwt' | 'private-key' | 'password';

export interface PatternRedactionResult {
  text: string;
  matches: Array<{ id: string; category: CredentialCategory }>;
  nextId: number;
}

interface PatternDef {
  readonly category: CredentialCategory;
  readonly source: string;
  readonly flags: string;
}

const PATTERNS: ReadonlyArray<PatternDef> = [
  {
    category: 'jwt',
    source: String.raw`ey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
    flags: 'g',
  },

  {
    category: 'private-key',
    source:
      '-----BEGIN [A-Z ]* PRIVATE KEY-----' +
      String.raw`[\s\S]*?` +
      '-----END [A-Z ]* PRIVATE KEY-----',
    flags: 'g',
  },

  {
    category: 'bearer-token',
    source: 'Bearer [A-Za-z0-9._~+/=!-]+',
    flags: 'gi',
  },

  {
    category: 'api-key',
    source:
      '(?:sk-(?:live|test|prod|proj)-[A-Za-z0-9]{8,}' +
      '|sk-ant-[A-Za-z0-9-]{8,}' +
      '|xoxb-[A-Za-z0-9-]{10,}|xoxp-[A-Za-z0-9-]{10,}' +
      '|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{34})',
    flags: 'g',
  },

  {
    category: 'password',
    source: String.raw`\b(?:password|passwd|token|secret|api_key)\s*[=:]\s*\S+`,
    flags: 'gi',
  },
];

const MARKER_SOURCE = '⟦REDACTED:[^⟧]*⟧';

interface Range {
  readonly start: number;
  readonly end: number;
}

interface Claim extends Range {
  readonly id: string;
  readonly category: CredentialCategory;
}

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function findExcluded(input: string): Range[] {
  const excluded: Range[] = [];
  for (const match of input.matchAll(new RegExp(MARKER_SOURCE, 'g'))) {
    const start = match.index;
    if (start === undefined) continue;
    excluded.push({ start, end: start + match[0].length });
  }
  return excluded;
}

export interface PatternRedactionOptions {
  categories?: readonly CredentialCategory[];
}

export function redactCredentialPatterns(
  input: string,
  idPrefix: string,
  firstId = 1,
  options?: PatternRedactionOptions
): PatternRedactionResult {
  const excluded = findExcluded(input);
  const claims: Claim[] = [];
  let nextId = firstId;

  const patterns = options?.categories
    ? PATTERNS.filter((p) => options.categories?.includes(p.category))
    : PATTERNS;
  for (const { category, source, flags } of patterns) {
    for (const match of input.matchAll(new RegExp(source, flags))) {
      const start = match.index;
      if (start === undefined) continue;
      const range: Range = { start, end: start + match[0].length };
      const blocked =
        excluded.some((e) => overlaps(e, range)) || claims.some((c) => overlaps(c, range));
      if (blocked) continue;
      claims.push({ ...range, id: `${idPrefix}${nextId++}`, category });
    }
  }

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
