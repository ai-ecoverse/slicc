/**
 * Host-side ESM->CJS transpile hook for the realm module loader
 * (architecture 4.4; VAL-ESM-003/004/005/017).
 *
 * The realm evaluates a uniform CJS module graph, so any ESM module must be
 * transpiled to CJS host-side before it reaches a float. {@link createEsmTranspile}
 * returns a {@link ModuleTranspile} that `buildModuleGraph` calls for `esm`
 * modules. It transpiles via `getEsbuild()` (`transform`, `format: 'cjs'`) and
 * falls back to `getTypeScript()` (`ts.transpileModule`). Transpilation only
 * runs when real ESM syntax is present — a plain-CJS source is passed through
 * untouched so it is never needlessly rewritten.
 *
 * `import.meta.url` is preserved across the transpile as a defined,
 * module-correct `file://` URL derived from the module's own VFS path, so a
 * relative `new URL(rel, import.meta.url)` resolves against the module's path
 * (esbuild's bare CJS `import.meta` lowering would otherwise leave it empty).
 *
 * In M5 the bundled esbuild/typescript loaders are always present; M7 rewires
 * those loaders to read from ipk-installed `node_modules`, at which point the
 * transpiler-missing path (VAL-ESM-014) becomes reachable.
 */

import { getEsbuild } from '../supplemental-commands/esbuild-wasm.js';
import { getTypeScript, type TypeScriptModule } from '../supplemental-commands/shared.js';
import type { ModuleTranspile } from './module-loader.js';
import { hasEsmSyntax } from './resolver.js';

export { hasEsmSyntax } from './resolver.js';

type EsbuildLoader = () => Promise<typeof import('esbuild-wasm')>;
type TypeScriptLoader = () => Promise<TypeScriptModule>;

export interface CreateEsmTranspileOptions {
  /** Override the esbuild-wasm loader (defaults to the bundled `getEsbuild`). */
  loadEsbuild?: EsbuildLoader;
  /** Override the typescript loader (defaults to the bundled `getTypeScript`). */
  loadTypeScript?: TypeScriptLoader;
}

/**
 * Build a `file://` URL that reflects an absolute VFS path, so it can be used
 * as a module-correct `import.meta.url`. Relative resolution against it lands
 * back inside the module's own directory on the VFS.
 */
export function vfsPathToModuleUrl(path: string): string {
  const abs = path.startsWith('/') ? path : `/${path}`;
  return new URL(`file://${abs}`).href;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function transpileWithEsbuild(
  load: EsbuildLoader,
  source: string,
  path: string,
  importMetaUrl: string
): Promise<string> {
  const esbuild = await load();
  const result = await esbuild.transform(source, {
    loader: 'js',
    format: 'cjs',
    sourcefile: path,
    define: { 'import.meta.url': JSON.stringify(importMetaUrl) },
  });
  return result.code;
}

const IMPORT_META_URL_RE = /\bimport\s*\.\s*meta\s*\.\s*url\b/g;
const IMPORT_META_RE = /\bimport\s*\.\s*meta\b/g;

/**
 * TypeScript leaves `import.meta` untouched under `module: CommonJS` (it would
 * be invalid in the emitted CJS), so substitute it textually before transpile:
 * `import.meta.url` -> the module URL literal, and any remaining bare
 * `import.meta` -> an object literal carrying `url`.
 */
function substituteImportMeta(source: string, importMetaUrl: string): string {
  const urlLiteral = JSON.stringify(importMetaUrl);
  return source
    .replace(IMPORT_META_URL_RE, urlLiteral)
    .replace(IMPORT_META_RE, `({ url: ${urlLiteral} })`);
}

async function transpileWithTypeScript(
  load: TypeScriptLoader,
  source: string,
  path: string,
  importMetaUrl: string
): Promise<string> {
  const ts = await load();
  // Force a `.ts` fileName: TypeScript infers per-file module format from the
  // extension (`.mjs`/`.mts` -> ESM) which would override `module: CommonJS`
  // and leave `export`/`import` in the output.
  const out = ts.transpileModule(substituteImportMeta(source, importMetaUrl), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: `${path.replace(/\.[^./]+$/, '')}.ts`,
  });
  return out.outputText;
}

/**
 * Create the ESM->CJS transpile hook. Plain CJS (no ESM syntax) and non-`esm`
 * kinds pass through untouched; ESM is transpiled via esbuild, falling back to
 * typescript. Both paths preserve a module-correct `import.meta.url`.
 */
export function createEsmTranspile(options: CreateEsmTranspileOptions = {}): ModuleTranspile {
  const loadEsbuild =
    options.loadEsbuild ?? ((): Promise<typeof import('esbuild-wasm')> => getEsbuild());
  const loadTypeScript = options.loadTypeScript ?? getTypeScript;

  return async ({ source, path, kind }) => {
    if (kind !== 'esm') return source;
    // Only transpile when real ESM syntax is present; a pure-CJS source that
    // was kind-detected as esm is passed through untouched (VAL-ESM-005).
    if (!hasEsmSyntax(source)) return source;

    const importMetaUrl = vfsPathToModuleUrl(path);
    let esbuildError: unknown;
    try {
      return await transpileWithEsbuild(loadEsbuild, source, path, importMetaUrl);
    } catch (err) {
      esbuildError = err;
    }
    try {
      return await transpileWithTypeScript(loadTypeScript, source, path, importMetaUrl);
    } catch (tsError) {
      throw new Error(
        `Failed to transpile ESM module '${path}': ${messageOf(esbuildError)}; ` +
          `typescript fallback: ${messageOf(tsError)}`
      );
    }
  };
}
