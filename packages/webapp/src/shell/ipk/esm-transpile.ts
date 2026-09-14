import { getEsbuild, type IpkResolutionContext } from '../supplemental-commands/esbuild-wasm.js';
import {
  getTypeScript,
  type TypeScriptIpkContext,
  type TypeScriptModule,
} from '../supplemental-commands/shared.js';
import type { EntryTranspile, ModuleTranspile } from './module-loader.js';
import { hasDynamicImport, hasEsmSyntax } from './resolver.js';

export { hasDynamicImport, hasEsmSyntax } from './resolver.js';

type EsbuildLoader = () => Promise<typeof import('esbuild-wasm')>;
type TypeScriptLoader = () => Promise<TypeScriptModule>;

export interface CreateEsmTranspileOptions {
  loadEsbuild?: EsbuildLoader;

  loadTypeScript?: TypeScriptLoader;

  ipk?: IpkResolutionContext;
}

export function vfsPathToModuleUrl(path: string): string {
  const abs = path.startsWith('/') ? path : `/${path}`;
  return new URL(`file://${abs}`).href;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cjsSourcefile(name: string): string {
  const base = name && name.length > 0 ? name : '[eval]';
  return `${base.replace(/\.[^./]+$/, '')}.js`;
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
    sourcefile: cjsSourcefile(path),

    supported: { 'dynamic-import': false },
    define: { 'import.meta.url': JSON.stringify(importMetaUrl) },
  });
  return result.code;
}

async function transpileEntryWithEsbuild(
  load: EsbuildLoader,
  source: string,
  filename: string,
  importMetaUrl: string | undefined
): Promise<string> {
  const esbuild = await load();
  const result = await esbuild.transform(source, {
    loader: 'js',
    format: 'cjs',
    sourcefile: cjsSourcefile(filename),
    supported: { 'dynamic-import': false },
    ...(importMetaUrl ? { define: { 'import.meta.url': JSON.stringify(importMetaUrl) } } : {}),
  });
  return result.code;
}

const IMPORT_META_URL_RE = /\bimport\s*\.\s*meta\s*\.\s*url\b/g;
const IMPORT_META_RE = /\bimport\s*\.\s*meta\b/g;

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

export function createEsmTranspile(options: CreateEsmTranspileOptions = {}): ModuleTranspile {
  const { ipk } = options;
  const loadEsbuild =
    options.loadEsbuild ??
    ((): Promise<typeof import('esbuild-wasm')> => getEsbuild(ipk ? { ipk } : {}));
  const loadTypeScript =
    options.loadTypeScript ??
    ((): Promise<TypeScriptModule> => getTypeScript(ipk as TypeScriptIpkContext | undefined));

  return async ({ source, path, kind }) => {
    if (kind !== 'esm') return source;

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

export function createEntryTranspile(options: CreateEsmTranspileOptions = {}): EntryTranspile {
  const { ipk } = options;
  const loadEsbuild =
    options.loadEsbuild ??
    ((): Promise<typeof import('esbuild-wasm')> => getEsbuild(ipk ? { ipk } : {}));
  const loadTypeScript =
    options.loadTypeScript ??
    ((): Promise<TypeScriptModule> => getTypeScript(ipk as TypeScriptIpkContext | undefined));

  return async ({ source, filename }) => {
    if (!hasEsmSyntax(source) && !hasDynamicImport(source)) return source;
    const isRealPath = typeof filename === 'string' && filename.startsWith('/');
    const importMetaUrl = isRealPath ? vfsPathToModuleUrl(filename) : undefined;
    const tsPath = isRealPath ? filename : '[eval].js';

    let esbuildError: unknown;
    try {
      return await transpileEntryWithEsbuild(loadEsbuild, source, filename, importMetaUrl);
    } catch (err) {
      esbuildError = err;
    }
    try {
      return await transpileWithTypeScript(loadTypeScript, source, tsPath, importMetaUrl ?? '');
    } catch (tsError) {
      throw new Error(
        `Failed to transpile entry source: ${messageOf(esbuildError)}; ` +
          `typescript fallback: ${messageOf(tsError)}`
      );
    }
  };
}
