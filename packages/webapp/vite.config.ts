import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { stripBiomeWasmAssetPlugin } from './vite-plugins/strip-biome-wasm-asset';
import { stripFfmpegCoreCdnLiteralPlugin } from './vite-plugins/strip-ffmpeg-core-cdn-literal';
import { stripOrtWasmAssetPlugin } from './vite-plugins/strip-ort-wasm-asset';

const Dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(Dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
// The webapp's own manifest is the single source of truth for the wasm
// dependency versions baked into the bundle (see `wasmDepVersion`). Renovate
// bumps the package.json entry; Vite `define` injects it; the wasm-wrapping
// commands derive their `ipk add <pkg>@<version>` guidance + version guards
// from the injected constant — no hand-maintained version literal to drift.
const webappPkg = JSON.parse(readFileSync(resolve(Dirname, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
/** Exact version a wasm dep is pinned to in webapp/package.json (range-prefix stripped). */
function wasmDepVersion(name: string): string {
  const spec = webappPkg.dependencies?.[name] ?? webappPkg.devDependencies?.[name];
  if (!spec) throw new Error(`webapp package.json is missing a version for ${name}`);
  return spec.replace(/^[\^~]/, '');
}
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;
const uiOutDir = resolve(workspaceRoot, 'dist/ui');
const previewSwEntry = resolve(Dirname, 'src/ui/preview-sw.ts');
const llmProxySwEntry = resolve(Dirname, 'src/ui/llm-proxy-sw.ts');
// The overlay bootstrap source lives in the self-contained @ai-ecoverse/spoon
// package (its launcher + glue are what node/swift embed). The webapp still
// emits/serves `dist/ui/electron-overlay-entry.js` from it so the hosted origin
// and the local dist artifact stay in sync; spoon's own build emits the same
// file for the swift-launcher CI path.
const electronOverlayEntry = resolve(workspaceRoot, 'packages/spoon/src/overlay-entry.ts');
const sliccEditorEntry = resolve(Dirname, 'src/ui/slicc-editor-entry.ts');
const sliccDiffEntry = resolve(Dirname, 'src/ui/slicc-diff-entry.ts');
const lucideIconsEntry = resolve(Dirname, 'src/ui/lucide-icons.ts');

/**
 * Vite plugin: serve `@pierre/diffs` a curated Shiki language bundle.
 *
 * `@pierre/diffs` imports `bundledLanguages` from `shiki`, i.e. all 332
 * grammars. Rolldown code-splits every one, so they are fetched lazily but
 * still SHIPPED — ~10 MB over the total-JS-payload budget. `src/shims/
 * shiki-bundle.ts` re-exports Shiki's `bundle/web` subset plus the languages
 * this repo is written in.
 *
 * Matching is exact: `shiki/bundle/web`, `shiki/langs/*`, `shiki/core` and the
 * engine subpaths must keep resolving to the real package, or the shim would
 * recurse into itself.
 */
function curatedShikiBundlePlugin() {
  return {
    name: 'curated-shiki-bundle',
    enforce: 'pre' as const,
    resolveId(source: string) {
      return source === 'shiki' ? resolve(Dirname, 'src/shims/shiki-bundle.ts') : undefined;
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

/**
 * Vite plugin (WORKER BUILD ONLY): replace the page-realm speech modules with
 * throwing stubs.
 *
 * `say` / `hear` keep their local (page) and bridged (worker) branches in one
 * module, so the worker build emitted the local branch too — `kokoro-js` +
 * `@huggingface/transformers`, ~1.8 MB of chunks the page graph already ships,
 * unreachable in a worker (the local branch is gated on `speechSynthesis`,
 * which a DedicatedWorker does not have). Vite builds the worker as a separate
 * Rollup graph, so those bytes were a straight second copy.
 *
 * Pass this to `worker.plugins` ONLY — in the page build the real modules must
 * resolve.
 */
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

/**
 * Sprinkle-facing custom-element bundles that ride the app's Rollup graph.
 *
 * Key is the stable filename sprinkles load (`<script src="/slicc-diff.js">`);
 * value is the entry's path relative to the Vite root, i.e. its key in
 * `.vite/manifest.json`.
 */
const SPRINKLE_ENTRY_SHIMS: Record<string, string> = {
  'slicc-editor.js': 'packages/webapp/src/ui/slicc-editor-entry.ts',
  'slicc-diff.js': 'packages/webapp/src/ui/slicc-diff-entry.ts',
};

/**
 * The loader shim body: a classic script that dynamic-imports `target`,
 * resolved against the shim's OWN url (not the document base, which is the
 * sprinkle's srcdoc). The load promise is parked on
 * `window.__SLICC_SPRINKLE_ASSETS__[name]` so a sprinkle can await the element
 * definition before calling a method on it.
 */
function sprinkleShimSource(stableName: string, target: string): string {
  return `(function(){var s=document.currentScript;var b=s&&s.src?s.src:location.href;var u=new URL(${JSON.stringify(
    target
  )},b).href;var p=import(u);p.catch(function(e){console.error('[${stableName}] failed to load',e)});var g=window.__SLICC_SPRINKLE_ASSETS__||(window.__SLICC_SPRINKLE_ASSETS__={});g[${JSON.stringify(
    stableName
  )}]=p;})();\n`;
}

/**
 * Emit the stable-name loader shims for the sprinkle custom-element bundles.
 *
 * These used to be standalone esbuild IIFEs, which meant a second, EAGER copy
 * of everything they touch: `slicc-diff.js` alone was 5.8 MB, 5.1 MB of it the
 * curated Shiki grammar set that the app's own Rollup graph already ships as
 * lazy chunks (esbuild inlines dynamic imports; Rollup code-splits them).
 * Building them as Rollup entries instead makes those chunks shared.
 *
 * The shim keeps the stable URL contract: a classic script (so `<script src>`
 * consumers in `sprinkle-renderer.ts` are unchanged) that dynamic-imports the
 * hashed ES entry. It resolves the URL from its OWN src, not the document base,
 * so it works in a srcdoc iframe and off a non-root base path. `window
 * .__SLICC_SPRINKLE_ASSETS__[name]` exposes the load promise for sprinkles that
 * need to await the element definition.
 *
 * Loading is therefore async where the IIFE was synchronous. Both custom
 * elements adopt pre-upgrade properties (`upgradeOwnProperties`), so the
 * documented `el.patch = …` / `el.value = …` patterns still apply — that race
 * already existed on the inline-sprinkle path, which appended the script tag
 * asynchronously.
 */
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

  // <slicc-editor> / <slicc-diff> are NOT built here anymore — they ride the
  // Rollup graph as extra entries (see `build.rollupOptions.input`) so their
  // heavy dependencies are the SAME chunks the app already ships. What lands in
  // dist/ui under the stable names sprinkles reference is a loader shim.
  await writeSprinkleEntryShims();

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
        use: (
          path: string,
          handler: (req: unknown, res: import('node:http').ServerResponse) => void | Promise<void>
        ) => void;
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
      // The sprinkle element bundles are Rollup entries in production, reached
      // through a loader shim. Dev serves the same shape — a classic script
      // that dynamic-imports the entry module off the dev server — so the
      // async load order sprinkles see is identical in both.
      for (const [stableName, entry] of Object.entries(SPRINKLE_ENTRY_SHIMS)) {
        server.middlewares.use(`/${stableName}`, (_req, res) => {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(sprinkleShimSource(stableName, `/${entry}`));
        });
      }
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

/**
 * Module aliases: browser-safe replacements for Node-only entries, plus the
 * deep imports whose packages do not expose them in an exports map.
 */
const MODULE_ALIASES: Record<string, string> = {
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
  // Deep import into pi-coding-agent's tool-output truncation utility — same
  // reason as compaction above: the main entry drags Node-only modules, but
  // truncate.js is pure string/Buffer ops (browser-safe). The bash tool
  // re-uses it to stay converged with pi's output-bounding contract (#2009).
  '@earendil-works/pi-coding-agent/dist/core/tools/truncate.js': resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js'
  ),
  // `slicc-diff-entry.ts` registers `<diffs-container>` from a path that is
  // NOT in @pierre/diffs' exports map. esbuild resolved it straight off
  // disk; Rollup enforces the map, so point it at the file explicitly now
  // that the entry rides the Vite build.
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
    buildWebappRuntimeAssetsPlugin(),
    // Sanitize the unpkg ffmpeg-core URL literal that @ffmpeg/ffmpeg bakes
    // into its wrapper-worker chunk. Same plugin the extension config uses
    // against dist/extension/ — runs in closeBundle after every other plugin
    // (including the esbuild closeBundle hooks above) has written output.
    stripFfmpegCoreCdnLiteralPlugin(),
  ],
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
    __SLICC_VERSION__: JSON.stringify(rootPkg.version),
    __SLICC_RELEASED_AT__: JSON.stringify(sliccReleasedAt),
    // Per-build stamp inlined into every chunk that references it (page
    // AND kernel-worker graphs). A deploy landing mid-session can leave
    // stale HTML running page chunks from build N while the worker's
    // hashed import graph resolves to build N±1 — both servable via the
    // R2 asset archive, so the mixed graph loads silently. Comparing the
    // page's inlined copy against the worker's on the boot handshake
    // detects that drift (#1983). One evaluation per config load: a
    // single build (or dev-server run) stamps both realms identically.
    __SLICC_BUILD_ID__: JSON.stringify(`${rootPkg.version}-${Date.now().toString(36)}`),
    // Wasm dependency versions baked from webapp/package.json so the
    // ipk-wrapping commands (convert/magick, biome, ffmpeg) derive their
    // install guidance + version guards from the pinned dep instead of a literal.
    __MAGICK_WASM_VERSION__: JSON.stringify(wasmDepVersion('@imagemagick/magick-wasm')),
    __BIOME_WASM_WEB_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/wasm-web')),
    __BIOME_JS_API_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/js-api')),
    __FFMPEG_CORE_VERSION__: JSON.stringify(wasmDepVersion('@ffmpeg/core')),
    // Buffer polyfill for isomorphic-git
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
    // Pre-bundle magick-wasm's JS glue so the kernel worker's dynamic
    // `import('@imagemagick/magick-wasm')` (magick-wasm.ts → convert /
    // image-processor) resolves under Vite dev middleware. Without it the
    // worker-side dynamic import never settles in dev and `convert` hangs;
    // the WASM binary itself still loads from the VFS ipk install.
    include: ['@imagemagick/magick-wasm'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    // Dev parity with the worker's `serveSPA` (#2036): the leader document is
    // cross-origin isolated via Document-Isolation-Policy in production, so
    // `npm run dev` must match or SAB-dependent paths (vpod --net) diverge.
    headers: {
      'Document-Isolation-Policy': 'isolate-and-credentialless',
    },
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
    plugins: () => [
      curatedShikiBundlePlugin(),
      stubPiNodeInternalsPlugin(),
      stubPageRealmSpeechPlugin(),
    ],
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    target: 'esnext',
    // The sprinkle custom-element bundles are emitted with the app's own
    // chunk graph (see `writeSprinkleEntryShims`), so the manifest is what maps
    // their stable names to the hashed entry files.
    manifest: true,
    rollupOptions: {
      input: {
        main: resolve(Dirname, 'index.html'),
        cloud: resolve(Dirname, 'cloud/index.html'),
        'slicc-editor': sliccEditorEntry,
        'slicc-diff': sliccDiffEntry,
      },
    },
    // preview-sw and electron-overlay-entry are built separately via esbuild.
  },
}));
