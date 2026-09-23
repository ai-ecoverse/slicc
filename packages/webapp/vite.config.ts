import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { piAiModelDataGeneratedAt } from './vite-plugins/pi-ai-model-data';
import { stripBiomeWasmAssetPlugin } from './vite-plugins/strip-biome-wasm-asset';
import { stripFfmpegCoreCdnLiteralPlugin } from './vite-plugins/strip-ffmpeg-core-cdn-literal';
import { stripOrtWasmAssetPlugin } from './vite-plugins/strip-ort-wasm-asset';

const Dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(Dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};

const webappPkg = JSON.parse(readFileSync(resolve(Dirname, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function wasmDepVersion(name: string): string {
  const spec = webappPkg.dependencies?.[name] ?? webappPkg.devDependencies?.[name];
  if (!spec) throw new Error(`webapp package.json is missing a version for ${name}`);
  return spec.replace(/^[\^~]/, '');
}
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;
const uiOutDir = resolve(workspaceRoot, 'dist/ui');
const previewSwEntry = resolve(Dirname, 'src/ui/preview-sw.ts');
const llmProxySwEntry = resolve(Dirname, 'src/ui/llm-proxy-sw.ts');

const electronOverlayEntry = resolve(workspaceRoot, 'packages/spoon/src/overlay-entry.ts');
const sliccEditorEntry = resolve(Dirname, 'src/ui/slicc-editor-entry.ts');
const sliccDiffEntry = resolve(Dirname, 'src/ui/slicc-diff-entry.ts');
const lucideIconsEntry = resolve(Dirname, 'src/ui/lucide-icons.ts');

function curatedShikiBundlePlugin() {
  return {
    name: 'curated-shiki-bundle',
    enforce: 'pre' as const,
    resolveId(source: string) {
      return source === 'shiki' ? resolve(Dirname, 'src/shims/shiki-bundle.ts') : undefined;
    },
  };
}

function stubPiNodeInternalsPlugin() {
  return {
    name: 'stub-pi-node-internals',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      const normalizedImporter = importer?.replace(/\\/g, '/');
      if (normalizedImporter?.includes('@earendil-works/pi-coding-agent')) {
        if (source.endsWith('/session-manager.js')) {
          return resolve(Dirname, 'src/stubs/pi-session-manager-stub.ts');
        }
        if (source.endsWith('/config.js') || source === '../config.js') {
          return resolve(Dirname, 'src/stubs/pi-config-stub.ts');
        }
      }
      return undefined;
    },
  };
}

function stubPageRealmSpeechPlugin() {
  return {
    name: 'stub-page-realm-speech',
    enforce: 'pre' as const,
    resolveId(source: string) {
      return /(^|\/)speech\/(speak|hear)\.js$/.test(source)
        ? resolve(Dirname, 'src/stubs/speech-page-realm-stub.ts')
        : undefined;
    },
  };
}

function isolatePiEditToolPlugin() {
  const marker = '?pi-edit-lazy';
  return {
    name: 'isolate-pi-edit-tool',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (!importer?.endsWith(marker) || !source.startsWith('.')) return undefined;
      const cleanImporter = importer.slice(0, -marker.length);
      return `${resolve(dirname(cleanImporter), source)}${marker}`;
    },
  };
}

function rawSvgEsbuildPlugin(): import('esbuild').Plugin {
  return {
    name: 'raw-svg',
    setup(build) {
      build.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace('?raw', '')),
        namespace: 'raw-svg',
      }));
      build.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async (args) => {
        const { readFile } = await import('fs/promises');
        return { contents: await readFile(args.path, 'utf8'), loader: 'text' };
      });
    },
  };
}

interface IifeMiddlewareOptions {
  label: string;

  entry: string;

  cacheByMtime?: boolean;

  headers?: Record<string, string>;

  esbuildPlugins?: import('esbuild').Plugin[];
}

function iifeBundleMiddleware(options: IifeMiddlewareOptions) {
  let cachedCode: string | null = null;
  let cachedMtime = 0;
  return async (_req: unknown, res: import('node:http').ServerResponse): Promise<void> => {
    try {
      let mtime = 0;
      if (options.cacheByMtime) {
        const { statSync } = await import('fs');
        mtime = statSync(options.entry).mtimeMs;
      }
      if (!cachedCode || !options.cacheByMtime || mtime > cachedMtime) {
        const esbuild = await import('esbuild');
        const result = await esbuild.build({
          entryPoints: [options.entry],
          bundle: true,
          write: false,
          format: 'iife',
          target: 'esnext',
          define: { __DEV__: 'true', global: 'globalThis' },
          ...(options.esbuildPlugins ? { plugins: options.esbuildPlugins } : {}),
        });
        cachedCode = result.outputFiles![0].text;
        cachedMtime = mtime;
      }
      res.setHeader('Content-Type', 'application/javascript');
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        res.setHeader(name, value);
      }
      res.end(cachedCode);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${options.label}] Failed to build:`, errMsg);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`console.error('[${options.label}] Build failed:', ${JSON.stringify(errMsg)});`);
    }
  };
}

const SPRINKLE_ENTRY_SHIMS: Record<string, string> = {
  'slicc-editor.js': 'packages/webapp/src/ui/slicc-editor-entry.ts',
  'slicc-diff.js': 'packages/webapp/src/ui/slicc-diff-entry.ts',
};

function sprinkleShimSource(stableName: string, target: string): string {
  return `(function(){var s=document.currentScript;var b=s&&s.src?s.src:location.href;var u=new URL(${JSON.stringify(
    target
  )},b).href;var p=import(u);p.catch(function(e){console.error('[${stableName}] failed to load',e)});var g=window.__SLICC_SPRINKLE_ASSETS__||(window.__SLICC_SPRINKLE_ASSETS__={});g[${JSON.stringify(
    stableName
  )}]=p;})();\n`;
}

async function writeSprinkleEntryShims(): Promise<void> {
  const { readFileSync: read, writeFileSync } = await import('fs');
  const manifest = JSON.parse(read(resolve(uiOutDir, '.vite/manifest.json'), 'utf-8')) as Record<
    string,
    { file: string }
  >;
  for (const [stableName, entryKey] of Object.entries(SPRINKLE_ENTRY_SHIMS)) {
    const emitted = manifest[entryKey]?.file;
    if (!emitted) {
      throw new Error(
        `vite manifest has no entry for ${entryKey} — the ${stableName} shim would 404`
      );
    }
    writeFileSync(resolve(uiOutDir, stableName), sprinkleShimSource(stableName, emitted));
  }
}

const PROD_IIFE_DEFAULTS = {
  bundle: true,
  format: 'iife',
  target: 'esnext',
  minify: true,
  define: { __DEV__: 'false', global: 'globalThis' },
} as const;

async function buildProductionRuntimeAssets(): Promise<void> {
  const esbuild = await import('esbuild');
  const { copyFileSync } = await import('fs');
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [previewSwEntry],
    outfile: resolve(uiOutDir, 'preview-sw.js'),
  });

  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [llmProxySwEntry],
    outfile: resolve(uiOutDir, 'llm-proxy-sw.js'),
  });

  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [electronOverlayEntry],
    outfile: resolve(uiOutDir, 'electron-overlay-entry.js'),
    plugins: [rawSvgEsbuildPlugin()],
  });

  await writeSprinkleEntryShims();

  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [lucideIconsEntry],
    outfile: resolve(uiOutDir, 'lucide-icons.js'),
  });

  copyFileSync(resolve(Dirname, '../assets/logos/favicon.png'), resolve(uiOutDir, 'favicon.png'));

  const { existsSync } = await import('fs');
  const nestedHtml = resolve(uiOutDir, 'packages/webapp/index.html');
  if (existsSync(nestedHtml)) {
    copyFileSync(nestedHtml, resolve(uiOutDir, 'index.html'));
  }
}

function buildWebappRuntimeAssetsPlugin() {
  return {
    name: 'build-webapp-runtime-assets',
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          handler: (req: unknown, res: import('node:http').ServerResponse) => void | Promise<void>
        ) => void;
      };
    }) {
      server.middlewares.use(
        '/preview-sw.js',
        iifeBundleMiddleware({ label: 'preview-sw', entry: previewSwEntry, cacheByMtime: true })
      );

      server.middlewares.use(
        '/llm-proxy-sw.js',
        iifeBundleMiddleware({
          label: 'llm-proxy-sw',
          entry: llmProxySwEntry,
          headers: { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-store' },
        })
      );
      server.middlewares.use(
        '/electron-overlay-entry.js',
        iifeBundleMiddleware({
          label: 'electron-overlay-entry',
          entry: electronOverlayEntry,
          cacheByMtime: true,
          esbuildPlugins: [rawSvgEsbuildPlugin()],
        })
      );

      for (const [stableName, entry] of Object.entries(SPRINKLE_ENTRY_SHIMS)) {
        server.middlewares.use(`/${stableName}`, (_req, res) => {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(sprinkleShimSource(stableName, `/${entry}`));
        });
      }

      server.middlewares.use(
        '/lucide-icons.js',
        iifeBundleMiddleware({ label: 'lucide-icons', entry: lucideIconsEntry })
      );
    },

    writeBundle: buildProductionRuntimeAssets,
  };
}

const MODULE_ALIASES: Record<string, string> = {
  '@slicc/shared-ts': resolve(workspaceRoot, 'packages/shared-ts/src/index.ts'),

  buffer: 'buffer/',

  'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),

  'node:zlib': resolve(Dirname, 'src/shims/empty.ts'),
  'node:module': resolve(Dirname, 'src/shims/empty.ts'),

  stream: resolve(Dirname, 'src/shims/stream.ts'),
  http: resolve(Dirname, 'src/shims/http.ts'),
  https: resolve(Dirname, 'src/shims/https.ts'),
  http2: resolve(Dirname, 'src/shims/http2.ts'),

  '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'
  ),

  '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js': resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js'
  ),

  '@earendil-works/pi-agent-core/edit-tool': resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-agent-core/dist/harness/tools/edit.js?pi-edit-lazy'
  ),

  '@pierre/diffs/dist/components/web-components.js': resolve(
    workspaceRoot,
    'node_modules/@pierre/diffs/dist/components/web-components.js'
  ),
  '@earendil-works/pi-ai/dist/api/transform-messages.js': resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js'
  ),
  '@earendil-works/pi-ai/dist/api/simple-options.js': resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-ai/dist/api/simple-options.js'
  ),
};

export default defineConfig(({ mode }) => ({
  root: workspaceRoot,
  publicDir: resolve(workspaceRoot, 'packages/assets'),
  plugins: [
    stripBiomeWasmAssetPlugin(),
    stripOrtWasmAssetPlugin(),
    curatedShikiBundlePlugin(),
    stubPiNodeInternalsPlugin(),
    isolatePiEditToolPlugin(),
    buildWebappRuntimeAssetsPlugin(),

    stripFfmpegCoreCdnLiteralPlugin(),
  ],
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
    __SLICC_VERSION__: JSON.stringify(rootPkg.version),
    __SLICC_RELEASED_AT__: JSON.stringify(sliccReleasedAt),

    __PI_AI_MODELS_GENERATED_AT__: JSON.stringify(piAiModelDataGeneratedAt(workspaceRoot)),

    __SLICC_BUILD_ID__: JSON.stringify(`${rootPkg.version}-${Date.now().toString(36)}`),

    __MAGICK_WASM_VERSION__: JSON.stringify(wasmDepVersion('@imagemagick/magick-wasm')),
    __BIOME_WASM_WEB_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/wasm-web')),
    __BIOME_JS_API_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/js-api')),
    __FFMPEG_CORE_VERSION__: JSON.stringify(wasmDepVersion('@ffmpeg/core')),

    __V86_VERSION__: JSON.stringify(wasmDepVersion('v86')),

    global: 'globalThis',
  },
  resolve: {
    alias: MODULE_ALIASES,
    dedupe: ['@earendil-works/pi-ai', '@huggingface/transformers'],
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@earendil-works/pi-coding-agent'],

    include: ['@imagemagick/magick-wasm', 'mediabunny'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    headers: {
      'Document-Isolation-Policy': 'isolate-and-credentialless',
    },
    watch: {
      ignored: [resolve(workspaceRoot, '.yolo/**'), resolve(workspaceRoot, '.intent/**')],
    },
  },

  worker: {
    format: 'es',
    plugins: () => [
      curatedShikiBundlePlugin(),
      stubPiNodeInternalsPlugin(),
      stubPageRealmSpeechPlugin(),
      isolatePiEditToolPlugin(),
    ],
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    target: 'esnext',

    manifest: true,
    rollupOptions: {
      input: {
        main: resolve(Dirname, 'index.html'),
        cloud: resolve(Dirname, 'cloud/index.html'),
        'slicc-editor': sliccEditorEntry,
        'slicc-diff': sliccDiffEntry,
      },
    },
  },
}));
