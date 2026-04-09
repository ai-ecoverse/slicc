/**
 * BSH Navigation Watchdog — subscribes to CDP `Page.frameNavigated` events
 * and auto-executes matching `.bsh` scripts from the VFS.
 *
 * The watchdog:
 * 1. Periodically re-discovers `.bsh` files on the VFS
 * 2. Listens for main-frame navigations on attached browser tabs
 * 3. Matches the navigated URL against discovered hostname patterns + @match directives
 * 4. Executes matching scripts in the target page via CDP Runtime.evaluate
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/index.js';
import { discoverBshScripts, findMatchingScripts, type BshEntry } from './bsh-discovery.js';
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
  /** VirtualFS for discovering .bsh files and reading script content. */
  fs: VirtualFS;
  /** How often (ms) to re-discover .bsh files. Default: 10000. */
  discoveryIntervalMs?: number;
}

export class BshWatchdog {
  private transport: CDPTransport;
  private readonly browserAPI?: BrowserAPI;
  private readonly fs: VirtualFS;
  private readonly discoveryIntervalMs: number;

  private entries: BshEntry[] = [];
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Set of URLs currently being handled (prevents re-entrant execution). */
  private executing = new Set<string>();

  constructor(options: BshWatchdogOptions) {
    if (!options.transport && !options.browserAPI) {
      throw new Error('BshWatchdog requires either transport or browserAPI');
    }
    this.browserAPI = options.browserAPI;
    this.transport = options.transport ?? options.browserAPI!.getTransport();
    this.fs = options.fs;
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 10_000;
  }

  /** Start watching for navigations. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initial discovery
    await this.discover();

    // Periodic re-discovery
    this.discoveryTimer = setInterval(() => {
      void this.discover();
    }, this.discoveryIntervalMs);

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

    log.info('BSH watchdog started', { scriptCount: this.entries.length });
  }

  /** Stop watching and clean up. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.transport.off('Page.frameNavigated', this.onFrameNavigated);

    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    if (this.browserAPI) {
      this.browserAPI.setSessionChangeCallback(undefined);
    }

    this.entries = [];
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
    try {
      this.entries = await discoverBshScripts(this.fs);
      log.debug('BSH discovery complete', { count: this.entries.length });
    } catch (err) {
      log.error('BSH discovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Get the current discovered entries (for testing). */
  getEntries(): readonly BshEntry[] {
    return this.entries;
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

    // Skip if no scripts discovered
    if (this.entries.length === 0) return;

    // Find matching scripts
    const matches = findMatchingScripts(this.entries, url);
    if (matches.length === 0) return;

    // Execute matching scripts (fire-and-forget)
    for (const entry of matches) {
      // Prevent re-entrant execution for the same script+URL combo
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
  const __requireCache = Object.create(null);
  const __uncached = __requireSpecifiers.filter(id => {
    const bare = id.startsWith('node:') ? id.slice(5) : id;
    return !__NODE_BUILTINS_UNAVAILABLE.has(bare) && bare !== 'buffer';
  });
  await Promise.allSettled(__uncached.map(async (id) => {
    try {
      const mod = await import('https://esm.sh/' + id);
      __requireCache[id] = mod.default !== undefined ? mod.default : mod;
    } catch(e) { /* will throw at require() call time */ }
  }));
  const require = (id) => {
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (bareId === 'buffer' && typeof Buffer !== 'undefined') return { Buffer };
    if (__NODE_BUILTINS_UNAVAILABLE.has(bareId)) {
      throw new Error("require('" + id + "'): Node built-in '" + bareId + "' is not available in the browser environment.");
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
