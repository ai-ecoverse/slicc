/**
 * Host-side CJS module-graph builder for the realm seam (architecture 4.1 #2,
 * 4.4, §5).
 *
 * Given one or more entry specifiers plus a `fromDir` and a {@link ModuleReader}
 * over the VFS `node_modules` tree, `buildModuleGraph` resolves every entry
 * with the Node resolver (`resolve` in `resolver.ts`), reads its source, and
 * recursively follows nested `require()` edges to produce a single, ordered,
 * uniform CJS module graph. The graph is dependency-first (post-order), so a
 * realm can populate its synchronous `require` cache in order and hand each
 * module the raw `module.exports` of its dependencies.
 *
 * Pure and host-side: it owns no DOM/shell coupling and takes the reader +
 * an optional ESM->CJS `transpile` hook as inputs, so it works in both floats
 * (CLI worker + extension sandbox) and is individually unit-testable.
 *
 * `node:`/`sliccy:`/bare-built-in edges are NOT part of the file graph — they
 * resolve to scheme/builtin results that the realm require shim serves
 * directly, so the loader skips them. JSON modules are normalized to a CJS
 * `module.exports = JSON.parse(...)` form. ESM modules require a `transpile`
 * hook (wired in M5); without one, encountering an ESM module throws a clear
 * error rather than emitting un-evaluable source.
 */

import { splitPath } from '../../fs/path-utils.js';
import { NODE_BUILTINS } from '../../kernel/realm/node-builtins.js';
import { NODE_NATIVE_PACKAGES } from '../../kernel/realm/require-guards.js';
import { stripShebang } from '../strip-shebang.js';
import {
  hasDynamicImport,
  hasEsmSyntax,
  type ModuleKind,
  type ModuleReader,
  maskStringsAndComments,
  type ResolveResult,
  resolve,
} from './resolver.js';

function dirOf(path: string): string {
  return splitPath(path).dir;
}

/** A single module in the built graph, ready for CJS evaluation in a realm. */
export interface LoadedModule {
  /** Absolute, normalized VFS path of the module file. */
  path: string;
  /** The raw source as read from the VFS. */
  source: string;
  /** CJS-ready source: raw CJS verbatim, JSON wrapped, or transpiled ESM. */
  cjsSource: string;
  /** Detected module kind of the original source. */
  kind: ModuleKind;
}

/** The ordered CJS module graph handed to the realm seam. */
export interface ModuleGraph {
  /** Modules in dependency-first (post-order) evaluation order. */
  files: LoadedModule[];
  /** Map of each file entry specifier to its resolved absolute VFS path. */
  entryMap: Record<string, string>;
  /**
   * Per-file require edges: for each module path, a map of the literal
   * `require()` specifier to its resolved absolute VFS path. Only `file`
   * edges are recorded — `node:`/`sliccy:`/bare-built-in specifiers are
   * served directly by the realm require shim and have no graph edge. The
   * realm uses these to drive a synchronous nested `require` along the
   * preloaded graph.
   */
  edges: Record<string, Record<string, string>>;
}

/** ESM->CJS transpile hook (wired host-side in M5 via esbuild/tsc). */
export type ModuleTranspile = (input: {
  source: string;
  path: string;
  kind: ModuleKind;
}) => string | Promise<string>;

/**
 * Transpile the realm's ENTRY code (`node -e` / `.jsh` source) to a CJS body
 * that runs inside the realm's `AsyncFunction` wrapper: static `import`/`export`
 * declarations become `require()`/`exports` assignments, `import()` is lowered
 * to a `require`-backed promise, and top-level `await` is preserved. Plain CJS
 * (no ESM/dynamic-import syntax) is returned untouched.
 */
export type EntryTranspile = (input: {
  source: string;
  filename: string;
  fromDir: string;
}) => string | Promise<string>;

/** CJS-require access-path conditions (`require` wins over `import`). */
export const DEFAULT_REQUIRE_CONDITIONS = ['node', 'require', 'default'];
/** ESM-import access-path conditions (`import` wins over `require`). */
export const DEFAULT_IMPORT_CONDITIONS = ['node', 'import', 'default'];

export interface BuildModuleGraphOptions {
  /** Entry specifiers to resolve from `fromDir`. */
  entrySpecifiers: string[];
  /** Directory the entry specifiers resolve against. */
  fromDir: string;
  /** Read-only VFS surface used for resolution and reading sources. */
  reader: ModuleReader;
  /** `exports`/condition priority list for resolving the entry specifiers. */
  conditions?: string[];
  /** Conditions for nested `require()` edges (default: require conditions). */
  requireConditions?: string[];
  /** Conditions for nested static/dynamic `import` edges (default: import). */
  importConditions?: string[];
  /** ESM->CJS transpile hook; required to include any ESM module. */
  transpile?: ModuleTranspile;
}

/** A specifier extracted from a module source, tagged by its access kind. */
export interface ModuleSpecifier {
  specifier: string;
  /** `require` for `require()`; `import` for static/dynamic `import`. */
  kind: 'require' | 'import';
}

const REQUIRE_RE = /\brequire\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;
const STATIC_IMPORT_FROM_RE = /(?:^|[;\n}])\s*import\b[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/g;
const EXPORT_FROM_RE = /(?:^|[;\n}])\s*export\b[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[;\n}])\s*import\s*(['"])([^'"]+)\1/g;

/**
 * True when the `keyword` (`require`/`import`/`export`) that anchors `match`
 * survives in the string/comment-masked source — i.e. the match is genuine
 * code, not a keyword that only appears inside a string, template, or comment.
 */
function isCodeMatch(masked: string, match: RegExpExecArray, keyword: string): boolean {
  const rel = match[0].indexOf(keyword);
  if (rel < 0) return false;
  return masked.startsWith(keyword, match.index + rel);
}

/** Extract the literal `require('...')` specifiers from a module source. */
export function extractRequireSpecifiers(source: string): string[] {
  const masked = maskStringsAndComments(source);
  const ids = new Set<string>();
  REQUIRE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REQUIRE_RE.exec(source)) !== null) {
    if (isCodeMatch(masked, match, 'require')) ids.add(match[2]);
  }
  return [...ids];
}

/**
 * Extract every module specifier from a source, tagged by access kind:
 * `require()` -> `require`; static `import ... from` / `export ... from` /
 * side-effect `import '...'` / dynamic `import('...')` -> `import`. When a
 * specifier appears under both kinds, `import` wins (so the import access path
 * selects `import` exports conditions). Insertion order is preserved.
 */
export function extractModuleSpecifiers(source: string): ModuleSpecifier[] {
  const masked = maskStringsAndComments(source);
  const kinds = new Map<string, 'require' | 'import'>();
  const collect = (re: RegExp, kind: 'require' | 'import', keyword: string): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      // Skip keywords that only appear inside a string/template/comment.
      if (!isCodeMatch(masked, match, keyword)) continue;
      const specifier = match[2];
      const existing = kinds.get(specifier);
      // `import` is authoritative; a later `require` never downgrades it.
      if (existing === 'import') continue;
      kinds.set(specifier, kind);
    }
  };
  collect(REQUIRE_RE, 'require', 'require');
  collect(DYNAMIC_IMPORT_RE, 'import', 'import');
  collect(STATIC_IMPORT_FROM_RE, 'import', 'import');
  collect(EXPORT_FROM_RE, 'import', 'export');
  collect(SIDE_EFFECT_IMPORT_RE, 'import', 'import');
  return [...kinds].map(([specifier, kind]) => ({ specifier, kind }));
}

async function toCjsSource(
  source: string,
  path: string,
  kind: ModuleKind,
  transpile: ModuleTranspile | undefined
): Promise<string> {
  if (kind === 'json') {
    return `module.exports = JSON.parse(${JSON.stringify(source)});\n`;
  }
  // Strip any leading `#!...` line before evaluating: a published bin / script
  // module shipped with a shebang would otherwise be a parse error in both the
  // CJS evaluator and the ESM transpiler. Only the first line is touched.
  const stripped = stripShebang(source);
  if (kind === 'esm') {
    if (!transpile) {
      throw new Error(
        `Cannot load ESM module '${path}': no transpile hook configured (run: ipk install esbuild-wasm)`
      );
    }
    return await transpile({ source: stripped, path, kind });
  }
  return stripped;
}

/**
 * Build the ordered CJS module graph for `entrySpecifiers`, recursively
 * following nested `require()` edges over `reader`. Cycles terminate (each
 * file is visited once); unresolvable bare requires propagate the resolver's
 * exact `Cannot find module '<x>' (run: ipk install <x>)` error.
 */
export async function buildModuleGraph(options: BuildModuleGraphOptions): Promise<ModuleGraph> {
  const { entrySpecifiers, fromDir, reader, conditions, transpile } = options;
  const requireConditions = options.requireConditions ?? DEFAULT_REQUIRE_CONDITIONS;
  const importConditions = options.importConditions ?? DEFAULT_IMPORT_CONDITIONS;
  const entryConditions = conditions ?? requireConditions;
  const built = new Map<string, LoadedModule>();
  const order: string[] = [];
  const edges: Record<string, Record<string, string>> = {};

  async function visit(path: string, kind: ModuleKind): Promise<void> {
    if (built.has(path)) return;
    const source = await reader.readFile(path);
    const cjsSource = await toCjsSource(source, path, kind, transpile);
    // Register before recursing so a require/import cycle terminates.
    built.set(path, { path, source, cjsSource, kind });
    const moduleDir = dirOf(path);
    const fileEdges: Record<string, string> = {};
    for (const { specifier, kind: edgeKind } of extractModuleSpecifiers(source)) {
      let result: ResolveResult;
      try {
        const edgeConditions = edgeKind === 'import' ? importConditions : requireConditions;
        result = await resolve(specifier, moduleDir, reader, { conditions: edgeConditions });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`While loading '${path}': ${reason}`);
      }
      if (result.type === 'file') {
        fileEdges[specifier] = result.path;
        await visit(result.path, result.moduleKind);
      }
    }
    edges[path] = fileEdges;
    order.push(path);
  }

  const entryMap: Record<string, string> = {};
  for (const specifier of entrySpecifiers) {
    const result = await resolve(specifier, fromDir, reader, { conditions: entryConditions });
    if (result.type === 'file') {
      entryMap[specifier] = result.path;
      await visit(result.path, result.moduleKind);
    }
  }

  return {
    files: order.map((path) => {
      const mod = built.get(path);
      if (!mod) throw new Error(`module-loader: missing built module for '${path}'`);
      return mod;
    }),
    entryMap,
    edges,
  };
}

/** The structured-clone-safe realm module graph (mirrors `RealmModuleGraph`). */
export interface RealmGraphResult {
  files: { path: string; cjsSource: string; kind: ModuleKind }[];
  entryMap: Record<string, string>;
  edges: Record<string, Record<string, string>>;
  errors: Record<string, string>;
  /**
   * The transpiled entry source when the entry used ESM / dynamic-import
   * syntax; absent for plain CJS entries (the realm then runs `init.code`).
   */
  entrySource?: string;
}

export interface BuildRealmModuleGraphOptions {
  /** The realm's entry code (`node -e` / `.jsh` source). */
  entryCode: string;
  /** Directory the entry's top-level specifiers resolve against. */
  fromDir: string;
  /** The entry's filename (for entry `import.meta.url`); `[eval]` for `-e`. */
  entryFilename?: string;
  /** Read-only VFS surface used for resolution and reading sources. */
  reader: ModuleReader;
  /** ESM->CJS transpile hook applied to every ESM module in the graph. */
  transpile?: ModuleTranspile;
  /** Entry-code transpile hook (static/dynamic import + top-level await). */
  transpileEntry?: EntryTranspile;
}

/**
 * Specifiers the host module-loader owns (relative paths + bare `node_modules`
 * packages). `sliccy:`, `node:`/bare Node built-ins, and native C++ packages
 * are served (or hard-failed) directly by the realm require shim, so they
 * never enter the graph build.
 */
function isGraphSpecifier(specifier: string): boolean {
  if (specifier.startsWith('sliccy:')) return false;
  if (specifier.startsWith('node:')) return false;
  if (NODE_BUILTINS.has(specifier)) return false;
  if (NODE_NATIVE_PACKAGES.has(specifier)) return false;
  return true;
}

/**
 * Build the realm's complete CJS module graph from its ENTRY CODE: extract the
 * tagged `require`/`import` specifiers, resolve each in isolation (so a single
 * uninstalled entry surfaces as `errors[specifier]` without sinking the
 * others) with its access-path conditions (`import` -> import conditions,
 * `require` -> require conditions), recursively follow nested edges per kind,
 * dedup shared modules by path, and transpile the entry itself when it uses
 * ESM / dynamic-import syntax. There is NO CDN fallback — an unresolved bare
 * module is an `errors[specifier]` entry, never a network fetch. Used by both
 * floats (`realm-host.ts dispatchModule`) and the parity harness.
 */
export async function buildRealmModuleGraph(
  options: BuildRealmModuleGraphOptions
): Promise<RealmGraphResult> {
  const { entryCode, fromDir, entryFilename, reader, transpile, transpileEntry } = options;
  const files = new Map<string, LoadedModule>();
  const order: string[] = [];
  const entryMap: Record<string, string> = {};
  const edges: Record<string, Record<string, string>> = {};
  const errors: Record<string, string> = {};

  for (const { specifier, kind } of extractModuleSpecifiers(entryCode)) {
    if (!isGraphSpecifier(specifier)) continue;
    try {
      const graph = await buildModuleGraph({
        entrySpecifiers: [specifier],
        fromDir,
        reader,
        transpile,
        conditions: kind === 'import' ? DEFAULT_IMPORT_CONDITIONS : DEFAULT_REQUIRE_CONDITIONS,
        requireConditions: DEFAULT_REQUIRE_CONDITIONS,
        importConditions: DEFAULT_IMPORT_CONDITIONS,
      });
      for (const file of graph.files) {
        if (!files.has(file.path)) {
          files.set(file.path, file);
          order.push(file.path);
        }
      }
      Object.assign(entryMap, graph.entryMap);
      for (const [path, fileEdges] of Object.entries(graph.edges)) {
        edges[path] = { ...(edges[path] ?? {}), ...fileEdges };
      }
    } catch (err) {
      errors[specifier] = err instanceof Error ? err.message : String(err);
    }
  }

  let entrySource: string | undefined;
  if (transpileEntry && (hasEsmSyntax(entryCode) || hasDynamicImport(entryCode))) {
    entrySource = await transpileEntry({
      source: entryCode,
      filename: entryFilename ?? '[eval]',
      fromDir,
    });
  }

  const result: RealmGraphResult = {
    files: order.map((path) => {
      const mod = files.get(path);
      if (!mod) throw new Error(`module-loader: missing built module for '${path}'`);
      return { path: mod.path, cjsSource: mod.cjsSource, kind: mod.kind };
    }),
    entryMap,
    edges,
    errors,
  };
  if (entrySource !== undefined) result.entrySource = entrySource;
  return result;
}
