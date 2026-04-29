// packages/webapp/tests/e2e/preview-serve.test.ts
import { test, expect } from '@playwright/test';
import { installVfsFallbackResponder, seedSkipSwReload, seedVFS, waitForSW } from './helpers.js';

test.describe('preview service worker', () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the bootstrap's one-shot SW-claim reload before the first
    // navigation. Without this, `main.ts` reloads the page ~1.5s into
    // boot, racing waitForSW's polling and tearing down its eval context.
    await seedSkipSwReload(page);
    await page.goto('/');
    await waitForSW(page);
  });

  test.describe('basic /preview/* serving', () => {
    test('serves HTML with text/html content-type', async ({ page }) => {
      await seedVFS(page, {
        '/workspace/site/index.html': '<!DOCTYPE html><h1>Hello</h1>',
      });

      const response = await page.goto('/preview/workspace/site/index.html');
      expect(response).not.toBeNull();
      expect(response!.status()).toBe(200);
      expect(response!.headers()['content-type']).toBe('text/html');
      const body = await response!.text();
      expect(body).toContain('<h1>Hello</h1>');
    });

    test('serves CSS and JS with correct MIME types', async ({ page }) => {
      await seedVFS(page, {
        '/workspace/site/index.html': '<h1>Host</h1>',
        '/workspace/site/styles.css': 'body { color: red; }',
        '/workspace/site/app.js': 'console.log("ok")',
      });

      // Navigate into /preview/ scope so the SW intercepts sub-fetches
      await page.goto('/preview/workspace/site/index.html');

      const css = await page.evaluate(async () => {
        const resp = await fetch('/preview/workspace/site/styles.css');
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: await resp.text(),
        };
      });
      expect(css.status).toBe(200);
      expect(css.contentType).toBe('text/css');
      expect(css.body).toContain('color: red');

      const js = await page.evaluate(async () => {
        const resp = await fetch('/preview/workspace/site/app.js');
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: await resp.text(),
        };
      });
      expect(js.status).toBe(200);
      expect(js.contentType).toBe('application/javascript');
      expect(js.body).toContain('console.log');
    });

    test('returns 404 for missing VFS paths', async ({ page }) => {
      await seedVFS(page, {
        '/workspace/site/index.html': '<h1>Host</h1>',
      });

      // Navigate into /preview/ scope so the SW handles the 404
      await page.goto('/preview/workspace/site/index.html');
      await installVfsFallbackResponder(page);

      const result = await page.evaluate(async () => {
        const resp = await fetch('/preview/workspace/nonexistent.html');
        return resp.status;
      });
      expect(result).toBe(404);
    });
  });

  test.describe('project serve mode (?projectRoot=)', () => {
    test('resolves root-relative CSS against project root', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<link rel="stylesheet" href="/styles/main.css"><h1>Project</h1>',
        '/shared/app/styles/main.css': 'body { color: red; }',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      const css = await page.evaluate(async () => {
        const resp = await fetch('/styles/main.css');
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: await resp.text(),
        };
      });
      expect(css.status).toBe(200);
      expect(css.contentType).toBe('text/css');
      expect(css.body).toContain('color: red');
    });

    test('resolves root-relative JS against project root', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<script src="/scripts/app.js"></script>',
        '/shared/app/scripts/app.js': 'console.log("loaded")',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      const js = await page.evaluate(async () => {
        const resp = await fetch('/scripts/app.js');
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: await resp.text(),
        };
      });
      expect(js.status).toBe(200);
      expect(js.contentType).toBe('application/javascript');
      expect(js.body).toContain('console.log("loaded")');
    });

    test('returns 404 for missing root-relative resource', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<h1>App</h1>',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');
      await installVfsFallbackResponder(page);

      const result = await page.evaluate(async () => {
        const resp = await fetch('/missing/file.css');
        return resp.status;
      });
      expect(result).toBe(404);
    });
  });

  test.describe('isSliccAppPath exclusions', () => {
    test('does not intercept /@vite/ paths', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<h1>App</h1>',
        // Seed a file at the path the SW would resolve if isSliccAppPath failed
        '/shared/app/@vite/client': 'HIJACKED_BY_VFS',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      // If isSliccAppPath works, the SW skips this request and the server
      // returns the SPA fallback (HTML). If it fails, the SW would serve
      // 'HIJACKED_BY_VFS' from VFS.
      const result = await page.evaluate(async () => {
        const resp = await fetch('/@vite/client');
        return resp.text();
      });
      expect(result).not.toContain('HIJACKED_BY_VFS');
      expect(result).toContain('<div id="app">');
    });

    test('does not intercept /api/ paths', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<h1>App</h1>',
        '/shared/app/api/runtime-config': '{"hijacked": true}',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      const result = await page.evaluate(async () => {
        const resp = await fetch('/api/runtime-config');
        const body = await resp.json();
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          hasTrayField: 'trayWorkerBaseUrl' in body,
        };
      });
      expect(result.status).toBe(200);
      expect(result.contentType).toContain('application/json');
      expect(result.hasTrayField).toBe(true);
    });

    test('does not intercept / root path', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<h1>Fake Root</h1>',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      const result = await page.evaluate(async () => {
        const resp = await fetch('/');
        return resp.text();
      });
      expect(result).toContain('<div id="app"></div>');
    });
  });

  test.describe('cross-origin passthrough', () => {
    test('does not intercept cross-origin requests', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<h1>App</h1>',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      // Cross-origin fetch should hit the network, not the SW.
      // CORS will block reading the response body, but the request
      // should either succeed (opaque) or throw a TypeError — never
      // return VFS content with content-type 'text/css'.
      const result = await page.evaluate(async () => {
        try {
          const resp = await fetch('https://example.com/test.css');
          return {
            status: resp.status,
            contentType: resp.headers.get('content-type'),
          };
        } catch {
          // TypeError from CORS block — proves SW didn't intercept
          return { status: 0, contentType: null };
        }
      });
      // If SW intercepted, it would try to serve from VFS and return 404
      // with content-type 'text/plain'. Network response will be different.
      expect(result.contentType).not.toBe('text/plain');
    });
  });
});
