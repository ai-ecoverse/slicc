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
import { type ModuleKind, type ModuleReader, type ResolveResult, resolve } from './resolver.js';

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

export interface BuildModuleGraphOptions {
  /** Entry specifiers to resolve from `fromDir`. */
  entrySpecifiers: string[];
  /** Directory the entry specifiers resolve against. */
  fromDir: string;
  /** Read-only VFS surface used for resolution and reading sources. */
  reader: ModuleReader;
  /** `exports`/condition priority list forwarded to `resolve`. */
  conditions?: string[];
  /** ESM->CJS transpile hook; required to include any ESM module. */
  transpile?: ModuleTranspile;
}

const REQUIRE_RE = /\brequire\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;

/** Extract the literal `require('...')` specifiers from a module source. */
export function extractRequireSpecifiers(source: string): string[] {
  const ids = new Set<string>();
  REQUIRE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REQUIRE_RE.exec(source)) !== null) {
    ids.add(match[2]);
  }
  return [...ids];
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
  if (kind === 'esm') {
    if (!transpile) {
      throw new Error(
        `Cannot load ESM module '${path}': no transpile hook configured (run: ipk install esbuild-wasm)`
      );
    }
    return await transpile({ source, path, kind });
  }
  return source;
}

/**
 * Build the ordered CJS module graph for `entrySpecifiers`, recursively
 * following nested `require()` edges over `reader`. Cycles terminate (each
 * file is visited once); unresolvable bare requires propagate the resolver's
 * exact `Cannot find module '<x>' (run: ipk install <x>)` error.
 */
export async function buildModuleGraph(options: BuildModuleGraphOptions): Promise<ModuleGraph> {
  const { entrySpecifiers, fromDir, reader, conditions, transpile } = options;
  const built = new Map<string, LoadedModule>();
  const order: string[] = [];
  const edges: Record<string, Record<string, string>> = {};
  const resolveOptions = conditions ? { conditions } : undefined;

  async function visit(path: string, kind: ModuleKind): Promise<void> {
    if (built.has(path)) return;
    const source = await reader.readFile(path);
    const cjsSource = await toCjsSource(source, path, kind, transpile);
    // Register before recursing so a require cycle terminates.
    built.set(path, { path, source, cjsSource, kind });
    const moduleDir = dirOf(path);
    const fileEdges: Record<string, string> = {};
    for (const specifier of extractRequireSpecifiers(source)) {
      let result: ResolveResult;
      try {
        result = await resolve(specifier, moduleDir, reader, resolveOptions);
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
    const result = await resolve(specifier, fromDir, reader, resolveOptions);
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
