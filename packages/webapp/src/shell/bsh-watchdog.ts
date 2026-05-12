/**
 * BSH Navigation Watchdog — subscribes to CDP `Page.frameNavigated` events
 * and auto-executes matching `.bsh` scripts from the VFS.
 *
 * The watchdog:
 * 1. Listens for main-frame navigations on attached browser tabs
 * 2. Asks ScriptCatalog for the current `.bsh` matches for the URL
 * 3. Executes matching scripts in the target page via CDP Runtime.evaluate
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { BshEntry, BshDiscoveryFS } from './bsh-discovery.js';
import type { ScriptCatalog } from './script-catalog.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('bsh-watchdog');

export interface BshWatchdogOptions {
  /** Optional CDP transport to subscribe to navigation events on.
   *  If `browserAPI` is provided, the watchdog will derive the transport
   *  from `browserAPI.getTransport()` and this option may be omitted. */
  transport?: CDPTransport;
  /** BrowserAPI instance — preferred over raw transport.
   *  When provided, the watchdog registers a session-change callback so it
   *  automatically tracks transport swaps (remote targets, reconnects). */
  browserAPI?: BrowserAPI;
  /** Shared script catalog used for `.bsh` discovery and matching. */
  scriptCatalog: ScriptCatalog;
  /** Filesystem used to read discovered `.bsh` script content. */
  fs: BshDiscoveryFS;
}

export class BshWatchdog {
  private transport: CDPTransport;
  private readonly browserAPI?: BrowserAPI;
  private readonly fs: BshDiscoveryFS;
  private readonly scriptCatalog: ScriptCatalog;
  private running = false;

  /** Set of URLs currently being handled (prevents re-entrant execution). */
  private executing = new Set<string>();

  constructor(options: BshWatchdogOptions) {
    if (!options.transport && !options.browserAPI) {
      throw new Error('BshWatchdog requires either transport or browserAPI');
    }
    if (!options.scriptCatalog) {
      throw new Error('BshWatchdog requires a ScriptCatalog');
    }
    this.browserAPI = options.browserAPI;
    this.transport = options.transport ?? options.browserAPI!.getTransport();
    this.fs = options.fs;
    this.scriptCatalog = options.scriptCatalog;
  }

  /** Start watching for navigations. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Subscribe to navigation events
    this.transport.on('Page.frameNavigated', this.onFrameNavigated);

    // When using BrowserAPI, register for session-change notifications so we
    // automatically follow transport swaps (remote targets, reconnects).
    // Page.enable is already sent by attachToPage before the callback fires.
    if (this.browserAPI) {
      this.browserAPI.setSessionChangeCallback((_sessionId, newTransport) => {
        if (newTransport !== this.transport) {
          this.setTransport(newTransport);
        }
      });
    }

    let scriptCount: number | undefined;
    try {
      scriptCount = (await this.scriptCatalog.getBshEntries()).length;
    } catch (err) {
      log.warn('BSH watchdog startup discovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('BSH watchdog started', scriptCount === undefined ? undefined : { scriptCount });
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.transport.off('Page.frameNavigated', this.onFrameNavigated);

    if (this.browserAPI) {
      this.browserAPI.setSessionChangeCallback(undefined);
    }
    this.executing.clear();

    log.info('BSH watchdog stopped');
  }

  /**
   * Swap the underlying CDP transport.
   * Moves the `Page.frameNavigated` listener from the old transport to the new one.
   */
  setTransport(newTransport: CDPTransport): void {
    if (newTransport === this.transport) return;
    this.transport.off('Page.frameNavigated', this.onFrameNavigated);
    this.transport = newTransport;
    if (this.running) {
      this.transport.on('Page.frameNavigated', this.onFrameNavigated);
    }
    log.info('BSH watchdog transport swapped');
  }

  /** Force a re-discovery of .bsh files. */
  async discover(): Promise<void> {
    this.scriptCatalog.invalidateBsh();
    await this.scriptCatalog.getBshEntries();
  }

  /** Get the current discovered entries (for testing). */
  async getEntries(): Promise<readonly BshEntry[]> {
    return this.scriptCatalog.getBshEntries();
  }

  /** Handle a Page.frameNavigated CDP event. */
  private readonly onFrameNavigated = (params: Record<string, unknown>): void => {
    const frame = params['frame'] as { parentId?: string; url?: string } | undefined;

    // Only handle main frame navigations (no parentId = main frame)
    if (frame?.parentId || !frame?.url) return;

    const url = frame.url;
    const sessionId = params['sessionId'] as string | undefined;

    // Skip non-HTTP URLs (about:blank, chrome://, etc.)
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    // Need sessionId to evaluate in the target page
    if (!sessionId) {
      log.warn('BSH watchdog: no sessionId in Page.frameNavigated params, skipping', { url });
      return;
    }

    void this.scriptCatalog
      .findMatchingBshScripts(url)
      .then((matches) => {
        if (matches.length === 0) return;

        for (const entry of matches) {
          const key = `${entry.path}::${url}`;
          if (this.executing.has(key)) continue;
          this.executing.add(key);

          log.info('BSH watchdog executing script', { script: entry.path, url });

          void this.executeInTargetPage(entry.path, url, sessionId)
            .then(() => {
              log.info('BSH script completed', { script: entry.path, url });
            })
            .catch((err) => {
              log.error('BSH script execution error', {
                script: entry.path,
                url,
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              this.executing.delete(key);
            });
        }
      })
      .catch((err) => {
        log.error('BSH discovery failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  /**
   * Read the .bsh script from VFS and evaluate it in the target page via CDP.
   */
  private async executeInTargetPage(
    scriptPath: string,
    url: string,
    sessionId: string
  ): Promise<void> {
    // Read script content from VFS
    const content = await this.fs.readFile(scriptPath);
    const scriptContent = typeof content === 'string' ? content : new TextDecoder().decode(content);

    // Wrap in async IIFE with pre-scanned synchronous require() and error handling
    const wrappedScript = `(async () => {
  const __requireSpecifiers = (function() {
    const re = /require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
    const code = ${JSON.stringify(scriptContent)};
    const specs = [];
    let m;
    while ((m = re.exec(code)) !== null) specs.push(m[1]);
    return [...new Set(specs)];
  })();
  const __NODE_BUILTINS_UNAVAILABLE = new Set([
    'http', 'https', 'net', 'tls', 'dgram', 'dns', 'cluster',
    'worker_threads', 'child_process', 'crypto', 'os', 'stream',
    'zlib', 'vm', 'v8', 'perf_hooks', 'readline', 'repl', 'tty', 'inspector',
    'fs'
  ]);
  const __NODE_NATIVE_PACKAGES = new Set([
    'bcrypt','better-sqlite3','canvas','cpu-features','fsevents','leveldown',
    'libxmljs','libxmljs2','node-gyp-build','node-sass','puppeteer','robotjs',
    'sass-embedded','sharp','snappy','sqlite3','tree-sitter','usb',
  ]);
  const __NATIVE_HINTS = {
    sharp: " Use the built-in 'convert' shell command for image work.",
    canvas: " Use the built-in 'convert' / OffscreenCanvas for image work.",
    'better-sqlite3': " Use the built-in 'sqlite3' shell command (sql.js WASM).",
    sqlite3: " Use the built-in 'sqlite3' shell command (sql.js WASM).",
    bcrypt: " Use crypto.subtle.digest() with PBKDF2 / Argon2 in pure JS.",
    puppeteer: " Use the built-in browser-automation shell commands.",
  };
  const __nativeError = (id, bareId) => new Error("require('" + id + "'): '" + bareId + "' is a Node native module (C++ bindings) — it cannot run in the browser sandbox." + (__NATIVE_HINTS[bareId] || ''));
  const __withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timed out after ' + (ms/1000) + 's loading ' + label)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  const __requireCache = Object.create(null);
  const __uncached = __requireSpecifiers.filter(id => {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    return !__NODE_BUILTINS_UNAVAILABLE.has(bare) && bare !== 'buffer' && !__NODE_NATIVE_PACKAGES.has(bare);
  });
  await Promise.allSettled(__uncached.map(async (id) => {
    try {
      // 15s ceiling per require — CDN stubs that chain into
      // unresolvable transitive imports (the original sharp hang)
      // are now bounded instead of parking the realm.
      const mod = await __withTimeout(import('https://esm.sh/' + id), 15000, "require('" + id + "')");
      __requireCache[id] = mod.default !== undefined ? mod.default : mod;
    } catch(e) {
      // Surface the failure (especially the timeout error) so the
      // user can correlate the later "module not pre-loaded" against
      // its real cause instead of seeing a generic error. Mirrors
      // the writeStderr warning sandbox.html emits.
      const __reason = e instanceof Error ? e.message : String(e);
      console.warn("[bsh] failed to pre-load require('" + id + "'): " + __reason);
    }
  }));
  const require = (id) => {
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (bareId === 'buffer' && typeof Buffer !== 'undefined') return { Buffer };
    if (__NODE_BUILTINS_UNAVAILABLE.has(bareId)) {
      const __suggestions = { http: ' Use fetch() instead.', https: ' Use fetch() instead.', crypto: ' Use globalThis.crypto (Web Crypto API) instead.' };
      const __hint = __suggestions[bareId] || '';
      throw new Error("require('" + id + "'): Node built-in '" + bareId + "' is not available in the browser environment." + __hint);
    }
    if (__NODE_NATIVE_PACKAGES.has(bareId)) {
      throw __nativeError(id, bareId);
    }
    if (bareId in __requireCache) return __requireCache[bareId];
    if (id in __requireCache) return __requireCache[id];
    throw new Error("require('" + id + "'): module not pre-loaded. Use a string literal or await import('https://esm.sh/" + id + "') directly.");
  };
  try {
    ${scriptContent}
  } catch(e) { console.error('[bsh]', e); }
})()`;

    await this.transport.send('Runtime.enable', {}, sessionId);
    const result = await this.transport.send(
      'Runtime.evaluate',
      {
        expression: wrappedScript,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    );

    const exceptionDetails = result['exceptionDetails'] as
      | { text: string; exception?: { description?: string } }
      | undefined;
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description ?? exceptionDetails.text;
      log.warn('BSH script evaluation error', { script: scriptPath, url, error: msg });
    }
  }
}
