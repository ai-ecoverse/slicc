import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const webappDir = resolve(__dirname, 'packages/webapp');
const workspaceRoot = __dirname;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        define: {
          __DEV__: 'true',
          global: 'globalThis',
        },
        resolve: {
          alias: {
            buffer: 'buffer/',
            // The pinned isomorphic-git package resolves "." to index.cjs, and
            // that CJS entry imports Node crypto. Force the browser-safe ESM
            // entry instead.
            'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),
            // Match the Vite-time alias in packages/webapp/vite.config.ts so
            // vitest resolves `just-bash` to the vendored browser bundle that
            // exposes the AST parser surface.
            'just-bash': resolve(webappDir, 'src/vendor/just-bash/dist/bundle/browser.js'),
            'node:zlib': resolve(webappDir, 'src/shims/empty.ts'),
            'node:module': resolve(webappDir, 'src/shims/empty.ts'),
            stream: resolve(webappDir, 'src/shims/stream.ts'),
            http: resolve(webappDir, 'src/shims/http.ts'),
            https: resolve(webappDir, 'src/shims/https.ts'),
            http2: resolve(webappDir, 'src/shims/http2.ts'),
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
        },
        test: {
          name: 'webapp',
          include: ['packages/webapp/tests/**/*.test.ts'],
          exclude: [
            'packages/webapp/tests/integration/**/*.test.ts',
            'packages/webapp/tests/e2e/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'node-server',
          include: ['packages/node-server/tests/**/*.test.ts'],
          exclude: ['packages/node-server/tests/integration/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'chrome-extension',
          include: ['packages/chrome-extension/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'cloudflare-worker',
          include: ['packages/cloudflare-worker/tests/**/*.test.ts'],
        },
      },
    ],
  },
});
