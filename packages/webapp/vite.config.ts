/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '../..');
const uiOutDir = resolve(workspaceRoot, 'dist/ui');
const previewSwEntry = resolve(__dirname, 'src/ui/preview-sw.ts');
const electronOverlayEntry = resolve(__dirname, 'src/ui/electron-overlay-entry.ts');

export default defineConfig(({ mode }) => ({
  root: workspaceRoot,
  publicDir: resolve(workspaceRoot, 'packages/assets'),
  plugins: [
    {
      name: 'build-webapp-runtime-assets',
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
        });

        copyFileSync(resolve(__dirname, '../assets/logos/favicon.png'), resolve(uiOutDir, 'favicon.png'));
        // Vite preserves the nested HTML path when the repo root is the Vite root.
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
      'node:zlib': resolve(__dirname, 'src/shims/empty.ts'),
      'node:module': resolve(__dirname, 'src/shims/empty.ts'),
      // @smithy/node-http-handler imports named exports from Node builtins
      // (without node: prefix). Vite's browser-external can't provide named
      // exports, so alias to stubs with the required exports.
      'stream': resolve(__dirname, 'src/shims/stream.ts'),
      'http': resolve(__dirname, 'src/shims/http.ts'),
      'https': resolve(__dirname, 'src/shims/https.ts'),
      'http2': resolve(__dirname, 'src/shims/http2.ts'),
      // Deep import into pi-coding-agent's compaction submodule — the main entry
      // re-exports 113 Node-only modules that break Vite's browser bundle.
      // The compaction submodule only depends on @mariozechner/pi-ai (browser-safe).
      '@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js': resolve(
        workspaceRoot,
        'node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js',
      ),
      '@mariozechner/pi-ai/dist/utils/overflow.js': resolve(
        workspaceRoot,
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
      input: resolve(__dirname, 'index.html'),
    },
    // preview-sw and electron-overlay-entry are built separately via esbuild.
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'packages/node-server/tests/integration/**/*.test.ts'],
  },
}));
