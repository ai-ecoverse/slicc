// packages/webapp/tests/e2e/helpers.ts
import type { Page } from '@playwright/test';
import { BRIDGE_WS_URL, E2E_BRIDGE_TOKEN } from './playwright.config.js';

/**
 * Build the standalone leader boot query (`?bridge=<ws-url>&bridgeToken=<token>`).
 *
 * node-server no longer serves the UI — the webapp is served cross-origin by
 * wrangler (the `baseURL`), and learns where the local node-server thin-bridge
 * is from these launch params (the same ones node-server's launcher appends in
 * production standalone mode). With them present, the page-realm BrowserAPI
 * dials `ws://localhost:<bridge>/cdp` (subprotocol-token gated) for CDP and
 * `proxied-fetch` routes cross-origin `/api/*` at the node-server origin with
 * the `X-Bridge-Token` header. Without them the boot stays same-origin (no CDP
 * bridge), which is fine for tests that don't drive browser automation.
 */
export function leaderBootQuery(): string {
  const params = new URLSearchParams({
    bridge: BRIDGE_WS_URL,
    bridgeToken: E2E_BRIDGE_TOKEN,
  });
  return params.toString();
}

/**
 * Navigate to the standalone leader UI with the thin-bridge launch params
 * appended so CDP + cross-origin `/api` reach the local node-server. Use this
 * instead of `page.goto('/')` for any scenario that drives the agent / browser
 * automation (CDP) or depends on the node-server fetch proxy.
 */
export async function gotoLeader(
  page: Page,
  path = '/'
): Promise<Awaited<ReturnType<Page['goto']>>> {
  const sep = path.includes('?') ? '&' : '?';
  return page.goto(`${path}${sep}${leaderBootQuery()}`);
}

/**
 * sessionStorage key holding the JSON-encoded seed map. Survives
 * same-tab navigations (e.g. `/` → `/preview/...`) so the seed
 * responder can answer from whichever page is alive when the SW
 * asks via BroadcastChannel.
 */
const SEED_STORAGE_KEY = '__sliccE2EPreviewSeed';

/**
 * Suppress the one-shot SW-claim reload baked into `main.ts` AND install
 * a synchronous `preview-vfs` BroadcastChannel responder that serves
 * files seeded via {@link seedVFS}.
 *
 * SW reload: on a fresh page load the app registers the preview service
 * worker with scope `/preview/`. Because the bootstrap page lives at `/`,
 * it is outside that scope and `clients.claim()` will never make it the
 * controller — but the bootstrap waits 1.5s for `controllerchange` and
 * then forces a single `location.reload()`, gated by
 * `sessionStorage['slicc-sw-reloaded']`. That reload races with
 * `waitForSW`'s polling `page.evaluate`, killing its execution context
 * and producing spurious "Preview SW did not activate within 15s"
 * failures. Pre-seeding the flag short-circuits the reload.
 *
 * Seed responder: post-OPFS migration the SW no longer reads any
 * IndexedDB store directly; every `/preview/*` read is satisfied by the
 * page-side `preview-vfs` BroadcastChannel responder, which reads from
 * the OPFS-backed `VirtualFS` (`localFs`, later swapped to the worker's
 * `remoteVfs`). Writing test fixtures into LightningFS IDB therefore no
 * longer reaches the responder. Instead this init script registers a
 * synchronous BC listener that reads the JSON-encoded seed map from
 * sessionStorage and replies immediately for any seeded path — beating
 * the page's async OPFS-backed responder to the SW's one-shot waiter.
 * Misses are silent so {@link installVfsFallbackResponder}'s ENOENT
 * fallback still drives the 404 tests.
 */
export async function seedSkipSwReload(page: Page): Promise<void> {
  await page.addInitScript((storageKey: string) => {
    try {
      sessionStorage.setItem('slicc-sw-reloaded', '1');
    } catch {
      /* sessionStorage may be unavailable for opaque origins */
    }
    try {
      const bc = new BroadcastChannel('preview-vfs');
      bc.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as
          | { type?: string; id?: string; path?: string; asText?: boolean }
          | undefined;
        if (data?.type !== 'preview-vfs-read' || !data.id || !data.path) return;
        let map: Record<string, string> | null = null;
        try {
          const raw = sessionStorage.getItem(storageKey);
          map = raw ? (JSON.parse(raw) as Record<string, string>) : null;
        } catch {
          map = null;
        }
        if (!map || !(data.path in map)) return;
        const content = map[data.path];
        bc.postMessage({ type: 'preview-vfs-response', id: data.id, content });
      });
    } catch {
      /* BroadcastChannel may be unavailable for opaque origins */
    }
  }, SEED_STORAGE_KEY);
}

/**
 * Wait for the preview service worker to be registered and active.
 * Must be called after page.goto('/') — the main app registers the SW on load.
 *
 * The SW is registered with scope '/preview/', so navigator.serviceWorker.ready
 * (which waits for a SW controlling the current page at '/') would hang forever.
 * Instead we poll getRegistration() for the '/preview/' scope.
 */
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

/**
 * Install a BroadcastChannel responder that immediately replies with ENOENT
 * for any preview-vfs-read request. Without this, the SW's BroadcastChannel
 * fallback waits 5s before timing out on every 404 — adding ~5s per missing file.
 */
export async function installVfsFallbackResponder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bc = new BroadcastChannel('preview-vfs');
    bc.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'preview-vfs-read') return;
      bc.postMessage({
        type: 'preview-vfs-response',
        id: event.data.id,
        error: 'ENOENT',
      });
    };
  });
}

/**
 * Seed files for the `/preview/*` SW to serve.
 *
 * Populates a JSON map in sessionStorage that the seed responder
 * (installed in {@link seedSkipSwReload}) reads when the SW issues
 * `preview-vfs-read` envelopes. Must be called after
 * {@link seedSkipSwReload} + `page.goto('/')` so the page exists and
 * the init script has registered its BC listener.
 */
export async function seedVFS(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate(
    ({ storageKey, fileMap }: { storageKey: string; fileMap: Record<string, string> }) => {
      sessionStorage.setItem(storageKey, JSON.stringify(fileMap));
    },
    { storageKey: SEED_STORAGE_KEY, fileMap: files }
  );
}
