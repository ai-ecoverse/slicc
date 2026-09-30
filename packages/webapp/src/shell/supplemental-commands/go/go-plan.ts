/**
 * `go-plan.ts` — which packages `go build` compiles, in which order
 * (#3530 phase 5e): the main module (its `go.mod`), the packages the
 * command line names, and every package of the module they import,
 * dependencies first. The standard library comes precompiled (the
 * toolchain's archives for the target); anything else is an error that
 * says so — cgo, `//go:embed`, assembly, a module the build would download.
 */
import {
  type BuildTarget,
  evalConstraint,
  type GoFileHeader,
  type GoMod,
  goodFileName,
  isStdPath,
  KNOWN_ARCH,
  KNOWN_OS,
  parseConstraint,
  parseGoMod,
  parseHeader,
} from './go-source.js';

/** What planning reads: the shell's filesystem. */
export interface GoFs {
  readText(path: string): Promise<string>;
  readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  exists(path: string): Promise<boolean>;
}

/** A build failure, worded as `go` words it. */
export class GoError extends Error {}

/** The main module: where its go.mod is, and what it says. */
export interface GoModule extends GoMod {
  dir: string;
}

/** A package to compile. */
export interface GoPackage {
  /** Its import path (`command-line-arguments` for files named on the command line). */
  path: string;
  dir: string;
  name: string;
  /** Absolute paths of the files it builds from. */
  files: string[];
  /** Import paths, each once, in order. */
  imports: string[];
}

export interface GoPlan {
  module?: GoModule;
  /** Every package of the module to compile, dependencies first. */
  packages: GoPackage[];
  /** The packages the command line named (a subset of `packages`). */
  roots: GoPackage[];
}

/** Sources a Go build does not take without cgo or the assembler. */
const FOREIGN = /\.(s|S|sx|c|cc|cpp|cxx|m|h|hh|hpp|hxx|f|F|for|f90|swig|swigcxx|syso)$/;

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** `path` shown as go shows it: relative to `cwd` as `./x`, else absolute. */
export function shown(path: string, cwd: string): string {
  if (path === cwd) return '.';
  const base = cwd === '/' ? '/' : `${cwd}/`;
  return path.startsWith(base) ? `./${path.slice(base.length)}` : path;
}

/** The module `cwd` is in: the nearest go.mod at or above it. */
export async function findModule(fs: GoFs, cwd: string): Promise<GoModule | undefined> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, 'go.mod');
    if (await fs.exists(file)) {
      try {
        return { dir, ...parseGoMod(await fs.readText(file)) };
      } catch (e) {
        throw new GoError(`go: ${file}: ${(e as Error).message}`);
      }
    }
    if (dir === '/') return undefined;
  }
}

/** Plans a build of `args` (packages, `./...` patterns, or `.go` files) from `cwd`. */
export class GoPlanner {
  private readonly loaded = new Map<string, GoPackage>();
  private readonly loading = new Set<string>();
  private readonly order: GoPackage[] = [];

  constructor(
    private readonly fs: GoFs,
    private readonly target: BuildTarget,
    /** The standard library the target has (its archives), by import path. */
    private readonly std: ReadonlySet<string>,
    private readonly module: GoModule | undefined,
    private readonly cwd: string
  ) {}

  async plan(args: readonly string[]): Promise<GoPlan> {
    const roots: GoPackage[] = [];
    const patterns = args.length === 0 ? ['.'] : args;
    if (patterns.some((a) => a.endsWith('.go'))) {
      if (!patterns.every((a) => a.endsWith('.go'))) {
        throw new GoError('go: cannot mix .go files and packages on the command line');
      }
      roots.push(await this.files(patterns));
    } else {
      for (const pattern of patterns) {
        for (const dir of await this.expand(pattern))
          roots.push(await this.load(this.pathOf(dir), dir));
      }
    }
    return { ...(this.module ? { module: this.module } : {}), packages: this.order, roots };
  }

  /** Files named on the command line: one package, `command-line-arguments`. */
  private async files(names: readonly string[]): Promise<GoPackage> {
    const files = names.map((n) =>
      n.startsWith('/') ? n : join(this.cwd, n.replace(/^\.\//, ''))
    );
    const dir = dirname(files[0] as string);
    if (files.some((f) => dirname(f) !== dir)) {
      throw new GoError('go: named files must all be in one directory');
    }
    const headers: Array<[string, GoFileHeader]> = [];
    for (const file of files) {
      if (!(await this.fs.exists(file)))
        throw new GoError(`go: no such file: ${shown(file, this.cwd)}`);
      headers.push([file, await this.header(file)]);
    }
    return this.assemble('command-line-arguments', dir, headers);
  }

  /** The directories a pattern names: one, or (`dir/...`) every package directory beneath. */
  private async expand(pattern: string): Promise<string[]> {
    const dots = pattern === '...' || pattern.endsWith('/...');
    const base = dots ? pattern.slice(0, -3).replace(/\/$/, '') || '.' : pattern;
    const dir = this.dirOf(base);
    if (!dots) return [dir];
    const found: string[] = [];
    const walk = async (d: string): Promise<void> => {
      const entries = await this.fs.readdir(d);
      if (entries.some((e) => !e.isDir && e.name.endsWith('.go') && !e.name.endsWith('_test.go'))) {
        found.push(d);
      }
      for (const e of entries) {
        // go skips testdata, and _ and . directories, and nested modules.
        if (!e.isDir || e.name === 'testdata' || /^[._]/.test(e.name)) continue;
        if (d !== dir && (await this.fs.exists(join(join(d, e.name), 'go.mod')))) continue;
        await walk(join(d, e.name));
      }
    };
    await walk(dir);
    if (found.length === 0) throw new GoError(`go: warning: "${pattern}" matched no packages`);
    return found;
  }

  /** The directory of a package argument: a path, or an import path in the main module. */
  private dirOf(arg: string): string {
    if (arg === '.' || arg === '..' || arg.startsWith('./') || arg.startsWith('../')) {
      return normalize(join(this.cwd, arg));
    }
    if (arg.startsWith('/')) return normalize(arg);
    const dir = this.module && this.moduleDir(arg);
    if (dir) return dir;
    if (isStdPath(arg)) {
      throw new GoError(`go: ${arg}: the standard library comes precompiled; nothing to build`);
    }
    throw new GoError(this.foreign(arg));
  }

  /** The directory of `path` if the main module holds it. */
  private moduleDir(path: string): string | undefined {
    const m = this.module;
    if (!m) return undefined;
    if (path === m.module) return m.dir;
    if (path.startsWith(`${m.module}/`)) return join(m.dir, path.slice(m.module.length + 1));
    return undefined;
  }

  /** The import path of a directory in the main module (else the directory itself, as go shows it). */
  private pathOf(dir: string): string {
    const m = this.module;
    if (!m)
      throw new GoError(
        "go: go.mod file not found in current directory or any parent directory; see 'go help modules'"
      );
    if (dir === m.dir) return m.module;
    if (dir.startsWith(`${m.dir}/`)) return `${m.module}/${dir.slice(m.dir.length + 1)}`;
    throw new GoError(`go: directory ${shown(dir, this.cwd)} is outside main module (${m.dir})`);
  }

  private foreign(path: string): string {
    const where = this.module ? ` or in module ${this.module.module}` : '';
    return `package ${path} is not in std${where}: SLICC's go builds the standard library and the main module's own packages only (no module downloads yet)`;
  }

  private async header(file: string): Promise<GoFileHeader> {
    try {
      return parseHeader(await this.fs.readText(file));
    } catch (e) {
      throw new GoError(`${shown(file, this.cwd)}: ${(e as Error).message}`);
    }
  }

  /** A package of the module, and (first) what it imports. */
  private async load(path: string, dir: string): Promise<GoPackage> {
    const done = this.loaded.get(path);
    if (done) return done;
    if (this.loading.has(path)) throw new GoError(`package ${path}: import cycle not allowed`);
    this.loading.add(path);
    if (!(await this.fs.exists(dir))) {
      throw new GoError(`go: package ${path}: directory ${shown(dir, this.cwd)} does not exist`);
    }
    const entries = await this.fs.readdir(dir);
    const headers: Array<[string, GoFileHeader]> = [];
    let excluded = false;
    for (const e of entries) {
      if (e.isDir) continue;
      if (FOREIGN.test(e.name) && goodForeign(e.name, this.target)) {
        throw new GoError(
          `package ${path}: ${shown(join(dir, e.name), this.cwd)}: non-Go source files (cgo, assembly) are not supported: SLICC's go builds with CGO_ENABLED=0 and no assembler yet`
        );
      }
      if (!e.name.endsWith('.go')) continue;
      if (!goodFileName(e.name, this.target)) {
        excluded ||= !e.name.endsWith('_test.go');
        continue;
      }
      const file = join(dir, e.name);
      const h = await this.header(file);
      if (h.constraint !== undefined && !this.satisfied(h.constraint, file)) {
        excluded = true;
        continue;
      }
      headers.push([file, h]);
    }
    if (headers.length === 0) {
      throw new GoError(
        excluded
          ? `package ${path}: build constraints exclude all Go files in ${dir}`
          : `package ${path}: no Go files in ${dir}`
      );
    }
    const pkg = await this.assemble(path, dir, headers);
    this.loading.delete(path);
    return pkg;
  }

  private satisfied(constraint: string, file: string): boolean {
    try {
      return evalConstraint(parseConstraint(constraint), this.target);
    } catch (e) {
      throw new GoError(`${shown(file, this.cwd)}: ${(e as Error).message}`);
    }
  }

  /** One package from its files: one name, its imports checked (and the module's loaded first). */
  private async assemble(
    path: string,
    dir: string,
    headers: ReadonlyArray<[string, GoFileHeader]>
  ): Promise<GoPackage> {
    const names = new Set(headers.map(([, h]) => h.pkg));
    if (names.size > 1) {
      const [a, b] = [...names];
      throw new GoError(`found packages ${a} and ${b} in ${dir}`);
    }
    const imports: string[] = [];
    for (const [file, h] of headers) {
      if (h.embed) {
        throw new GoError(
          `${shown(file, this.cwd)}:${h.embed.line}: //go:embed is not supported by SLICC's go yet`
        );
      }
      for (const imp of h.imports) {
        const at = `${shown(file, this.cwd)}:${imp.line}:${imp.column}`;
        if (imp.path === 'C') {
          throw new GoError(
            `${at}: import "C": cgo is not supported: SLICC's go builds with CGO_ENABLED=0`
          );
        }
        if (!imports.includes(imp.path)) imports.push(imp.path);
        await this.resolveImport(imp.path, at);
      }
    }
    const pkg: GoPackage = {
      path,
      dir,
      name: [...names][0] as string,
      files: headers.map(([f]) => f),
      imports,
    };
    this.loaded.set(path, pkg);
    this.order.push(pkg);
    return pkg;
  }

  private async resolveImport(path: string, at: string): Promise<void> {
    const dir = this.moduleDir(path);
    if (dir) {
      await this.load(path, dir);
      return;
    }
    if (isStdPath(path)) {
      // unsafe is the compiler's own: it has no archive.
      if (this.std.has(path) || path === 'unsafe') return;
      throw new GoError(
        `${at}: package ${path} is not in std for ${this.target.goos}/${this.target.goarch}`
      );
    }
    throw new GoError(`${at}: ${this.foreign(path)}`);
  }
}

/** A non-Go source's name matched against the target (its `_GOOS` / `_GOARCH` suffix), as go/build does. */
function goodForeign(name: string, target: BuildTarget): boolean {
  const dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot);
  if (stem.endsWith('_test')) return false;
  const parts = stem.split('_');
  if (parts.length < 2) return true;
  const last = parts[parts.length - 1] as string;
  const prev = parts[parts.length - 2] as string;
  if (KNOWN_OS.has(prev) && KNOWN_ARCH.has(last))
    return goodFileName(`x_${prev}_${last}.go`, target);
  if (KNOWN_OS.has(last) || KNOWN_ARCH.has(last)) return goodFileName(`x_${last}.go`, target);
  return true;
}

/** `/a/./b/../c` → `/a/c`. */
export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}
