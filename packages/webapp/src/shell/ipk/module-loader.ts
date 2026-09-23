import { splitPath } from '../../fs/path-utils.js';
import { NODE_BUILTINS } from '../../kernel/realm/node-builtins.js';
import { NODE_NATIVE_PACKAGES } from '../../kernel/realm/require-guards.js';
import { stripShebang } from '../strip-shebang.js';
import { GLOBAL_IPK_ADD } from '../supplemental-commands/shared.js';
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

export interface LoadedModule {
  path: string;

  source: string;

  cjsSource: string;

  kind: ModuleKind;
}

export interface ModuleGraph {
  files: LoadedModule[];

  entryMap: Record<string, string>;

  edges: Record<string, Record<string, string>>;

  edgeErrors: Record<string, Record<string, string>>;
}

export type ModuleTranspile = (input: {
  source: string;
  path: string;
  kind: ModuleKind;
}) => string | Promise<string>;

export type EntryTranspile = (input: {
  source: string;
  filename: string;
  fromDir: string;
}) => string | Promise<string>;

export const DEFAULT_REQUIRE_CONDITIONS = ['node', 'require', 'default'];

export const DEFAULT_IMPORT_CONDITIONS = ['node', 'import', 'default'];

export interface BuildModuleGraphOptions {
  entrySpecifiers: string[];

  fromDir: string;

  reader: ModuleReader;

  conditions?: string[];

  requireConditions?: string[];

  importConditions?: string[];

  transpile?: ModuleTranspile;
}

export interface ModuleSpecifier {
  specifier: string;

  kind: 'require' | 'import';
}

const REQUIRE_RE = /\brequire\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;
const STATIC_IMPORT_FROM_RE = /(?:^|[;\n}])\s*import\b[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/g;
const EXPORT_FROM_RE = /(?:^|[;\n}])\s*export\b[\s\S]*?\bfrom\s*(['"])([^'"]+)\1/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[;\n}])\s*import\s*(['"])([^'"]+)\1/g;

function isCodeMatch(masked: string, match: RegExpExecArray, keyword: string): boolean {
  const rel = match[0].indexOf(keyword);
  if (rel < 0) return false;
  return masked.startsWith(keyword, match.index + rel);
}

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

export function extractModuleSpecifiers(source: string): ModuleSpecifier[] {
  const masked = maskStringsAndComments(source);
  const kinds = new Map<string, 'require' | 'import'>();
  const collect = (re: RegExp, kind: 'require' | 'import', keyword: string): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (!isCodeMatch(masked, match, keyword)) continue;
      const specifier = match[2];
      const existing = kinds.get(specifier);

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

  const stripped = stripShebang(source);
  if (kind === 'esm') {
    if (!transpile) {
      throw new Error(
        `Cannot load ESM module '${path}': no transpile hook configured (run: ${GLOBAL_IPK_ADD} esbuild-wasm)`
      );
    }
    return await transpile({ source: stripped, path, kind });
  }
  return stripped;
}

export async function buildModuleGraph(options: BuildModuleGraphOptions): Promise<ModuleGraph> {
  const { entrySpecifiers, fromDir, reader, conditions, transpile } = options;
  const requireConditions = options.requireConditions ?? DEFAULT_REQUIRE_CONDITIONS;
  const importConditions = options.importConditions ?? DEFAULT_IMPORT_CONDITIONS;
  const entryConditions = conditions ?? requireConditions;
  const built = new Map<string, LoadedModule>();
  const order: string[] = [];
  const edges: Record<string, Record<string, string>> = {};
  const edgeErrors: Record<string, Record<string, string>> = {};

  async function visit(path: string, kind: ModuleKind): Promise<void> {
    if (built.has(path)) return;
    const source = await reader.readFile(path);
    const cjsSource = await toCjsSource(source, path, kind, transpile);

    built.set(path, { path, source, cjsSource, kind });
    const moduleDir = dirOf(path);
    const fileEdges: Record<string, string> = {};
    const fileEdgeErrors: Record<string, string> = {};
    for (const { specifier, kind: edgeKind } of extractModuleSpecifiers(source)) {
      let result: ResolveResult;
      try {
        const edgeConditions = edgeKind === 'import' ? importConditions : requireConditions;
        result = await resolve(specifier, moduleDir, reader, { conditions: edgeConditions });
      } catch (err) {
        fileEdgeErrors[specifier] = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (result.type === 'file') {
        fileEdges[specifier] = result.path;
        await visit(result.path, result.moduleKind);
      }
    }
    edges[path] = fileEdges;
    if (Object.keys(fileEdgeErrors).length > 0) edgeErrors[path] = fileEdgeErrors;
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
    edgeErrors,
  };
}

export interface RealmGraphResult {
  files: { path: string; cjsSource: string; kind: ModuleKind }[];
  entryMap: Record<string, string>;
  edges: Record<string, Record<string, string>>;
  edgeErrors: Record<string, Record<string, string>>;
  errors: Record<string, string>;

  entrySource?: string;

  entryIsModule?: boolean;
}

export interface BuildRealmModuleGraphOptions {
  entryCode: string;

  fromDir: string;

  entryFilename?: string;

  reader: ModuleReader;

  transpile?: ModuleTranspile;

  transpileEntry?: EntryTranspile;
}

function isGraphSpecifier(specifier: string): boolean {
  if (specifier.startsWith('sliccy:')) return false;
  if (specifier.startsWith('node:')) return false;
  if (NODE_BUILTINS.has(specifier)) return false;
  if (NODE_NATIVE_PACKAGES.has(specifier)) return false;
  return true;
}

function mergePerFileMaps(
  target: Record<string, Record<string, string>>,
  source: Record<string, Record<string, string>>
): void {
  for (const [path, entries] of Object.entries(source)) {
    target[path] = { ...(target[path] ?? {}), ...entries };
  }
}

export async function buildRealmModuleGraph(
  options: BuildRealmModuleGraphOptions
): Promise<RealmGraphResult> {
  const { entryCode, fromDir, entryFilename, reader, transpile, transpileEntry } = options;
  const files = new Map<string, LoadedModule>();
  const order: string[] = [];
  const entryMap: Record<string, string> = {};
  const edges: Record<string, Record<string, string>> = {};
  const edgeErrors: Record<string, Record<string, string>> = {};
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
      mergePerFileMaps(edges, graph.edges);
      mergePerFileMaps(edgeErrors, graph.edgeErrors);
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
    edgeErrors,
    errors,
  };
  if (entrySource !== undefined) result.entrySource = entrySource;
  if (entrySource !== undefined && hasEsmSyntax(entryCode)) result.entryIsModule = true;
  return result;
}
