import { readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import express, { type Express, type Response } from 'express';

export interface UiServingOptions {
  devMode: boolean;
  hosted: boolean;
  /** Origin string used only for the dev-server log line. */
  serveOrigin: string;
  /** Built UI directory served in production mode. */
  uiDir: string;
  /** Repo root used to locate the webapp Vite config in dev mode. */
  webappRoot?: string;
}

/**
 * Attach UI serving to the Express app. In dev mode (and not hosted) this wires
 * Vite's dev server as middleware for HMR; otherwise it serves the built static
 * bundle with an SPA fallback.
 */
export async function attachUiServing(
  app: Express,
  server: HttpServer,
  opts: UiServingOptions
): Promise<void> {
  if (opts.devMode && !opts.hosted) {
    await attachViteDevServer(app, server, opts);
  } else {
    attachStaticServing(app, opts.uiDir);
  }
}

async function attachViteDevServer(
  app: Express,
  server: HttpServer,
  opts: UiServingOptions
): Promise<void> {
  const root = opts.webappRoot ?? process.cwd();
  const { createServer: createViteServer } = await import('vite');
  const webappIndexHtml = resolve(root, 'packages/webapp/index.html');
  const vite = await createViteServer({
    configFile: resolve(root, 'packages/webapp/vite.config.ts'),
    server: {
      middlewareMode: true,
      hmr: {
        server, // Share the HTTP server — our upgrade handler routes /cdp and /licks-ws separately
        path: '/__vite_hmr', // Dedicated path avoids conflicts with /cdp upgrade handler
      },
    },
    appType: 'custom', // We handle index.html serving ourselves via the handler below
    root,
  });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (
      req.method !== 'GET' ||
      !req.headers.accept?.includes('text/html') ||
      req.path.includes('.')
    ) {
      next();
      return;
    }

    try {
      const template = readFileSync(webappIndexHtml, 'utf-8');
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).setHeader('Content-Type', 'text/html');
      res.end(html);
    } catch (err: unknown) {
      if (err instanceof Error) {
        vite.ssrFixStacktrace(err);
      }
      next(err);
    }
  });
  console.log(`Vite dev server middleware attached (HMR on ${opts.serveOrigin}/__vite_hmr)`);
}

/**
 * Cache-Control policy for the built static bundle. Default `no-cache` forces a
 * cheap conditional revalidation so a stale `index.html` never pins outdated
 * `/assets/<hash>.js` references; service workers are `no-store`; content-hashed
 * `/assets/*` are immutable. Each branch overrides the default by assigning to
 * `cacheControl` — never add a separate setHeader after, or the catch-all wins.
 */
function setStaticCacheControl(res: Response, path: string): void {
  let cacheControl = 'no-cache';
  if (path.endsWith('llm-proxy-sw.js') || path.endsWith('preview-sw.js')) {
    // Service workers need `Service-Worker-Allowed: /` for the root-scoped
    // registration `llm-proxy-sw.js` does (`preview-sw.js` registers at the
    // narrower `/preview/` scope, so the broader allowance is harmless).
    // `no-store`, not `no-cache`: a stale SW pinned in cache would intercept
    // fetch / dispatch `preview/*` with outdated logic — a worse failure mode
    // than the revalidation cost.
    res.setHeader('Service-Worker-Allowed', '/');
    cacheControl = 'no-store';
  } else if (path.includes(`${sep}assets${sep}`)) {
    // Vite emits content-hashed filenames into `/assets/` — immutable per URL.
    // `path` is a filesystem path, hence the platform-aware `sep` match.
    cacheControl = 'public, max-age=31536000, immutable';
  }
  res.setHeader('Cache-Control', cacheControl);
}

function attachStaticServing(app: Express, uiDir: string): void {
  app.use(express.static(uiDir, { setHeaders: setStaticCacheControl }));

  // SPA fallback — serve index.html for all non-file routes. The served
  // index.html carries references to the current asset hashes, and stale-cached
  // HTML is the canonical post-update breakage, hence `no-cache`.
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(uiDir, 'index.html'));
  });
}
