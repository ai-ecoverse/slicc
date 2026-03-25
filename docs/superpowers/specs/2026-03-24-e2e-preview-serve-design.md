# E2E Testing: Preview Service Worker & Project Serve Mode

## Problem

The preview service worker (`preview-sw.ts`) and its project serve mode (`?projectRoot=`) have zero automated test coverage. The serve command tests verify URL construction, and shared utility tests verify path helpers, but the actual SW behavior — fetch interception, VFS file serving, project root resolution, and the `isSliccAppPath` safety exclusion — is only manually verified.

The `isSliccAppPath` exclusion is particularly high-risk: if it breaks, project serve mode hijacks the app's own assets and the UI goes blank with no obvious error.

## Approach

Playwright e2e tests against a production-built Slicc server. Self-contained — the test harness starts and stops the server.

### Why Playwright + production build

- Tests the same artifact that ships.
- The preview SW requires a real browser (service worker registration, IndexedDB, fetch interception).
- Playwright's `webServer` config handles server lifecycle.
- No new runtime dependencies — Playwright is a devDependency for testing only.

## Design

### File structure

```
packages/webapp/tests/e2e/
  playwright.config.ts       # Playwright config with webServer directive
  preview-serve.test.ts      # Test suite (~10 tests)
  helpers.ts                 # VFS seeding + SW readiness utilities
```

### Test harness

Playwright's `webServer` config spawns `node dist/node-server/index.js` on port 5780 (dedicated e2e port, avoids dev conflicts). `reuseExistingServer: !process.env.CI` allows running against an already-started server during local dev.

```ts
// playwright.config.ts
export default defineConfig({
  webServer: {
    command: `node ${resolve(repoRoot, 'dist/node-server/index.js')} --serve-only`,
    port: 5780,
    reuseExistingServer: !process.env.CI,
    env: { PORT: '5780' },
  },
  use: { baseURL: 'http://localhost:5780' },
  fullyParallel: true,
});
```

The `--serve-only` flag skips Chrome launch (the test server only needs to serve static assets and API endpoints — Playwright provides its own browser). The command uses an absolute path resolved from the repo root to avoid relative path ambiguity in worktrees.

npm script: `"test:e2e": "npx playwright test --config packages/webapp/tests/e2e/playwright.config.ts"`

Prerequisite: `npm run build` must have run first (the server command requires `dist/node-server/` and `dist/ui/` to exist). Port 5780 is arbitrary — chosen to avoid conflict with the default 5710 dev port. In CI, each run starts a fresh server. Locally, `reuseExistingServer` skips spawn if a server is already listening, speeding up iteration.

### VFS seeding

Inject `lightning-fs.min.js` via `page.addScriptTag()` (pre-built UMD browser bundle from `node_modules`, resolved via `require.resolve`). This puts `LightningFS` on the global scope. Then `page.evaluate()` creates an FS instance on `slicc-fs` (same IDB the SW reads from) and writes test files. E2E tests seed IndexedDB directly — they do not exercise the BroadcastChannel fallback path used for mounted directories.

```ts
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const LFS_SCRIPT = require.resolve('@isomorphic-git/lightning-fs/dist/lightning-fs.min.js');

export async function seedVFS(page: Page, files: Record<string, string>) {
  await page.addScriptTag({ path: LFS_SCRIPT });
  await page.evaluate(async (fileMap) => {
    const fs = new (window as any).LightningFS('slicc-fs').promises;
    for (const [filePath, content] of Object.entries(fileMap)) {
      const parts = filePath.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const dir = '/' + parts.slice(0, i).join('/');
        try {
          await fs.mkdir(dir);
        } catch {
          /* exists */
        }
      }
      await fs.writeFile(filePath, content);
    }
  }, files);
}

export async function waitForSW(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers not supported');
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const reg = await navigator.serviceWorker.getRegistration('/preview/');
      if (reg?.active) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Preview SW did not activate within 15s');
  });
}
```

Note: `navigator.serviceWorker.ready` cannot be used here because it waits for a SW controlling the _current page_. The preview SW is registered with `scope: '/preview/'`, so it doesn't control `/`. Instead we poll `getRegistration('/preview/')` until the SW is active.

### Test sequence per test

1. `page.goto('/')` — app boots, SW registers
2. `waitForSW(page)` — polls until SW is active for `/preview/` scope
3. `seedVFS(page, { ... })` — write test content to IndexedDB
4. Navigate or fetch `/preview/...` URLs — assert responses

Tests use Playwright's `baseURL` for all navigation (e.g., `page.goto('/')` resolves to `http://localhost:5780/`). They do not use `toPreviewUrl()` from `shared.ts` — that helper is for the serve command, not tests. Preview URLs are constructed as relative paths (`/preview/...`) which Playwright resolves against `baseURL`.

### Test scenarios

**Group 1 — Basic `/preview/*` serving (3 tests):**

- HTML served with `text/html` content-type
- CSS/JS served with correct MIME types
- Missing paths return 404

**Group 2 — Project serve mode (3 tests):**
The serve command appends `?projectRoot=<dir>` to the preview URL before opening a tab. The SW reads this on the first `/preview/` request and stores it. All subsequent root-relative fetches (e.g., `/styles/main.css`) resolve against the stored root.

- Fetch `/styles/main.css` after navigating with `?projectRoot=/shared/app` — verify content and `text/css` content-type
- Fetch `/scripts/app.js` in project mode — verify content and `application/javascript` content-type
- Fetch `/missing/file.css` in project mode — verify 404

**Group 3 — `isSliccAppPath` exclusions (3 tests):**
When `projectRoot` is set, `isSliccAppPath()` prevents the SW from intercepting Slicc's own paths. These tests seed VFS files that would match if intercepted, then verify the SW lets them through to the real server.

- `/@vite/client` — not intercepted (returns server 404 in production, not VFS content)
- `/api/runtime-config` — not intercepted (returns real JSON from Express, not VFS content)
- `/` — not intercepted (returns the Slicc app HTML with `<div id="app">`, not project content)

**Group 4 — Cross-origin passthrough (1 test):**

- External URLs pass through to network, not served from VFS

### Sub-resource assertion pattern

Tests use `page.evaluate(() => fetch(...))` for sub-resource assertions rather than `page.goto()`. This tests the SW's fetch interception of root-relative paths without full page navigation.

## CI integration

Runs in `.github/workflows/ci.yml` after the `build:extension` step:

```yaml
- name: E2E preview tests
  run: |
    npx playwright install chromium
    npm run test:e2e
```

Adds ~30s to CI on `macos-latest` (Chromium install + 10 parallel tests).

## Out of scope

- BroadcastChannel fallback for mounted directories — requires File System Access API (`FileSystemDirectoryHandle`), which Playwright cannot grant programmatically
- Extension mode preview — different SW registration path, CSP constraints require `sprinkle-sandbox.html` setup; defer to a follow-up
- Performance benchmarks
