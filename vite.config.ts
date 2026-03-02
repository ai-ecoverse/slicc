/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: '.',
  define: {
    __DEV__: JSON.stringify(mode !== 'production'),
  },
  resolve: {
    alias: {
      // just-bash's browser bundle references node:zlib and node:module for
      // gzip/gunzip commands that aren't functional in browsers anyway.
      // Alias to empty stubs so the bundled JS never tries to fetch them.
      'node:zlib': resolve(__dirname, 'src/shims/empty.ts'),
      'node:module': resolve(__dirname, 'src/shims/empty.ts'),
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
  },
  server: {
    port: 3000,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
