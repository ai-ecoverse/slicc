/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let uiOutDir = resolve(__dirname, 'dist/ui');

export default defineConfig(({ mode }) => ({
  root: '.',
  publicDir: 'packages/assets/public',
  plugins: [
    {
      name: 'preview-sw-builder',
      configResolved(config) {
        uiOutDir = resolve(config.root, config.build.outDir);
      },
      configureServer(server) {
        // Dev mode: serve the SW as a fully bundled IIFE via esbuild.
        // SWs can't use ES imports (they don't go through Vite's module resolver).
        let cachedCode: string | null = null;
        let cachedMtime = 0;
        const swPath = resolve(__dirname, 'packages/webapp/src/ui/preview-sw.ts');
        let cachedOverlayCode: string | null = null;
        let cachedOverlayMtime = 0;
        const overlayEntryPath = resolve(__dirname, 'packages/webapp/src/ui/electron-overlay-entry.ts');

        server.middlewares.use('/preview-sw.js', async (_req, res) => {
          try {
            const { statSync } = await import('fs');
            const mtime = statSync(swPath).mtimeMs;

            if (!cachedCode || mtime > cachedMtime) {
              const esbuild = await import('esbuild');
              const result = await esbuild.build({
                entryPoints: [swPath],
                bundle: true,
                write: false,
                format: 'iife',
                target: 'esnext',
                define: { __DEV__: 'true', global: 'globalThis' },
              });
              cachedCode = result.outputFiles![0].text;
              cachedMtime = mtime;
            }

            res.setHeader('Content-Type', 'application/javascript');
            res.end(cachedCode);
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
            const mtime = statSync(overlayEntryPath).mtimeMs;

            if (!cachedOverlayCode || mtime > cachedOverlayMtime) {
              const esbuild = await import('esbuild');
              const result = await esbuild.build({
                entryPoints: [overlayEntryPath],
                bundle: true,
                write: false,
                format: 'iife',
                target: 'esnext',
                define: { __DEV__: 'true', global: 'globalThis' },
              });
              cachedOverlayCode = result.outputFiles![0].text;
              cachedOverlayMtime = mtime;
            }

            res.setHeader('Content-Type', 'application/javascript');
            res.end(cachedOverlayCode);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[electron-overlay-builder] Failed to build:', msg);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/javascript');
            res.end(`console.error('[electron-overlay] Build failed: ${msg.replace(/'/g, "\\'")}');`);
          }
        });
      },
      async closeBundle() {
        // Production: build the SW as a self-contained IIFE via esbuild.
        // Rollup would code-split LightningFS into a shared chunk, which SWs can't import.
        const esbuild = await import('esbuild');
        const { copyFileSync } = await import('fs');
        await esbuild.build({
          entryPoints: [resolve(__dirname, 'packages/webapp/src/ui/preview-sw.ts')],
          bundle: true,
          outfile: resolve(uiOutDir, 'preview-sw.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });
        await esbuild.build({
          entryPoints: [resolve(__dirname, 'packages/webapp/src/ui/electron-overlay-entry.ts')],
          bundle: true,
          outfile: resolve(uiOutDir, 'electron-overlay-entry.js'),
          format: 'iife',
          target: 'esnext',
          minify: true,
          define: { __DEV__: 'false', global: 'globalThis' },
        });
        copyFileSync(resolve(uiOutDir, 'packages/webapp/index.html'), resolve(uiOutDir, 'index.html'));
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
      // just-bash's browser bundle references node:zlib and node:module for
      // gzip/gunzip commands that aren't functional in browsers anyway.
      // Alias to empty stubs so the bundled JS never tries to fetch them.
      'node:zlib': resolve(__dirname, 'packages/webapp/src/shims/empty.ts'),
      'node:module': resolve(__dirname, 'packages/webapp/src/shims/empty.ts'),
      // @smithy/node-http-handler imports named exports from Node builtins
      // (without node: prefix). Vite's browser-external can't provide named
      // exports, so alias to stubs with the required exports.
      'stream': resolve(__dirname, 'packages/webapp/src/shims/stream.ts'),
      'http': resolve(__dirname, 'packages/webapp/src/shims/http.ts'),
      'https': resolve(__dirname, 'packages/webapp/src/shims/https.ts'),
      'http2': resolve(__dirname, 'packages/webapp/src/shims/http2.ts'),
      // Deep import into pi-coding-agent's compaction submodule — the main entry
      // re-exports 113 Node-only modules that break Vite's browser bundle.
      // The compaction submodule only depends on @mariozechner/pi-ai (browser-safe).
      '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        __dirname,
        'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js',
      ),
      '@mariozechner/pi-ai/dist/utils/overflow.js': resolve(
        __dirname,
        'node_modules/@mariozechner/pi-ai/dist/utils/overflow.js',
      ),
    },
  },
  esbuild: {
    target: 'esnext',
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: resolve(__dirname, 'packages/webapp/index.html'),
    },
    // preview-sw is built separately via esbuild (SWs need self-contained bundles)
  },
  server: {
    port: 5710,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'packages/node-server/tests/integration/**/*.test.ts'],
  },
}));
