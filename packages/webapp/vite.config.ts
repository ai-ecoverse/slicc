import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { stripBiomeWasmAssetPlugin } from './vite-plugins/strip-biome-wasm-asset';
import { stripOrtWasmAssetPlugin } from './vite-plugins/strip-ort-wasm-asset';

const Dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(Dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;
const uiOutDir = resolve(workspaceRoot, 'dist/ui');
const previewSwEntry = resolve(Dirname, 'src/ui/preview-sw.ts');
const llmProxySwEntry = resolve(Dirname, 'src/ui/llm-proxy-sw.ts');
const electronOverlayEntry = resolve(Dirname, 'src/ui/electron-overlay-entry.ts');
const sliccEditorEntry = resolve(Dirname, 'src/ui/slicc-editor-entry.ts');
const sliccDiffEntry = resolve(Dirname, 'src/ui/slicc-diff-entry.ts');
const lucideIconsEntry = resolve(Dirname, 'src/ui/lucide-icons.ts');

/** esbuild plugin: resolve @pierre/diffs internal imports that aren't in the exports map. */
function pierreDiffsPlugin() {
  return {
    name: 'resolve-pierre-diffs-internals',
    setup(build: { onResolve: Function }) {
      build.onResolve({ filter: /^@pierre\/diffs\/dist\// }, (args: { path: string }) => ({
        path: resolve(workspaceRoot, 'node_modules', args.path.replace(/\.js$/, '') + '.js'),
      }));
    },
  };
}

/**
 * Vite plugin: replace pi-coding-agent's Node-only modules
 * (session-manager.js, config.js — which pull in fs/path/url/jiti via Node
 * imports and top-level fileURLToPath calls) with browser-safe stubs.
 * resolve.alias can't catch relative imports inside node_modules, so we
 * hook resolveId. Must be applied to BOTH the main and worker plugin
 * lists in rolldown-vite — worker bundling does not inherit `plugins`
 * automatically.
 */
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

/** esbuild plugin: strip ?raw suffix and load .svg files as text (matches Vite's ?raw). */
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
  /** Log label, e.g. 'preview-sw'. */
  label: string;
  /** Entry file the IIFE bundles. */
  entry: string;
  /**
   * Skip rebuilds while the ENTRY file's mtime is unchanged. Only safe for
   * entries whose transitive deps rarely change — an mtime-on-entry-only
   * cache silently serves stale code when a dep changes, so bundles with
   * live-edited imports rebuild every request (esbuild is ~5ms).
   */
  cacheByMtime?: boolean;
  /** Extra response headers (e.g. Service-Worker-Allowed). */
  headers?: Record<string, string>;
  /** Extra esbuild plugins for this entry. */
  esbuildPlugins?: import('esbuild').Plugin[];
}

/** Dev middleware: serve `entry` as a freshly-esbuilt IIFE bundle. */
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

/** The production esbuild defaults every runtime-asset IIFE shares. */
const PROD_IIFE_DEFAULTS = {
  bundle: true,
  format: 'iife',
  target: 'esnext',
  minify: true,
  define: { __DEV__: 'false', global: 'globalThis' },
} as const;

/** closeBundle: emit the standalone runtime-asset bundles into dist/ui. */
async function buildProductionRuntimeAssets(): Promise<void> {
  // Keep this config focused on production build artifacts; node-server owns dev serving.
  // Rollup would code-split LightningFS into a shared chunk, which SWs can't import.
  const esbuild = await import('esbuild');
  const { copyFileSync } = await import('fs');
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [previewSwEntry],
    outfile: resolve(uiOutDir, 'preview-sw.js'),
  });

  // LLM-proxy SW — root-scope, intercepts cross-origin LLM fetches
  // and reroutes them through /api/fetch-proxy in CLI mode.
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [llmProxySwEntry],
    outfile: resolve(uiOutDir, 'llm-proxy-sw.js'),
  });

  // Electron reinjection still needs a standalone production bundle.
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [electronOverlayEntry],
    outfile: resolve(uiOutDir, 'electron-overlay-entry.js'),
    plugins: [rawSvgEsbuildPlugin()],
  });

  // <slicc-editor> custom element bundle for sprinkle iframes.
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [sliccEditorEntry],
    outfile: resolve(uiOutDir, 'slicc-editor.js'),
  });

  // <slicc-diff> custom element bundle for sprinkle iframes.
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [sliccDiffEntry],
    outfile: resolve(uiOutDir, 'slicc-diff.js'),
    plugins: [pierreDiffsPlugin()],
  });

  // Lucide icons bundle for sprinkle iframes.
  await esbuild.build({
    ...PROD_IIFE_DEFAULTS,
    entryPoints: [lucideIconsEntry],
    outfile: resolve(uiOutDir, 'lucide-icons.js'),
  });

  // Note: `kernel-worker.ts` rides the Rollup pipeline via
  // Vite's native `new Worker(new URL(...), { type: 'module' })`
  // detection in `kernel/spawn.ts`. `resolve.alias` carries over
  // to the worker bundle, but `plugins` does NOT — see the
  // `worker.plugins` block below where we re-pass the stub plugin.
  // No standalone esbuild call needed.
  copyFileSync(resolve(Dirname, '../assets/logos/favicon.png'), resolve(uiOutDir, 'favicon.png'));
  // Vite preserves the nested HTML path when the repo root is the Vite root.
  // In some Vite versions the HTML lands directly at outDir root — only copy if nested.
  const { existsSync } = await import('fs');
  const nestedHtml = resolve(uiOutDir, 'packages/webapp/index.html');
  if (existsSync(nestedHtml)) {
    copyFileSync(nestedHtml, resolve(uiOutDir, 'index.html'));
  }
}

/** Dev middlewares + production bundles for the standalone runtime assets. */
function buildWebappRuntimeAssetsPlugin() {
  return {
    name: 'build-webapp-runtime-assets',
    configureServer(server: {
      middlewares: {
        use: (path: string, handler: ReturnType<typeof iifeBundleMiddleware>) => void;
      };
    }) {
      // preview-sw / electron-overlay cache by entry mtime; the others (and
      // the llm-proxy SW, whose deps are live-edited) rebuild every request.
      server.middlewares.use(
        '/preview-sw.js',
        iifeBundleMiddleware({ label: 'preview-sw', entry: previewSwEntry, cacheByMtime: true })
      );
      // SW must be served at the root scope; instruct the browser not to
      // cache it so dev-mode rebuilds always reach the page.
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
      server.middlewares.use(
        '/slicc-editor.js',
        iifeBundleMiddleware({ label: 'slicc-editor', entry: sliccEditorEntry })
      );
      server.middlewares.use(
        '/slicc-diff.js',
        iifeBundleMiddleware({
          label: 'slicc-diff',
          entry: sliccDiffEntry,
          esbuildPlugins: [pierreDiffsPlugin() as import('esbuild').Plugin],
        })
      );
      // Note: `src/kernel/kernel-worker.ts` is loaded via Vite's native
      // `new Worker(new URL('./kernel-worker.ts', import.meta.url))` pattern
      // in `kernel/spawn.ts` — no dev middleware or closeBundle entry needed.
      server.middlewares.use(
        '/lucide-icons.js',
        iifeBundleMiddleware({ label: 'lucide-icons', entry: lucideIconsEntry })
      );
    },
    closeBundle: buildProductionRuntimeAssets,
  };
}

export default defineConfig(({ mode }) => ({
  root: workspaceRoot,
  publicDir: resolve(workspaceRoot, 'packages/assets'),
  plugins: [
    stripBiomeWasmAssetPlugin(),
    stripOrtWasmAssetPlugin(),
    stubPiNodeInternalsPlugin(),
    buildWebappRuntimeAssetsPlugin(),
  ],
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
    __SLICC_VERSION__: JSON.stringify(rootPkg.version),
    __SLICC_RELEASED_AT__: JSON.stringify(sliccReleasedAt),
    // Buffer polyfill for isomorphic-git
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Workspace `@slicc/shared-ts` points at source so Vite's worker bundle
      // (kernel-worker via `new Worker(new URL(...))` in spawn.ts) resolves
      // without requiring `packages/shared-ts/dist/` to exist at build time.
      // node-server's runtime still consumes the built dist/ via the
      // package's exports.default.
      '@slicc/shared-ts': resolve(workspaceRoot, 'packages/shared-ts/src/index.ts'),
      // Buffer polyfill for isomorphic-git (browser compatibility)
      buffer: 'buffer/',
      // The pinned isomorphic-git package resolves "." to index.cjs, and that
      // CJS entry imports Node crypto. Force the browser-safe ESM entry
      // instead.
      'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),
      // just-bash's browser bundle references node:zlib and node:module for
      // gzip/gunzip commands that aren't functional in browsers anyway.
      // Alias to empty stubs so the bundled JS never tries to fetch them.
      'node:zlib': resolve(Dirname, 'src/shims/empty.ts'),
      'node:module': resolve(Dirname, 'src/shims/empty.ts'),
      // @smithy/node-http-handler imports named exports from Node builtins
      // (without node: prefix). Vite's browser-external can't provide named
      // exports, so alias to stubs with the required exports.
      stream: resolve(Dirname, 'src/shims/stream.ts'),
      http: resolve(Dirname, 'src/shims/http.ts'),
      https: resolve(Dirname, 'src/shims/https.ts'),
      http2: resolve(Dirname, 'src/shims/http2.ts'),
      // Deep import into pi-coding-agent's compaction submodule — the main entry
      // re-exports 113 Node-only modules that break Vite's browser bundle.
      // The compaction submodule only depends on @earendil-works/pi-ai (browser-safe).
      '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        workspaceRoot,
        'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'
      ),
      '@earendil-works/pi-ai/dist/providers/transform-messages.js': resolve(
        workspaceRoot,
        'node_modules/@earendil-works/pi-ai/dist/providers/transform-messages.js'
      ),
      '@earendil-works/pi-ai/dist/providers/simple-options.js': resolve(
        workspaceRoot,
        'node_modules/@earendil-works/pi-ai/dist/providers/simple-options.js'
      ),
    },
    // kokoro-js pins @huggingface/transformers ^3.x, which npm nests as a
    // second copy (npm overrides don't reach workspace deps). Deduping forces
    // kokoro's bare import onto the hoisted 4.x the speech stack uses — one
    // transformers bundle, one onnxruntime-web version, one wasmPaths config.
    dedupe: ['@earendil-works/pi-ai', '@huggingface/transformers'],
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@earendil-works/pi-coding-agent'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    watch: {
      // Anchor to workspaceRoot so the ignore only matches the top-level
      // .yolo/.intent dirs in the main checkout. Using a bare `**/.yolo/**`
      // glob matches chokidar's absolute paths, which silently mutes the
      // watcher for every file when the dev server runs from *inside* a
      // .yolo/ worktree (e.g. `PORT=5720 npm run dev` in `.yolo/claude-1`).
      ignored: [resolve(workspaceRoot, '.yolo/**'), resolve(workspaceRoot, '.intent/**')],
    },
  },
  // Vite defaults worker.format to 'iife', which collapses dynamic imports
  // (and any CSS modules they reach) into the worker's top-level IIFE.
  // The kernel-worker reaches `AlmostBashShell` via the shell barrel; its
  // `await import('@xterm/xterm/css/xterm.css')` inside `mount()` then
  // runs at worker boot under iife — `document.createElement` throws and
  // the worker never posts `kernel-worker-ready`. `es` keeps dynamic
  // imports split, so the CSS injection only runs if mount() is called.
  //
  // worker.plugins is NOT auto-derived from `plugins` in rolldown-vite — we
  // must re-pass the stub plugin so pi-coding-agent's Node-only modules get
  // replaced in the worker bundle too (otherwise `provider-settings` resolves
  // through to config.js at module load, and fileURLToPath() crashes).
  worker: {
    format: 'es',
    plugins: () => [stubPiNodeInternalsPlugin()],
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(Dirname, 'index.html'),
        cloud: resolve(Dirname, 'cloud/index.html'),
      },
    },
    // preview-sw and electron-overlay-entry are built separately via esbuild.
  },
}));
