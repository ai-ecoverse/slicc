import { expect, test } from './fixtures.js';
import {
  gotoLeader,
  installVfsFallbackResponder,
  seedSkipSwReload,
  seedVFS,
  waitForSW,
} from './helpers.js';

test.describe('preview service worker', () => {
  test.beforeEach(async ({ page }) => {
    await seedSkipSwReload(page);

    await gotoLeader(page);
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

        '/shared/app/@vite/client': 'HIJACKED_BY_VFS',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

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
        const resp = await fetch('/', { redirect: 'manual' });
        const body = resp.type === 'opaqueredirect' ? '' : await resp.text();
        return { type: resp.type, status: resp.status, body: body.slice(0, 500) };
      });
      expect(result.body).not.toContain('Fake Root');
      expect(['opaqueredirect', 'basic']).toContain(result.type);
    });
  });

  test.describe('cross-origin passthrough', () => {
    test('does not intercept cross-origin requests', async ({ page }) => {
      await seedVFS(page, {
        '/shared/app/index.html': '<h1>App</h1>',
      });

      await page.goto('/preview/shared/app/index.html?projectRoot=/shared/app');

      const result = await page.evaluate(async () => {
        try {
          const resp = await fetch('https://example.com/test.css');
          return {
            status: resp.status,
            contentType: resp.headers.get('content-type'),
          };
        } catch {
          return { status: 0, contentType: null };
        }
      });

      expect(result.contentType).not.toBe('text/plain');
    });
  });
});
