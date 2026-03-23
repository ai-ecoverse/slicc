/**
 * BSH Navigation Watchdog — subscribes to CDP `Page.frameNavigated` events
 * and auto-executes matching `.bsh` scripts from the VFS.
 *
 * The watchdog:
 * 1. Periodically re-discovers `.bsh` files on the VFS
 * 2. Listens for main-frame navigations on attached browser tabs
 * 3. Matches the navigated URL against discovered hostname patterns + @match directives
 * 4. Executes matching scripts via the provided executor function
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { VirtualFS } from '../fs/index.js';
import { discoverBshScripts, findMatchingScripts, type BshEntry } from './bsh-discovery.js';
import type { JshResult } from './jsh-executor.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('bsh-watchdog');

/** Function that executes a .bsh script at the given VFS path. */
export type BshExecutor = (scriptPath: string) => Promise<JshResult>;

export interface BshWatchdogOptions {
  /** CDP transport to subscribe to navigation events on. */
  transport: CDPTransport;
  /** VirtualFS for discovering .bsh files. */
  fs: VirtualFS;
  /** Callback to execute a .bsh script (receives the VFS path). */
  execute: BshExecutor;
  /** How often (ms) to re-discover .bsh files. Default: 30000. */
  discoveryIntervalMs?: number;
}

export class BshWatchdog {
  private readonly transport: CDPTransport;
  private readonly fs: VirtualFS;
  private readonly execute: BshExecutor;
  private readonly discoveryIntervalMs: number;

  private entries: BshEntry[] = [];
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Set of URLs currently being handled (prevents re-entrant execution). */
  private executing = new Set<string>();

  constructor(options: BshWatchdogOptions) {
    this.transport = options.transport;
    this.fs = options.fs;
    this.execute = options.execute;
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 30_000;
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

    this.entries = [];
    this.executing.clear();

    log.info('BSH watchdog stopped');
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

    // Skip non-HTTP URLs (about:blank, chrome://, etc.)
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

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

      void this.execute(entry.path)
        .then((result) => {
          if (result.exitCode !== 0) {
            log.warn('BSH script failed', {
              script: entry.path,
              url,
              exitCode: result.exitCode,
              stderr: result.stderr.slice(0, 200),
            });
          } else {
            log.info('BSH script completed', { script: entry.path, url });
          }
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
}
