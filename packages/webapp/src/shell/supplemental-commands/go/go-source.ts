/**
 * `go-source.ts` — what SLICC's `go` driver reads from Go sources, as
 * `go/build` does (#3530 phase 5e): a module's `go.mod`, a file's header
 * (its `//go:build` line, package clause and imports), and which files of a
 * directory a target builds (file-name suffixes, build constraints, tests).
 *
 * Only the header is parsed: the compiler reads the rest. What the driver
 * does not build — cgo, `//go:embed`, assembly — is reported, not guessed at.
 */

/** go/build's syslist: the GOOS and GOARCH values a file-name suffix can name. */
export const KNOWN_OS: ReadonlySet<string> = new Set([
  'aix',
  'android',
  'darwin',
  'dragonfly',
  'freebsd',
  'hurd',
  'illumos',
  'ios',
  'js',
  'linux',
  'nacl',
  'netbsd',
  'openbsd',
  'plan9',
  'solaris',
  'wasip1',
  'windows',
  'zos',
]);

export const KNOWN_ARCH: ReadonlySet<string> = new Set([
  '386',
  'amd64',
  'amd64p32',
  'arm',
  'armbe',
  'arm64',
  'arm64be',
  'loong64',
  'mips',
  'mipsle',
  'mips64',
  'mips64le',
  'mips64p32',
  'mips64p32le',
  'ppc',
  'ppc64',
  'ppc64le',
  'riscv',
  'riscv64',
  's390',
  's390x',
  'sparc',
  'sparc64',
  'wasm',
]);

/** The GOOS values the `unix` tag stands for (wasip1 and js are not among them). */
const UNIX_OS: ReadonlySet<string> = new Set([
  'aix',
  'android',
  'darwin',
  'dragonfly',
  'freebsd',
  'hurd',
  'illumos',
  'ios',
  'linux',
  'netbsd',
  'openbsd',
  'solaris',
]);

/** A GOOS that builds another's files too: android is linux, illumos solaris, ios darwin. */
const ALSO_OS: Readonly<Record<string, string>> = {
  android: 'linux',
  illumos: 'solaris',
  ios: 'darwin',
};

/** What a build is for: the tags a file's constraints are checked against. */
export interface BuildTarget {
  goos: string;
  goarch: string;
  /** The toolchain's release: `go1.26.5` satisfies go1.1 … go1.26. */
  version: string;
  /** `-tags`. */
  tags?: readonly string[];
}

/** Whether `tag` holds for `target` (go/build's matchTag; cgo is off, the compiler is gc). */
export function matchTag(tag: string, target: BuildTarget): boolean {
  const { goos, goarch } = target;
  if (tag === goos || tag === goarch || tag === 'gc') return true;
  if (ALSO_OS[goos] === tag) return true;
  if (tag === 'unix') return UNIX_OS.has(goos);
  if (target.tags?.includes(tag)) return true;
  const release = /^go1\.(\d+)$/.exec(tag);
  if (release) return Number(release[1]) <= minorOf(target.version);
  return false;
}

/** The minor release of `go1.26.5` (26); 0 for anything else. */
export function minorOf(version: string): number {
  const m = /^go1\.(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

/**
 * Whether a file named `name` builds for `target`, by its name alone: `_test`
 * files never do, `_GOOS`, `_GOARCH` and `_GOOS_GOARCH` suffixes must match
 * (go/build's goodOSArchFile), and `_` / `.` files are ignored.
 */
export function goodFileName(name: string, target: BuildTarget): boolean {
  if (!name.endsWith('.go') || name.startsWith('_') || name.startsWith('.')) return false;
  const stem = name.slice(0, -3);
  if (stem.endsWith('_test')) return false;
  const under = stem.indexOf('_');
  if (under < 0) return true;
  const parts = stem.slice(under).split('_');
  const n = parts.length;
  const os = (tag: string) => tag === target.goos || ALSO_OS[target.goos] === tag;
  if (n >= 2 && KNOWN_OS.has(parts[n - 2] as string) && KNOWN_ARCH.has(parts[n - 1] as string)) {
    return os(parts[n - 2] as string) && parts[n - 1] === target.goarch;
  }
  const last = parts[n - 1] as string;
  if (KNOWN_OS.has(last)) return os(last);
  if (KNOWN_ARCH.has(last)) return last === target.goarch;
  return true;
}

// ---------------------------------------------------------------- //go:build

type Expr = { tag: string } | { not: Expr } | { and: [Expr, Expr] } | { or: [Expr, Expr] };

/** A `//go:build` expression (go/build/constraint's grammar: `!`, `&&`, `||`, parentheses). */
export function parseConstraint(text: string): Expr {
  const tokens = text.match(/&&|\|\||[()!]|[^\s()!&|]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const fail = (): never => {
    throw new Error(`malformed //go:build line: ${text}`);
  };
  const or = (): Expr => {
    let left = and();
    while (peek() === '||') {
      at++;
      left = { or: [left, and()] };
    }
    return left;
  };
  const and = (): Expr => {
    let left = not();
    while (peek() === '&&') {
      at++;
      left = { and: [left, not()] };
    }
    return left;
  };
  const not = (): Expr => {
    if (peek() === '!') {
      at++;
      return { not: not() };
    }
    if (peek() === '(') {
      at++;
      const inner = or();
      if (tokens[at++] !== ')') fail();
      return inner;
    }
    const tag = tokens[at++];
    if (!tag || !/^[\w.]+$/.test(tag)) fail();
    return { tag: tag as string };
  };
  const expr = or();
  if (at !== tokens.length) fail();
  return expr;
}

export function evalConstraint(expr: Expr, target: BuildTarget): boolean {
  if ('tag' in expr) return matchTag(expr.tag, target);
  if ('not' in expr) return !evalConstraint(expr.not, target);
  if ('and' in expr)
    return evalConstraint(expr.and[0], target) && evalConstraint(expr.and[1], target);
  return evalConstraint(expr.or[0], target) || evalConstraint(expr.or[1], target);
}

// ---------------------------------------------------------------- headers

/** An import in a file's header, where it is (for messages like go's `main.go:4:2:`). */
export interface GoImport {
  path: string;
  line: number;
  column: number;
}

/** What the driver needs of one `.go` file. */
export interface GoFileHeader {
  /** The `//go:build` expression, if any. */
  constraint?: string;
  pkg: string;
  imports: GoImport[];
  /** A `//go:embed` directive (not supported yet), where it is. */
  embed?: { line: number };
}

/** Go's source position of `offset` in `text`: 1-based line, byte column. */
function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: offset - start + 1 };
}

/** The `//go:build` line in the leading comments, before any code (go/build's parseFileHeader). */
function buildLine(text: string): string | undefined {
  let found: string | undefined;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end < 0) {
          line = '';
          break;
        }
        inBlock = false;
        line = line.slice(end + 2).trim();
        continue;
      }
      if (line.startsWith('//')) {
        if (/^\/\/go:build(\s|$)/.test(line)) {
          if (found !== undefined) throw new Error('multiple //go:build comments');
          found = line.slice('//go:build'.length).trim();
        }
        line = '';
        break;
      }
      if (line.startsWith('/*')) {
        inBlock = true;
        line = line.slice(2);
        continue;
      }
      return found; // code: the header is over
    }
  }
  return found;
}

/** Past whitespace and comments from `i`. */
function skipSpace(text: string, i: number): number {
  for (;;) {
    if (i < text.length && /\s/.test(text[i] as string)) i++;
    else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return i;
  }
}

/** The string literal opening at `i` (interpreted or raw): its value and where it ends. */
function stringAt(text: string, i: number): { value: string; end: number } {
  const quote = text[i];
  let j = i + 1;
  let value = '';
  while (j < text.length && text[j] !== quote) {
    if (quote === '"' && text[j] === '\\') {
      value += text[j + 1] ?? '';
      j += 2;
    } else value += text[j++];
  }
  return { value, end: j + 1 };
}

/** A tokenizer for a file's header: identifiers, string literals, punctuation; comments skipped. */
function* tokens(
  text: string
): Generator<{ kind: 'ident' | 'string' | 'punct'; value: string; at: number }> {
  for (let i = skipSpace(text, 0); i < text.length; i = skipSpace(text, i)) {
    const at = i;
    const c = text[i] as string;
    if (c === '"' || c === '`') {
      const s = stringAt(text, i);
      i = s.end;
      yield { kind: 'string', value: s.value, at };
    } else if (/[\p{L}_]/u.test(c)) {
      while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i] as string)) i++;
      yield { kind: 'ident', value: text.slice(at, i), at };
    } else {
      i++;
      yield { kind: 'punct', value: c, at };
    }
  }
}

type Token = ReturnType<ReturnType<typeof tokens>['next']>['value'];

/** The import declarations after the package clause, up to the first other token. */
function importDecls(text: string, next: () => Token): GoImport[] {
  const imports: GoImport[] = [];
  const spec = (tok: Token): Token => {
    // An import name (`alias`, `.`, `_`) before the path.
    const path = tok && tok.kind !== 'string' ? next() : tok;
    if (path?.kind !== 'string') throw new Error('expected import path');
    imports.push({ path: path.value, ...position(text, path.at) });
    return next();
  };
  const group = (): Token => {
    let t = next();
    while (t && t.value !== ')') t = t.value === ';' ? next() : spec(t);
    return next();
  };
  let t = next();
  while (t && (t.value === ';' || t.value === 'import')) {
    if (t.value === ';') {
      t = next();
      continue;
    }
    t = next();
    t = t?.value === '(' ? group() : spec(t);
  }
  return imports;
}

/** A file's header: its constraint, package name and imports (the rest is the compiler's). */
export function parseHeader(text: string): GoFileHeader {
  const constraint = buildLine(text);
  const it = tokens(text);
  const next = (): Token => it.next().value;
  if (next()?.value !== 'package') throw new Error('expected package clause');
  const name = next();
  if (name?.kind !== 'ident') throw new Error('expected package name');
  const imports = importDecls(text, next);
  const embed = /^[ \t]*\/\/go:embed\s/m.exec(text);
  return {
    ...(constraint !== undefined ? { constraint } : {}),
    pkg: name.value,
    imports,
    ...(embed ? { embed: { line: position(text, embed.index).line } } : {}),
  };
}

// ---------------------------------------------------------------- go.mod

/** A module's `go.mod`: its path and the language version (`go` directive) it is written in. */
export interface GoMod {
  module: string;
  /** `1.22` from `go 1.22` or `go 1.22.3`; absent when the file has none. */
  goVersion?: string;
  /** `require`d modules: not supported yet (only std and the main module build). */
  requires: string[];
}

export function parseGoMod(text: string): GoMod {
  const lines = text.replace(/\/\/.*$/gm, '').split('\n');
  let module: string | undefined;
  let goVersion: string | undefined;
  const requires: string[] = [];
  let block: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (block) {
      if (line === ')') block = undefined;
      else if (block === 'require') requires.push(line.split(/\s+/)[0] as string);
      continue;
    }
    const [verb, ...rest] = line.split(/\s+/);
    if (rest[0] === '(') {
      block = verb;
      continue;
    }
    if (verb === 'module') module = unquote(rest[0] ?? '');
    else if (verb === 'go') goVersion = /^(\d+\.\d+)/.exec(rest[0] ?? '')?.[1];
    else if (verb === 'require' && rest[0]) requires.push(rest[0]);
  }
  if (!module) throw new Error('go.mod has no module directive');
  return { module, ...(goVersion ? { goVersion } : {}), requires };
}

function unquote(s: string): string {
  return /^".*"$|^`.*`$/.test(s) ? s.slice(1, -1) : s;
}

/** Whether `path` names a standard-library package: its first element has no dot. */
export function isStdPath(path: string): boolean {
  const first = path.split('/')[0] ?? '';
  return !first.includes('.') && path !== 'C';
}
