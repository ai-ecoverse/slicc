import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '../..');
const uiOutDir = resolve(workspaceRoot, 'dist/ui');
const previewSwEntry = resolve(__dirname, 'src/ui/preview-sw.ts');
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

export default defineConfig(({ mode }) => ({
  root: workspaceRoot,
  publicDir: resolve(workspaceRoot, 'packages/assets'),
  plugins: [
    {
      name: 'stub-pi-node-internals',
      enforce: 'pre' as const,
      // pi-coding-agent's compaction.js uses relative imports that pull in
      // Node-only code. session-manager.js needs fs/crypto/path/url, and
      // config.js calls fileURLToPath(import.meta.url) at the top level.
      // Vite resolve.alias can't intercept relative imports inside
      // node_modules, so we use a resolveId hook instead.
      resolveId(source, importer) {
        const normalizedImporter = importer?.replace(/\\/g, '/');
        if (normalizedImporter?.includes('@mariozechner/pi-coding-agent')) {
          if (source.endsWith('/session-manager.js')) {
            return resolve(__dirname, 'src/stubs/pi-session-manager-stub.ts');
          }
          if (source.endsWith('/config.js') || source === '../config.js') {
            return resolve(__dirname, 'src/stubs/pi-config-stub.ts');
          }
        }
      },
    },
    {
      name: 'build-webapp-runtime-assets',
      configureServer(server) {
        let cachedSwCode: string | null = null;
        let cachedSwMtime = 0;
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
    // Buffer polyfill for isomorphic-git
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Buffer polyfill for isomorphic-git (browser compatibility)
      buffer: 'buffer/',
      // The pinned isomorphic-git package resolves "." to index.cjs, and that
      // CJS entry imports Node crypto. Force the browser-safe ESM entry
      // instead.
      'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),
      // Use the vendored just-bash browser bundle (see
      // packages/webapp/src/vendor/just-bash/README.md). The vendored copy
      // patches src/browser.ts to additionally export the AST parser surface
      // (parse, Parser, ParseException, ScriptNode, AST node types, etc.)
      // that is physically bundled at runtime but not re-exported from the
      // published browser entry point. Delete this alias and the vendor
      // directory once the upstream PR lands in a published release.
      'just-bash': resolve(__dirname, 'src/vendor/just-bash/dist/bundle/browser.js'),
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
      // The compaction submodule only depends on @mariozechner/pi-ai (browser-safe).
      '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        workspaceRoot,
        'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js'
      ),
      '@mariozechner/pi-ai/dist/providers/transform-messages.js': resolve(
        workspaceRoot,
        'node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js'
      ),
      '@mariozechner/pi-ai/dist/providers/simple-options.js': resolve(
        workspaceRoot,
        'node_modules/@mariozechner/pi-ai/dist/providers/simple-options.js'
      ),
    },
    dedupe: ['@mariozechner/pi-ai'],
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@mariozechner/pi-coding-agent'],
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
