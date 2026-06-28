import { readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

const webappDir = resolve(__dirname, 'packages/webapp');
const workspaceRoot = __dirname;
const rootPkg = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8')) as {
  version: string;
};
// Mirror the wasm version `define`s from packages/webapp/vite.config.ts so
// modules that read them at import time resolve under vitest too.
const webappPkg = JSON.parse(readFileSync(resolve(webappDir, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
function wasmDepVersion(name: string): string {
  const spec = webappPkg.dependencies?.[name] ?? webappPkg.devDependencies?.[name];
  if (!spec) throw new Error(`webapp package.json is missing a version for ${name}`);
  return spec.replace(/^[\^~]/, '');
}
const wasmVersionDefines = {
  __MAGICK_WASM_VERSION__: JSON.stringify(wasmDepVersion('@imagemagick/magick-wasm')),
  __BIOME_WASM_WEB_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/wasm-web')),
  __BIOME_JS_API_VERSION__: JSON.stringify(wasmDepVersion('@biomejs/js-api')),
  __FFMPEG_CORE_VERSION__: JSON.stringify(wasmDepVersion('@ffmpeg/core')),
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
          ...wasmVersionDefines,
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
          setupFiles: ['packages/webapp/tests/closeevent-polyfill.ts'],
          // The boot path (wc-boot.test.ts) dynamically imports kernel
          // modules whose intentionally-throwing test transport logs on
          // fire-and-forget async catch-paths that resolve after the test
          // file finishes. Vitest's console interceptor then queues an
          // `onUserConsoleLog` RPC that races worker teardown, surfacing as
          // a nondeterministic `EnvironmentTeardownError`. Disabling the
          // intercept removes that RPC without changing test behavior.
          disableConsoleIntercept: true,
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
          // The extension build defines __SLICC_EXT_DEV__ from the
          // SLICC_EXT_DEV env var (see vite.config.ts). Tests default to
          // the production value (`false`) so module-level constants
          // resolve to hosted URLs; resolver helpers are exercised in
          // both modes through their parameterized API.
          __SLICC_EXT_DEV__: 'false',
          // Extension tests transitively import webapp modules; keep the
          // wasm version constants defined so those imports don't throw.
          ...wasmVersionDefines,
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
      {
        extends: true,
        test: {
          name: 'cloud-core',
          include: ['packages/cloud-core/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'cherry',
          environment: 'jsdom',
          include: ['packages/cherry/tests/**/*.test.ts'],
        },
      },
      {
        // Repo-level tooling under packages/dev-tools/ (plain .mjs, not a
        // workspace). Co-located *.test.mjs so `npm test` covers the triage
        // logic; no per-package coverage gate applies to this project.
        extends: true,
        test: {
          name: 'dev-tools',
          include: ['packages/dev-tools/**/*.test.mjs'],
        },
      },
      {
        // swift-launcher's package `test` script runs `swift test`; its plain
        // .mjs assembly helpers (assemble-app.mjs and friends) have no Swift
        // coverage, so co-located *.test.mjs run under this dedicated project.
        extends: true,
        test: {
          name: 'swift-launcher',
          include: ['packages/swift-launcher/*.test.mjs'],
        },
      },
    ],
  },
});
