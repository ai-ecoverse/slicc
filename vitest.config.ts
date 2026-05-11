import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const webappDir = resolve(__dirname, 'packages/webapp');
const workspaceRoot = __dirname;
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};

const baseCoverageExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/tests/**',
  '**/*.d.ts',
  '**/*.config.{ts,js,mjs}',
  '**/types.ts',
  '**/index.html',
  '**/shims/**',
  'packages/*/src/**/*.test.ts',
];

export default defineConfig({
  resolve: {
    alias: {
      // Workspace `@slicc/shared-ts` — resolve to source so tests do not require
      // `packages/shared-ts/dist/` to exist. All four vitest projects inherit
      // this via `extends: true`. The package's exports.types already
      // points at src; this matches the runtime side under vitest.
      '@slicc/shared-ts': resolve(workspaceRoot, 'packages/shared-ts/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      exclude: baseCoverageExclude,
      // Default thresholds enforced when running `npm run test:coverage`
      // across the full repo. Per-package scripts (e.g. `test:coverage:*`)
      // run `vitest --project <name>` and tighten the thresholds to each
      // package's actual baseline. CI runs the per-package scripts so a
      // regression in one package fails CI even when the cross-repo
      // aggregate would still pass.
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 50,
        branches: 40,
      },
    },
    projects: [
      {
        extends: true,
        define: {
          __DEV__: 'true',
          __SLICC_VERSION__: JSON.stringify(rootPkg.version),
          __SLICC_RELEASED_AT__: 'null',
          global: 'globalThis',
        },
        resolve: {
          alias: {
            buffer: 'buffer/',
            // The pinned isomorphic-git package resolves "." to index.cjs, and
            // that CJS entry imports Node crypto. Force the browser-safe ESM
            // entry instead.
            'isomorphic-git': resolve(workspaceRoot, 'node_modules/isomorphic-git/index.js'),
            'node:zlib': resolve(webappDir, 'src/shims/empty.ts'),
            'node:module': resolve(webappDir, 'src/shims/empty.ts'),
            stream: resolve(webappDir, 'src/shims/stream.ts'),
            http: resolve(webappDir, 'src/shims/http.ts'),
            https: resolve(webappDir, 'src/shims/https.ts'),
            http2: resolve(webappDir, 'src/shims/http2.ts'),
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
          name: 'shared',
          include: ['packages/shared-ts/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        define: {
          // Extension code transitively imports webapp modules (e.g.
          // offscreen-bridge → tray-leader → core/logger), which read
          // __DEV__ at module load. Without this, those tests fail to
          // import with `ReferenceError: __DEV__ is not defined`.
          __DEV__: 'true',
        },
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
