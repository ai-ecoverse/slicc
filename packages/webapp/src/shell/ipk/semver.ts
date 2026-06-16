/**
 * Minimal npm-faithful semver implementation.
 * Pure, dependency-free, no DOM/shell coupling.
 *
 * Supports: exact, ^, ~, x/*, comparators (>=, >, <=, <),
 * hyphen ranges, and || unions.
 *
 * Pre-release versions follow node-semver's same-version-tuple admission rule:
 * a prerelease candidate is in-range only when some comparator in the set has the
 * same [major, minor, patch] tuple AND carries a prerelease tag.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
  raw: string;
}

const STRICT_SEMVER_RE =
  /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const PARTIAL_SEMVER_RE =
  /^[vV]?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseIdentifier(id: string): string | number {
  const num = Number(id);
  if (!Number.isNaN(num) && String(num) === id && num >= 0) {
    return num;
  }
  return id;
}

function isWildcardToken(part: string | undefined): boolean {
  return part === 'x' || part === 'X' || part === '*';
}

export function parse(version: string): SemVer {
  const m = STRICT_SEMVER_RE.exec(version);
  if (!m) {
    throw new Error(`Invalid version: "${version}"`);
  }

  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
    raw: version,
  };
}

function parsePartial(version: string): SemVer {
  const m = PARTIAL_SEMVER_RE.exec(version);
  if (!m) {
    throw new Error(`Invalid version: "${version}"`);
  }
  const major = Number(m[1]);
  const minor = m[2] === undefined || isWildcardToken(m[2]) ? NaN : Number(m[2]);
  const patch = m[3] === undefined || isWildcardToken(m[3]) ? NaN : Number(m[3]);
  return {
    major,
    minor,
    patch,
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
    raw: version,
  };
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

  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    const ai = parseIdentifier(a[i]);
    const bi = parseIdentifier(b[i]);
    const cmp = compareIdentifiers(ai, bi);
    if (cmp !== 0) return cmp;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export function compare(aRaw: string | SemVer, bRaw: string | SemVer): number {
  const a = typeof aRaw === 'string' ? parse(aRaw) : aRaw;
  const b = typeof bRaw === 'string' ? parse(bRaw) : bRaw;

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function eq(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === 0;
}
function gt(a: SemVer, b: SemVer): boolean {
  return compare(a, b) > 0;
}
function gte(a: SemVer, b: SemVer): boolean {
  return compare(a, b) >= 0;
}
function lt(a: SemVer, b: SemVer): boolean {
  return compare(a, b) < 0;
}
function lte(a: SemVer, b: SemVer): boolean {
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

type Range = ComparatorSet[];

function wildcardMajor(version: SemVer): boolean {
  return Number.isNaN(version.major);
}
function wildcardMinor(version: SemVer): boolean {
  return Number.isNaN(version.minor);
}
function wildcardPatch(version: SemVer): boolean {
  return Number.isNaN(version.patch);
}

function emptyVersion(): SemVer {
  return { major: NaN, minor: NaN, patch: NaN, prerelease: [], build: [], raw: '' };
}

function makeVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: string[] = []
): SemVer {
  return { major, minor, patch, prerelease, build: [], raw: '' };
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

  if (rest.startsWith('~')) {
    return parseTilde(rest);
  }

  if (rest.startsWith('^')) {
    return parseCaret(rest);
  }

  if (rest === '' || rest === '*' || rest === 'x' || rest === 'X') {
    return { op: '', version: emptyVersion() };
  }

  const v = parsePartial(rest);
  return { op, version: v };
}

function parseTilde(str: string): Comparator {
  const rest = str.slice(1).trim();
  const v = parsePartial(rest);
  return { op: '~', version: v };
}

function parseCaret(str: string): Comparator {
  const rest = str.slice(1).trim();
  const v = parsePartial(rest);
  return { op: '^', version: v };
}

function parseRange(rangeStr: string): Range {
  const hyphenMatch = rangeStr.match(
    /^\s*([vV]?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z-.]+)?)\s+-\s+([vV]?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z-.]+)?)\s*$/
  );
  if (hyphenMatch) {
    const left = parseComparator(`>=${hyphenMatch[1]}`);
    const right = parseComparator(`<=${hyphenMatch[2]}`);
    return [{ comparators: [left, right] }];
  }

  const orParts = rangeStr.split('||');
  return orParts.map((part) => {
    const comps = part.trim().split(/\s+/).filter(Boolean).map(parseComparator);
    return { comparators: comps };
  });
}

function expandTilde(cmp: Comparator): Comparator[] {
  const v = cmp.version;
  if (wildcardMajor(v)) {
    return [{ op: '', version: emptyVersion() }];
  }
  if (wildcardMinor(v)) {
    return [
      { op: '>=', version: makeVersion(v.major, 0, 0) },
      { op: '<', version: makeVersion(v.major + 1, 0, 0) },
    ];
  }
  if (wildcardPatch(v)) {
    return [
      { op: '>=', version: makeVersion(v.major, v.minor, 0) },
      { op: '<', version: makeVersion(v.major, v.minor + 1, 0) },
    ];
  }
  return [
    { op: '>=', version: makeVersion(v.major, v.minor, v.patch, v.prerelease) },
    { op: '<', version: makeVersion(v.major, v.minor + 1, 0) },
  ];
}

function expandCaret(cmp: Comparator): Comparator[] {
  const v = cmp.version;
  if (wildcardMajor(v)) {
    return [{ op: '', version: emptyVersion() }];
  }
  if (wildcardMinor(v)) {
    return [
      { op: '>=', version: makeVersion(v.major, 0, 0) },
      { op: '<', version: makeVersion(v.major + 1, 0, 0) },
    ];
  }
  if (wildcardPatch(v)) {
    if (v.major === 0) {
      return [
        { op: '>=', version: makeVersion(0, v.minor, 0) },
        { op: '<', version: makeVersion(0, v.minor + 1, 0) },
      ];
    }
    return [
      { op: '>=', version: makeVersion(v.major, v.minor, 0) },
      { op: '<', version: makeVersion(v.major + 1, 0, 0) },
    ];
  }
  if (v.major === 0) {
    if (v.minor === 0) {
      return [
        { op: '>=', version: makeVersion(v.major, v.minor, v.patch, v.prerelease) },
        { op: '<', version: makeVersion(0, 0, v.patch + 1) },
      ];
    }
    return [
      { op: '>=', version: makeVersion(v.major, v.minor, v.patch, v.prerelease) },
      { op: '<', version: makeVersion(0, v.minor + 1, 0) },
    ];
  }
  return [
    { op: '>=', version: makeVersion(v.major, v.minor, v.patch, v.prerelease) },
    { op: '<', version: makeVersion(v.major + 1, 0, 0) },
  ];
}

function expandWildcardOperator(cmp: Comparator): Comparator[] | null {
  const v = cmp.version;
  const wm = wildcardMajor(v);
  const wmi = wildcardMinor(v);
  const wp = wildcardPatch(v);
  if (!wm && !wmi && !wp) return null;

  if (cmp.op === '' || cmp.op === '~' || cmp.op === '^') return null;

  if (wm) {
    if (cmp.op === '>=' || cmp.op === '<=') {
      return [{ op: '', version: emptyVersion() }];
    }
    return [{ op: '<', version: makeVersion(0, 0, 0) }];
  }

  if (wmi) {
    switch (cmp.op) {
      case '>=':
        return [{ op: '>=', version: makeVersion(v.major, 0, 0) }];
      case '>':
        return [{ op: '>=', version: makeVersion(v.major + 1, 0, 0) }];
      case '<=':
        return [{ op: '<', version: makeVersion(v.major + 1, 0, 0) }];
      case '<':
        return [{ op: '<', version: makeVersion(v.major, 0, 0) }];
    }
  }

  switch (cmp.op) {
    case '>=':
      return [{ op: '>=', version: makeVersion(v.major, v.minor, 0) }];
    case '>':
      return [{ op: '>=', version: makeVersion(v.major, v.minor + 1, 0) }];
    case '<=':
      return [{ op: '<', version: makeVersion(v.major, v.minor + 1, 0) }];
    case '<':
      return [{ op: '<', version: makeVersion(v.major, v.minor, 0) }];
  }
  return null;
}

function expandExact(cmp: Comparator): Comparator[] {
  const v = cmp.version;
  if (wildcardMajor(v)) {
    return [{ op: '', version: emptyVersion() }];
  }
  if (wildcardMinor(v)) {
    return [
      { op: '>=', version: makeVersion(v.major, 0, 0) },
      { op: '<', version: makeVersion(v.major + 1, 0, 0) },
    ];
  }
  if (wildcardPatch(v)) {
    return [
      { op: '>=', version: makeVersion(v.major, v.minor, 0) },
      { op: '<', version: makeVersion(v.major, v.minor + 1, 0) },
    ];
  }
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
        return true;
      }
      return eq(version, cmp.version);
    }
    default:
      return false;
  }
}

function sameTuple(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function setAdmitsPrerelease(version: SemVer, set: ComparatorSet): boolean {
  for (const cmp of set.comparators) {
    if (cmp.op === '' && wildcardMajor(cmp.version)) return true;
    if (cmp.version.prerelease.length > 0 && sameTuple(version, cmp.version)) {
      return true;
    }
  }
  return false;
}

function checkSet(version: SemVer, set: ComparatorSet): boolean {
  if (version.prerelease.length > 0 && !setAdmitsPrerelease(version, set)) {
    return false;
  }
  return set.comparators.every((cmp) => checkComparator(version, cmp));
}

function expandComparator(cmp: Comparator): Comparator[] {
  if (cmp.op === '~') return expandTilde(cmp);
  if (cmp.op === '^') return expandCaret(cmp);
  if (cmp.op === '') return expandExact(cmp);
  const wildcardExpansion = expandWildcardOperator(cmp);
  if (wildcardExpansion) return wildcardExpansion;
  return [cmp];
}

export function satisfies(versionStr: string, rangeStr: string): boolean {
  const version = parse(versionStr);
  const range = parseRange(rangeStr);

  for (const set of range) {
    const expanded: ComparatorSet = { comparators: [] };
    for (const cmp of set.comparators) {
      expanded.comparators.push(...expandComparator(cmp));
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

  valid.sort((a, b) => -compare(a.ver, b.ver));
  return valid[0].raw;
}
