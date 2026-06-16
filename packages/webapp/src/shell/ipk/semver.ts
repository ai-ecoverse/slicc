/**
 * Minimal npm-faithful semver implementation.
 * Pure, dependency-free, no DOM/shell coupling.
 *
 * Supports: exact, ^, ~, x/*, comparators (>=, >, <=, <),
 * hyphen ranges, and || unions.
 *
 * Pre-release versions are matched only when the range
 * explicitly references a pre-release.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  raw: string;
}

const SEMVER_RE =
  /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseIdentifier(id: string): string | number {
  const num = Number(id);
  if (!Number.isNaN(num) && String(num) === id && num >= 0) {
    return num;
  }
  return id;
}

export function parse(version: string): SemVer {
  const m = SEMVER_RE.exec(version);
  if (!m) {
    throw new Error(`Invalid version: "${version}"`);
  }

  const major = Number(m[1]);
  const minor = m[2] !== undefined ? Number(m[2]) : NaN;
  const patch = m[3] !== undefined ? Number(m[3]) : NaN;
  const prerelease = m[4] ? m[4].split('.') : [];
  const build = m[5] ? m[5].split('.') : [];

  return { major, minor, patch, prerelease, build, raw: version };
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = parseIdentifier(a[i] ?? '');
    const bi = parseIdentifier(b[i] ?? '');
    const cmp = compareIdentifiers(ai, bi);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function compare(aRaw: string | SemVer, bRaw: string | SemVer): number {
  const a = typeof aRaw === 'string' ? parse(aRaw) : aRaw;
  const b = typeof bRaw === 'string' ? parse(bRaw) : bRaw;

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function eq(a: string | SemVer, b: string | SemVer): boolean {
  return compare(a, b) === 0;
}
function gt(a: string | SemVer, b: string | SemVer): boolean {
  return compare(a, b) > 0;
}
function gte(a: string | SemVer, b: string | SemVer): boolean {
  return compare(a, b) >= 0;
}
function lt(a: string | SemVer, b: string | SemVer): boolean {
  return compare(a, b) < 0;
}
function lte(a: string | SemVer, b: string | SemVer): boolean {
  return compare(a, b) <= 0;
}

/* ---------- range parsing ---------- */

interface Comparator {
  op: '>' | '>=' | '<' | '<=' | '' | '~' | '^';
  version: SemVer;
}

interface ComparatorSet {
  comparators: Comparator[];
}

type Range = ComparatorSet[]; // OR'd sets

function isWildcard(part: string | undefined): boolean {
  return part === 'x' || part === 'X' || part === '*' || part === '' || part === undefined;
}

function wildcardMajor(version: SemVer): boolean {
  return Number.isNaN(version.major);
}
function wildcardMinor(version: SemVer): boolean {
  return Number.isNaN(version.minor);
}
function wildcardPatch(version: SemVer): boolean {
  return Number.isNaN(version.patch);
}

function parseComparator(cmpStr: string): Comparator {
  const trimmed = cmpStr.trim();
  let op: Comparator['op'] = '';
  let rest = trimmed;

  if (rest.startsWith('>=')) {
    op = '>=';
    rest = rest.slice(2);
  } else if (rest.startsWith('<=')) {
    op = '<=';
    rest = rest.slice(2);
  } else if (rest.startsWith('>')) {
    op = '>';
    rest = rest.slice(1);
  } else if (rest.startsWith('<')) {
    op = '<';
    rest = rest.slice(1);
  } else if (rest.startsWith('=')) {
    op = '';
    rest = rest.slice(1);
  }

  rest = rest.trim();

  // Tilde
  if (rest.startsWith('~')) {
    return parseTilde(rest);
  }

  // Caret
  if (rest.startsWith('^')) {
    return parseCaret(rest);
  }

  // Wildcards / partial versions
  const parts = rest.split('.');

  // Explicit wildcard in major position: *, x, X
  if (parts.length > 0 && isWildcard(parts[0])) {
    return {
      op: '',
      version: { major: NaN, minor: NaN, patch: NaN, prerelease: [], build: [], raw: rest },
    };
  }

  const major = Number(parts[0]);
  if (Number.isNaN(major)) {
    throw new Error(`Invalid comparator: "${trimmed}"`);
  }

  if (parts.length === 1) {
    // "1" means exact 1.0.0 in range context
    return { op, version: { major, minor: 0, patch: 0, prerelease: [], build: [], raw: rest } };
  }

  // Explicit wildcard in minor position: 1.x, 1.*
  if (isWildcard(parts[1])) {
    return { op, version: { major, minor: NaN, patch: NaN, prerelease: [], build: [], raw: rest } };
  }

  const minor = Number(parts[1]);
  if (Number.isNaN(minor)) {
    throw new Error(`Invalid comparator: "${trimmed}"`);
  }

  if (parts.length === 2) {
    // "1.2" means exact 1.2.0 in range context
    return { op, version: { major, minor, patch: 0, prerelease: [], build: [], raw: rest } };
  }

  // Explicit wildcard in patch position: 1.2.x, 1.2.*
  if (isWildcard(parts[2])) {
    return { op, version: { major, minor, patch: NaN, prerelease: [], build: [], raw: rest } };
  }

  // Exact version with all three parts
  const version = parse(rest);
  return { op, version };
}

function parseTilde(str: string): Comparator {
  const rest = str.slice(1).trim();
  const parts = rest.split('.');
  const major = Number(parts[0]);
  const minor = parts[1] !== undefined && !isWildcard(parts[1]) ? Number(parts[1]) : NaN;
  const patchPart = parts[2] !== undefined && !isWildcard(parts[2]) ? parts[2] : undefined;
  const patch = patchPart !== undefined ? Number(patchPart) : NaN;
  const prerelease = patchPart?.includes('-')
    ? patchPart.slice(patchPart.indexOf('-') + 1).split('.')
    : [];

  return {
    op: '~',
    version: { major, minor, patch, prerelease, build: [], raw: rest },
  };
}

function parseCaret(str: string): Comparator {
  const rest = str.slice(1).trim();
  const version = parse(rest);
  return { op: '^', version };
}

function parseRange(rangeStr: string): Range {
  // Handle hyphen ranges first: "1.0.0 - 2.0.0"
  const hyphenMatch = rangeStr.match(
    /^\s*([vV]?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z-.]+)?)\s+-\s+([vV]?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z-.]+)?)\s*$/
  );
  if (hyphenMatch) {
    const left = parseComparator(`>=${hyphenMatch[1]}`);
    const right = parseComparator(`<=${hyphenMatch[2]}`);
    return [{ comparators: [left, right] }];
  }

  // Split by ||
  const orParts = rangeStr.split('||');
  return orParts.map((part) => {
    const comps = part.trim().split(/\s+/).filter(Boolean).map(parseComparator);
    return { comparators: comps };
  });
}

function expandTilde(cmp: Comparator): Comparator[] {
  const v = cmp.version;
  if (Number.isNaN(v.minor)) {
    // ~1  -> >=1.0.0 <2.0.0
    return [
      {
        op: '>=',
        version: {
          major: v.major,
          minor: 0,
          patch: 0,
          prerelease: v.prerelease,
          build: [],
          raw: '',
        },
      },
      {
        op: '<',
        version: { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: '' },
      },
    ];
  }

  if (Number.isNaN(v.patch)) {
    // ~1.2 -> >=1.2.0 <1.3.0
    return [
      {
        op: '>=',
        version: {
          major: v.major,
          minor: v.minor,
          patch: 0,
          prerelease: v.prerelease,
          build: [],
          raw: '',
        },
      },
      {
        op: '<',
        version: {
          major: v.major,
          minor: v.minor + 1,
          patch: 0,
          prerelease: [],
          build: [],
          raw: '',
        },
      },
    ];
  }

  if (v.major === 0 && v.minor === 0) {
    // ~0.0.3 -> >=0.0.3 <0.1.0
    return [
      { op: '>=', version: v },
      {
        op: '<',
        version: { major: 0, minor: 1, patch: 0, prerelease: [], build: [], raw: '' },
      },
    ];
  }

  // ~1.2.3 -> >=1.2.3 <(minor+1).0.0
  return [
    { op: '>=', version: v },
    {
      op: '<',
      version: { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [], build: [], raw: '' },
    },
  ];
}

function expandCaret(cmp: Comparator): Comparator[] {
  const v = cmp.version;
  if (v.major === 0) {
    if (v.minor === 0) {
      // ^0.0.3 -> >=0.0.3 <0.0.4
      return [
        { op: '>=', version: v },
        {
          op: '<',
          version: { major: 0, minor: 0, patch: v.patch + 1, prerelease: [], build: [], raw: '' },
        },
      ];
    }
    // ^0.2.3 -> >=0.2.3 <0.3.0
    return [
      { op: '>=', version: v },
      {
        op: '<',
        version: { major: 0, minor: v.minor + 1, patch: 0, prerelease: [], build: [], raw: '' },
      },
    ];
  }
  // ^1.2.3 -> >=1.2.3 <2.0.0
  return [
    { op: '>=', version: v },
    {
      op: '<',
      version: { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: '' },
    },
  ];
}

function expandExact(cmp: Comparator): Comparator[] {
  const v = cmp.version;
  // Handle wildcards in exact-ish comparators
  if (wildcardMajor(v)) {
    // * or x -> matches anything
    return [{ op: '', version: v }];
  }
  if (wildcardMinor(v)) {
    // 1.x -> >=1.0.0 <2.0.0
    return [
      {
        op: '>=',
        version: { major: v.major, minor: 0, patch: 0, prerelease: [], build: [], raw: '' },
      },
      {
        op: '<',
        version: { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: '' },
      },
    ];
  }
  if (wildcardPatch(v)) {
    // 1.2.x -> >=1.2.0 <1.3.0
    return [
      {
        op: '>=',
        version: { major: v.major, minor: v.minor, patch: 0, prerelease: [], build: [], raw: '' },
      },
      {
        op: '<',
        version: {
          major: v.major,
          minor: v.minor + 1,
          patch: 0,
          prerelease: [],
          build: [],
          raw: '',
        },
      },
    ];
  }
  // Exact version: 1.2.3
  return [{ op: '', version: v }];
}

function checkComparator(version: SemVer, cmp: Comparator): boolean {
  switch (cmp.op) {
    case '>':
      return gt(version, cmp.version);
    case '>=':
      return gte(version, cmp.version);
    case '<':
      return lt(version, cmp.version);
    case '<=':
      return lte(version, cmp.version);
    case '': {
      if (wildcardMajor(cmp.version)) {
        return true; // * matches anything
      }
      return eq(version, cmp.version);
    }
    default:
      return false;
  }
}

function setHasPrerelease(set: ComparatorSet): boolean {
  return set.comparators.some((c) => c.version.prerelease.length > 0);
}

function checkSet(version: SemVer, set: ComparatorSet): boolean {
  // Pre-release rule: if version has prerelease, at least one comparator in the set
  // must explicitly reference a prerelease for the version to be considered.
  // Exception: the wildcard * matches anything, including prereleases.
  const hasWildcard = set.comparators.some((c) => c.op === '' && wildcardMajor(c.version));
  if (version.prerelease.length > 0 && !setHasPrerelease(set) && !hasWildcard) {
    return false;
  }

  return set.comparators.every((cmp) => checkComparator(version, cmp));
}

export function satisfies(versionStr: string, rangeStr: string): boolean {
  const version = parse(versionStr);
  const range = parseRange(rangeStr);

  for (const set of range) {
    // Expand tilde/caret/wildcard inside each set
    const expanded: ComparatorSet = { comparators: [] };
    for (const cmp of set.comparators) {
      if (cmp.op === '~') {
        expanded.comparators.push(...expandTilde(cmp));
      } else if (cmp.op === '^') {
        expanded.comparators.push(...expandCaret(cmp));
      } else if (cmp.op === '') {
        expanded.comparators.push(...expandExact(cmp));
      } else {
        expanded.comparators.push(cmp);
      }
    }
    if (checkSet(version, expanded)) {
      return true;
    }
  }

  return false;
}

export function maxSatisfying(versions: string[], rangeStr: string): string | null {
  const valid: { ver: SemVer; raw: string }[] = [];

  for (const vStr of versions) {
    try {
      if (satisfies(vStr, rangeStr)) {
        valid.push({ ver: parse(vStr), raw: vStr });
      }
    } catch {
      // ignore invalid versions in the list
    }
  }

  if (valid.length === 0) return null;

  valid.sort((a, b) => -compare(a.ver, b.ver)); // descending
  return valid[0].raw;
}
