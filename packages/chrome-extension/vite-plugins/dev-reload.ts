/**
 * Vite build plugin: rebuild → sync → CDP-reload loop for the thin extension.
 *
 * Activated only when `SLICC_EXT_DEV_WATCH=1` is set (the `dev:extension`
 * npm script sets it). In that mode every `closeBundle` mirrors `dist/extension/`
 * into a stable scratch path (default `/tmp/slicc-ext-build`, matching the
 * Local QA recipe in `packages/chrome-extension/CLAUDE.md`) so Chrome's
 * `--load-extension` path-derived ID stays stable across rebuilds, then
 * speaks CDP to an already-running Chrome for Testing on
 * `SLICC_CDP_PORT` (default `9333`) to reload tabs + the extension itself.
 *
 * CDP failures (Chrome not running, SW target missing) are warnings, never
 * build-breaking — the user can launch Chrome via the QA recipe after the
 * first build completes and the next rebuild will pick it up.
 *
 * The reload is a SINGLE `Runtime.evaluate` against the service-worker
 * target that issues `chrome.tabs.query` + `chrome.tabs.reload` for every
 * non-extension page tab, then `chrome.runtime.reload()`. Routing through
 * the SW means we only open one WebSocket per rebuild and avoid the
 * stale-target race that would come from page-target reloads racing the
 * extension restart.
 *
 * Pure helpers (`syncExtensionDir`, `pickServiceWorkerTarget`, `buildReloadExpression`)
 * are exported separately for unit tests in
 * `packages/chrome-extension/tests/dev-reload.test.ts`. The plugin itself
 * is the thin glue layer that wires the helpers together with the
 * networked pieces (HTTP probe + WebSocket attach).
 */

import type { Dirent } from 'node:fs';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import * as http from 'node:http';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { WebSocket } from 'ws';

/** Minimum subset of a CDP `/json/list` target entry we care about. */
export interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface DevReloadOptions {
  /** Absolute path to the Vite build output (the `dist/extension/` directory). */
  outDir: string;
  /** Absolute path to mirror `outDir` into — Chrome's `--load-extension` path. */
  syncTo: string;
  /** CDP port to attach to (e.g. 9333 from the Local QA recipe). */
  cdpPort: number;
  /**
   * Absolute paths whose contents (recursive) Rollup's watcher should
   * track in addition to the module graph. The esbuild-managed bundles
   * (service-worker, sidepanel-entry, secrets-entry, preview-sw, etc.) live
   * outside Rollup's import graph, so without these the watcher would
   * never rebuild when their sources change.
   */
  extraWatchDirs: readonly string[];
}

/** Recursively list every file under `dir`. Best-effort: unreadable subtrees are skipped. */
export function listFilesRecursive(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Mirror `outDir` into `syncTo` by overlaying — `cpSync` overwrites existing
 * files in place but does NOT first wipe the destination. That's deliberate:
 * Chrome is loading the extension out of `syncTo` via `--load-extension`, so
 * an `rmSync` would briefly remove the manifest + assets and trigger Chrome
 * to evict the extension's service-worker target. The CDP reload that
 * immediately follows would then race the extension reload and find no SW
 * to reach. Overlay-copy keeps the extension continuously valid; stale files
 * from a previous build linger (manifest never references them, so this is
 * harmless) until the user wipes `syncTo` manually.
 *
 * `syncTo === outDir` is a no-op so callers can pass either path without
 * blowing the build away. Pure file-system op suitable for unit tests.
 */
export function syncExtensionDir(outDir: string, syncTo: string): void {
  if (resolve(outDir) === resolve(syncTo)) return;
  mkdirSync(syncTo, { recursive: true });
  cpSync(outDir, syncTo, { recursive: true, force: true });
}

/**
 * Pick the unique service-worker target in a CDP `/json/list` payload.
 * Returns the entry whose URL ends in `/service-worker.js` (the thin
 * extension's only SW), or `null` when zero or many candidates exist —
 * the caller logs and skips the reload rather than guessing.
 */
export function pickServiceWorkerTarget(targets: readonly CdpTarget[]): CdpTarget | null {
  const matches = targets.filter(
    (t) => typeof t.url === 'string' && t.url.endsWith('/service-worker.js')
  );
  if (matches.length !== 1) return null;
  const sw = matches[0];
  return sw && typeof sw.webSocketDebuggerUrl === 'string' ? sw : null;
}

/**
 * Build the `Runtime.evaluate` expression body sent to the extension target.
 * Calls `chrome.runtime.reload()` — Chrome restarts the service worker.
 * An already-open side panel needs a manual reopen to pick up new panel
 * code (a CLAUDE.md caveat).
 *
 * The earlier version of this also iterated `chrome.tabs` and reloaded each
 * non-extension page before the runtime.reload(), but that produced a race
 * where Chrome disabled the extension when a tab-reload landed at the same
 * moment as the extension restart. Keeping reload to a single op is both
 * safer and matches the MV3 "extension is the source of truth" philosophy.
 * Returns a string (not a function) so `Runtime.evaluate` ships the literal
 * expression Chrome will execute.
 */
export function buildReloadExpression(): string {
  return `(() => {
    try { chrome.runtime.reload(); } catch {}
    return 'reload-scheduled';
  })()`;
}

/**
 * Single-shot GET against the CDP HTTP front-door; rejects on timeout / parse fail.
 * Uses `localhost` (not `127.0.0.1`) because Chrome for Testing on macOS binds
 * the CDP listener to IPv6 (`::1`); forcing IPv4 misses it. Node's DNS resolves
 * `localhost` per-platform order so both families work.
 */
function fetchCdpJson<T>(port: number, path: string, timeoutMs = 1500): Promise<T> {
  return new Promise((resolveJson, reject) => {
    const req = http.get({ host: 'localhost', port, path, timeout: timeoutMs }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} on ${path}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolveJson(JSON.parse(body) as T);
        } catch (err) {
          reject(new Error(`bad JSON on ${path}: ${(err as Error).message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout on ${path}`));
    });
  });
}

/**
 * Open a CDP WebSocket to the SW target and run the reload expression.
 * Network errors collapse to a rejected promise the caller logs; the
 * WebSocket is always closed in `finally` so a half-open socket can't
 * pile up across rebuilds.
 */
async function evaluateOnTarget(wsUrl: string, expression: string): Promise<void> {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise<void>((resolveOpen, reject) => {
    const onOpen = () => {
      ws.off('error', onError);
      resolveOpen();
    };
    const onError = (err: Error) => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
  try {
    const id = 1;
    const reply = await new Promise<{ error?: { message?: string } }>((resolveReply, reject) => {
      const onMessage = (raw: Buffer | ArrayBuffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as { id?: number; error?: { message?: string } };
          if (msg.id === id) {
            ws.off('message', onMessage);
            resolveReply(msg);
          }
        } catch {
          /* ignore parse errors on unrelated CDP frames */
        }
      };
      ws.on('message', onMessage);
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: false },
        }),
        (err) => {
          if (err) reject(err);
        }
      );
    });
    if (reply.error) {
      throw new Error(reply.error.message ?? 'unknown CDP error');
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* socket may already be torn down by chrome.runtime.reload() */
    }
  }
}

/**
 * End-to-end reload: probe CDP → find SW → evaluate reload expression.
 * MV3 service workers go idle and Chrome drops them from `/json/list` until
 * the next event wakes them, so the SW-target lookup is retried briefly
 * (poke with `/json/version` between attempts — that 1.3 protocol GET
 * doesn't itself wake SWs, but the loop tolerates the eviction window).
 */
/**
 * Pick the canonical extension target to drive: prefer the service worker
 * (it has the full `chrome.tabs` + `chrome.runtime` surface so a single
 * Runtime.evaluate can reload tabs AND the extension), otherwise fall back
 * to ANY extension-origin target (e.g. the options page) — those only have
 * `chrome.runtime.reload()`, but that's enough to land code changes; the
 * user just refreshes affected tabs by hand.
 *
 * Returning the fallback is more robust than retrying for an idle SW: MV3
 * SWs evict after 30s with no events, and `/json/list` does NOT wake them.
 * Any non-SW extension target keeps Chrome reporting our extension origin.
 */
export function pickExtensionReloadTarget(
  targets: readonly CdpTarget[]
): { target: CdpTarget; viaServiceWorker: boolean } | null {
  const sw = pickServiceWorkerTarget(targets);
  if (sw) return { target: sw, viaServiceWorker: true };
  const extTarget = targets.find(
    (t) =>
      typeof t.url === 'string' &&
      t.url.startsWith('chrome-extension://') &&
      typeof t.webSocketDebuggerUrl === 'string'
  );
  return extTarget ? { target: extTarget, viaServiceWorker: false } : null;
}

async function triggerCdpReload(port: number): Promise<string> {
  await fetchCdpJson(port, '/json/version'); // confirms CDP is alive
  let pick: ReturnType<typeof pickExtensionReloadTarget> = null;
  let lastTotal = 0;
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const targets = await fetchCdpJson<CdpTarget[]>(port, '/json/list');
    lastTotal = targets.length;
    pick = pickExtensionReloadTarget(targets);
    if (pick) break;
    if (attempt < maxAttempts - 1) {
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }
  if (!pick?.target.webSocketDebuggerUrl) {
    throw new Error(
      `no extension target on /json/list ` +
        `(probed ${maxAttempts}× over ~1s, saw ${lastTotal} targets) — extension not loaded?`
    );
  }
  // Both target kinds run the same minimal `chrome.runtime.reload()` —
  // it's the one MV3 API exposed everywhere the extension origin runs.
  await evaluateOnTarget(pick.target.webSocketDebuggerUrl, buildReloadExpression());
  return pick.viaServiceWorker ? 'service-worker' : 'extension-page';
}

export function devReloadPlugin(opts: DevReloadOptions): Plugin {
  let buildCount = 0;
  return {
    name: 'slicc:dev-reload',
    apply: 'build',
    buildStart() {
      // Rollup's `watch.include` only NARROWS the watched set; to EXPAND it
      // we must register each esbuild-input source as an explicit watch
      // dependency via `this.addWatchFile`. Walking the configured dirs
      // catches both the entry points (service-worker.ts, sidepanel-entry.ts,
      // …) and their transitive imports — so editing a helper that only the
      // SW imports also triggers a rebuild.
      for (const dir of opts.extraWatchDirs) {
        for (const file of listFilesRecursive(dir)) {
          this.addWatchFile(file);
        }
      }
    },
    async closeBundle() {
      buildCount++;
      try {
        syncExtensionDir(opts.outDir, opts.syncTo);
      } catch (err) {
        console.warn(`[dev-reload] sync failed: ${(err as Error).message}`);
        return;
      }
      const tag = buildCount === 1 ? 'initial build' : `rebuild #${buildCount - 1}`;
      console.log(`[dev-reload] synced ${opts.outDir} → ${opts.syncTo} (${tag})`);
      try {
        const via = await triggerCdpReload(opts.cdpPort);
        console.log(
          `[dev-reload] dispatched chrome.runtime.reload() via ${via} ` +
            `(port ${opts.cdpPort}) — reopen the side panel to pick up new panel code`
        );
      } catch (err) {
        console.warn(
          `[dev-reload] CDP reload skipped: ${(err as Error).message} — ` +
            `start Chrome for Testing on port ${opts.cdpPort} ` +
            `(see packages/chrome-extension/CLAUDE.md "Local QA" recipe)`
        );
      }
    },
  };
}
