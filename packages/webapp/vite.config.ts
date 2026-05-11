import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '../..');
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
const sliccReleasedAt = process.env['SLICC_RELEASED_AT'] ?? null;
const uiOutDir = resolve(workspaceRoot, 'dist/ui');
const previewSwEntry = resolve(__dirname, 'src/ui/preview-sw.ts');
const llmProxySwEntry = resolve(__dirname, 'src/ui/llm-proxy-sw.ts');
const electronOverlayEntry = resolve(__dirname, 'src/ui/electron-overlay-entry.ts');
const sliccEditorEntry = resolve(__dirname, 'src/ui/slicc-editor-entry.ts');
const sliccDiffEntry = resolve(__dirname, 'src/ui/slicc-diff-entry.ts');
const lucideIconsEntry = resolve(__dirname, 'src/ui/lucide-icons.ts');

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
          return resolve(__dirname, 'src/stubs/pi-session-manager-stub.ts');
        }
        if (source.endsWith('/config.js') || source === '../config.js') {
          return resolve(__dirname, 'src/stubs/pi-config-stub.ts');
        }
      }
      return undefined;
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: workspaceRoot,
  publicDir: resolve(workspaceRoot, 'packages/assets'),
  plugins: [
    stubPiNodeInternalsPlugin(),
    {
      name: 'build-webapp-runtime-assets',
      configureServer(server) {
        let cachedSwCode: string | null = null;
        let cachedSwMtime = 0;
        let cachedLlmSwCode: string | null = null;
        let cachedOverlayCode: string | null = null;
        let cachedOverlayMtime = 0;
        // Editor/diff/lucide IIFE bundles are always rebuilt in dev (no mtime cache)
        // because transitive imports wouldn't invalidate the entry file's mtime.

        server.middlewares.use('/preview-sw.js', async (_req, res) => {
          try {
            const { statSync } = await import('fs');
            const mtime = statSync(previewSwEntry).mtimeMs;

            if (!cachedSwCode || mtime > cachedSwMtime) {
              const esbuild = await import('esbuild');
              const result = await esbuild.build({
                entryPoints: [previewSwEntry],
                bundle: true,
                write: false,
                format: 'iife',
                target: 'esnext',
                define: { __DEV__: 'true', global: 'globalThis' },
              });
              cachedSwCode = result.outputFiles![0].text;
              cachedSwMtime = mtime;
            }

            res.setHeader('Content-Type', 'application/javascript');
            res.end(cachedSwCode);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[preview-sw-builder] Failed to build:', msg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`console.error('[preview-sw] Build failed: ${msg.replace(/'/g, "\\'")}');`);
          }
        });

        server.middlewares.use('/llm-proxy-sw.js', async (_req, res) => {
          try {
            // Rebuild on every request and key the cache off the
            // esbuild metafile's input list, not just the entry's
            // mtime. The SW imports `../shell/proxy-headers.ts` (and
            // could grow more deps), so an mtime-on-entry-only cache
            // would silently serve stale code whenever a transitive
            // dep changed. esbuild's incremental rebuilds are cheap
            // (~5ms) so we just always rebuild and let esbuild's own
            // file-content cache handle the heavy lifting.
            const esbuild = await import('esbuild');
            const result = await esbuild.build({
              entryPoints: [llmProxySwEntry],
              bundle: true,
              write: false,
              format: 'iife',
              target: 'esnext',
              define: { __DEV__: 'true', global: 'globalThis' },
            });
            cachedLlmSwCode = result.outputFiles![0].text;

            res.setHeader('Content-Type', 'application/javascript');
            // SW must be served at the root scope; instruct the browser
            // not to cache it so dev-mode rebuilds always reach the page.
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-store');
            res.end(cachedLlmSwCode);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[llm-proxy-sw-builder] Failed to build:', msg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`console.error('[llm-proxy-sw] Build failed: ${msg.replace(/'/g, "\\'")}');`);
          }
        });

        server.middlewares.use('/electron-overlay-entry.js', async (_req, res) => {
          try {
            const { statSync } = await import('fs');
            const mtime = statSync(electronOverlayEntry).mtimeMs;

            if (!cachedOverlayCode || mtime > cachedOverlayMtime) {
              const esbuild = await import('esbuild');
              const result = await esbuild.build({
                entryPoints: [electronOverlayEntry],
                bundle: true,
                write: false,
                format: 'iife',
                target: 'esnext',
                define: { __DEV__: 'true', global: 'globalThis' },
                plugins: [
                  {
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
                  },
                ],
              });
              cachedOverlayCode = result.outputFiles![0].text;
              cachedOverlayMtime = mtime;
            }

            res.setHeader('Content-Type', 'application/javascript');
            res.end(cachedOverlayCode);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[electron-overlay-entry] Failed to build:', msg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(
              `console.error('[electron-overlay-entry] Build failed: ${msg.replace(/'/g, "\\'")}');`
            );
          }
        });

        server.middlewares.use('/slicc-editor.js', async (_req, res) => {
          try {
            const esbuild = await import('esbuild');
            const result = await esbuild.build({
              entryPoints: [sliccEditorEntry],
              bundle: true,
              write: false,
              format: 'iife',
              target: 'esnext',
              define: { __DEV__: 'true', global: 'globalThis' },
            });
            res.setHeader('Content-Type', 'application/javascript');
            res.end(result.outputFiles![0].text);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[slicc-editor] Failed to build:', errMsg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`console.error('[slicc-editor] Build failed:', ${JSON.stringify(errMsg)});`);
          }
        });

        server.middlewares.use('/slicc-diff.js', async (_req, res) => {
          try {
            const esbuild = await import('esbuild');
            const result = await esbuild.build({
              entryPoints: [sliccDiffEntry],
              bundle: true,
              write: false,
              format: 'iife',
              target: 'esnext',
              define: { __DEV__: 'true', global: 'globalThis' },
              plugins: [pierreDiffsPlugin()],
            });
            res.setHeader('Content-Type', 'application/javascript');
            res.end(result.outputFiles![0].text);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[slicc-diff] Failed to build:', errMsg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`console.error('[slicc-diff] Build failed:', ${JSON.stringify(errMsg)});`);
          }
        });

        // Note: `src/kernel/kernel-worker.ts` is loaded via Vite's
        // native `new Worker(new URL('./kernel-worker.ts',
        // import.meta.url), { type: 'module' })` pattern in
        // `kernel/spawn.ts`. Vite handles dev serving and production
        // bundling through the same Rollup pipeline that resolves
        // `resolve.alias` and the `stub-pi-node-internals` resolveId
        // plugin — no dev middleware or closeBundle entry needed.

        server.middlewares.use('/lucide-icons.js', async (_req, res) => {
          try {
            const esbuild = await import('esbuild');
            const result = await esbuild.build({
              entryPoints: [lucideIconsEntry],
              bundle: true,
              write: false,
              format: 'iife',
              target: 'esnext',
              define: { __DEV__: 'true', global: 'globalThis' },
            });
            res.setHeader('Content-Type', 'application/javascript');
            res.end(result.outputFiles![0].text);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[lucide-icons] Failed to build:', errMsg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`console.error('[lucide-icons] Build failed:', ${JSON.stringify(errMsg)});`);
          }
        });
      },
      async closeBundle() {
        // Keep this config focused on production build artifacts; node-server owns dev serving.
        // Rollup would code-split LightningFS into a shared chunk, which SWs can't import.
        const esbuild = await import('esbuild');
        const { copyFileSync } = await import('fs');
        await esbuild.build({
          entryPoints: [previewSwEntry],
          bundle: true,
          outfile: resolve(uiOutDir, 'preview-sw.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });

        // LLM-proxy SW — root-scope, intercepts cross-origin LLM fetches
        // and reroutes them through /api/fetch-proxy in CLI mode.
        await esbuild.build({
          entryPoints: [llmProxySwEntry],
          bundle: true,
          outfile: resolve(uiOutDir, 'llm-proxy-sw.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });

        // Electron reinjection still needs a standalone production bundle.
        await esbuild.build({
          entryPoints: [electronOverlayEntry],
          bundle: true,
          outfile: resolve(uiOutDir, 'electron-overlay-entry.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
          plugins: [
            {
              name: 'raw-svg',
              setup(build) {
                // Strip ?raw suffix and load .svg files as text (matches Vite's ?raw behavior).
                build.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({
                  path: resolve(args.resolveDir, args.path.replace('?raw', '')),
                  namespace: 'raw-svg',
                }));
                build.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async (args) => {
                  const { readFile } = await import('fs/promises');
                  return { contents: await readFile(args.path, 'utf8'), loader: 'text' };
                });
              },
            },
          ],
        });

        // <slicc-editor> custom element bundle for sprinkle iframes.
        await esbuild.build({
          entryPoints: [sliccEditorEntry],
          bundle: true,
          outfile: resolve(uiOutDir, 'slicc-editor.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });

        // <slicc-diff> custom element bundle for sprinkle iframes.
        await esbuild.build({
          entryPoints: [sliccDiffEntry],
          bundle: true,
          outfile: resolve(uiOutDir, 'slicc-diff.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
          plugins: [pierreDiffsPlugin()],
        });

        // Lucide icons bundle for sprinkle iframes.
        await esbuild.build({
          entryPoints: [lucideIconsEntry],
          bundle: true,
          outfile: resolve(uiOutDir, 'lucide-icons.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });

        // Note: `kernel-worker.ts` rides the Rollup pipeline via
        // Vite's native `new Worker(new URL(...), { type: 'module' })`
        // detection in `kernel/spawn.ts`. `resolve.alias` carries over
        // to the worker bundle, but `plugins` does NOT — see the
        // `worker.plugins` block below where we re-pass the stub plugin.
        // No standalone esbuild call needed.
        copyFileSync(
          resolve(__dirname, '../assets/logos/favicon.png'),
          resolve(uiOutDir, 'favicon.png')
        );
        // Vite preserves the nested HTML path when the repo root is the Vite root.
        // In some Vite versions the HTML lands directly at outDir root — only copy if nested.
        const { existsSync } = await import('fs');
        const nestedHtml = resolve(uiOutDir, 'packages/webapp/index.html');
        if (existsSync(nestedHtml)) {
          copyFileSync(nestedHtml, resolve(uiOutDir, 'index.html'));
        }
      },
    },
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
      // Workspace `@slicc/shared` points at source so Vite's worker bundle
      // (kernel-worker via `new Worker(new URL(...))` in spawn.ts) resolves
      // without requiring `packages/shared/dist/` to exist at build time.
      // node-server's runtime still consumes the built dist/ via the
      // package's exports.default.
      '@slicc/shared': resolve(workspaceRoot, 'packages/shared/src/index.ts'),
      // Buffer polyfill for isomorphic-git (browser compatibility)
      buffer: 'buffer/',
      // The pinned isomorphic-git package resolves "." to index.cjs, and that
      // CJS entry imports Node crypto. Force the browser-safe ESM entry
      // instead.
      'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),
      // just-bash's browser bundle references node:zlib and node:module for
      // gzip/gunzip commands that aren't functional in browsers anyway.
      // Alias to empty stubs so the bundled JS never tries to fetch them.
      'node:zlib': resolve(__dirname, 'src/shims/empty.ts'),
      'node:module': resolve(__dirname, 'src/shims/empty.ts'),
      // @smithy/node-http-handler imports named exports from Node builtins
      // (without node: prefix). Vite's browser-external can't provide named
      // exports, so alias to stubs with the required exports.
      stream: resolve(__dirname, 'src/shims/stream.ts'),
      http: resolve(__dirname, 'src/shims/http.ts'),
      https: resolve(__dirname, 'src/shims/https.ts'),
      http2: resolve(__dirname, 'src/shims/http2.ts'),
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
    dedupe: ['@earendil-works/pi-ai'],
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
  // The kernel-worker reaches `WasmShell` via the shell barrel; its
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
      input: resolve(__dirname, 'index.html'),
    },
    // preview-sw and electron-overlay-entry are built separately via esbuild.
  },
}));
