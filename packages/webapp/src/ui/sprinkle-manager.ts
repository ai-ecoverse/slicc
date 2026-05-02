/**
 * Sprinkle Manager — registry of available and open `.shtml` sprinkles,
 * and their placement in the layout.
 */

import type { VirtualFS } from '../fs/index.js';
import type { FsWatcher } from '../fs/index.js';
import { discoverSprinkles, type Sprinkle } from './sprinkle-discovery.js';
import { SprinkleBridge } from './sprinkle-bridge.js';
import { SprinkleRenderer } from './sprinkle-renderer.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { createLogger } from '../core/logger.js';
import { trackSprinkleView } from './telemetry.js';

const log = createLogger('sprinkle-manager');

export interface AddSprinkleOptions {
  /**
   * Mark the rail entry as "needs attention" — the layout should
   * register the icon (so it's clickable) but NOT activate the panel
   * automatically. Used by the extension float for auto-opened
   * sprinkles, where popping the panel mid-onboarding overlays the
   * chat. The user clicks the pulsing icon when ready.
   */
  attention?: boolean;
}

export interface SprinkleManagerCallbacks {
  /** Called to add a sprinkle to the layout (standalone: right column, extension: tab). */
  addSprinkle(
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: AddSprinkleOptions
  ): void;
  /** Called to remove a sprinkle from the layout. */
  removeSprinkle(name: string): void;
}

const OPEN_SPRINKLES_KEY = 'slicc-open-sprinkles';
/**
 * Persistent ledger of every sprinkle name we've ever discovered in
 * this profile. When `restoreOpenSprinkles()` runs and finds an
 * entry in `availableSprinkles` that isn't in the ledger, it's a
 * just-installed sprinkle that hasn't been surfaced yet — open it
 * in attention mode so the rail icon shows up.
 */
const KNOWN_SPRINKLES_KEY = 'slicc-known-sprinkles';

export interface SprinkleManagerOptions {
  /**
   * How to surface auto-open sprinkles (those carrying
   * `data-sprinkle-autoopen`). `'activate'` (default) opens the panel
   * immediately — the standalone behavior. `'attention'` keeps the
   * panel collapsed and just pulses the rail icon for the user to
   * click — the extension behavior, where covering chat mid-flow is
   * disruptive.
   */
  autoOpenBehavior?: 'activate' | 'attention';
}

export class SprinkleManager {
  private fs: VirtualFS;
  private bridge: SprinkleBridge;
  private callbacks: SprinkleManagerCallbacks;
  private availableSprinkles = new Map<string, Sprinkle>();
  private watcherUnsub?: () => void;
  private openSprinkles = new Map<
    string,
    {
      renderer: SprinkleRenderer;
      container: HTMLElement;
    }
  >();
  private autoOpenBehavior: 'activate' | 'attention';

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    callbacks: SprinkleManagerCallbacks,
    stopConeHandler: () => void,
    options: SprinkleManagerOptions = {}
  ) {
    this.fs = fs;
    this.bridge = new SprinkleBridge(fs, lickHandler, (name) => this.close(name), stopConeHandler);
    this.callbacks = callbacks;
    this.autoOpenBehavior = options.autoOpenBehavior ?? 'activate';
  }

  /** Restore sprinkles that were open in the previous session.
   *  On first run (no localStorage entry), auto-open sprinkles marked with data-sprinkle-autoopen.
   *  Always surfaces sprinkles that have landed in the VFS since
   *  the last time the panel saw them (skill installs in a prior
   *  session, or the very first time we boot a profile that
   *  predates the known-sprinkles ledger). */
  async restoreOpenSprinkles(): Promise<void> {
    try {
      const raw = localStorage.getItem(OPEN_SPRINKLES_KEY);
      if (raw) {
        const names: string[] = JSON.parse(raw);
        for (const name of names) {
          try {
            await this.open(name);
          } catch {
            log.warn('Failed to restore sprinkle', { name });
          }
        }
      } else {
        // No previously-opened sprinkles — open autoopen ones
        // (legacy behavior). The non-autoopen ones get a rail
        // icon via `surfaceUnseenSprinkles()` below.
        const attention = this.autoOpenBehavior === 'attention';
        for (const sprinkle of this.availableSprinkles.values()) {
          if (sprinkle.autoOpen) {
            try {
              await this.open(sprinkle.name, undefined, { attention });
            } catch {
              log.warn('Failed to auto-open sprinkle', { name: sprinkle.name });
            }
          }
        }
      }
    } catch {
      /* corrupt localStorage, ignore */
    }
    await this.surfaceUnseenSprinkles();
  }

  /**
   * Diff the current available list against the persisted
   * known-sprinkles ledger. Anything new gets opened in attention
   * mode (or activated for `data-sprinkle-autoopen` ones, honoring
   * `autoOpenBehavior`). Updates the ledger so the next reload
   * doesn't re-pop the same sprinkles.
   */
  private async surfaceUnseenSprinkles(): Promise<void> {
    const known = this.loadKnownSprinkles();
    const attentionForAutoOpen = this.autoOpenBehavior === 'attention';
    for (const sprinkle of this.availableSprinkles.values()) {
      if (known.has(sprinkle.name)) continue;
      if (this.openSprinkles.has(sprinkle.name)) continue;
      try {
        await this.open(sprinkle.name, undefined, {
          attention: sprinkle.autoOpen ? attentionForAutoOpen : true,
        });
        log.info('Surfaced previously-unseen sprinkle', { name: sprinkle.name });
      } catch {
        log.warn('Failed to surface unseen sprinkle', { name: sprinkle.name });
      }
    }
    // Seed/refresh the ledger so future boots only surface what's
    // actually new.
    this.persistKnownSprinkles(new Set(this.availableSprinkles.keys()));
  }

  private loadKnownSprinkles(): Set<string> {
    try {
      const raw = localStorage.getItem(KNOWN_SPRINKLES_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
    } catch {
      return new Set();
    }
  }

  private persistKnownSprinkles(names: Set<string>): void {
    try {
      localStorage.setItem(KNOWN_SPRINKLES_KEY, JSON.stringify([...names]));
    } catch {
      /* localStorage full, ignore */
    }
  }

  private persistOpenSprinkles(): void {
    try {
      localStorage.setItem(OPEN_SPRINKLES_KEY, JSON.stringify([...this.openSprinkles.keys()]));
    } catch {
      /* localStorage full, ignore */
    }
  }

  /**
   * Refresh and surface newly-discovered sprinkles in the rail.
   *
   * Sprinkles that were already in the available list before the
   * refresh are treated as pre-existing and left alone (otherwise
   * every refresh would re-pop everything on every reload). New
   * sprinkles — i.e. those that just appeared in the VFS — are
   * opened so their icon shows up in the rail:
   *
   * - `data-sprinkle-autoopen` ones honor `autoOpenBehavior`
   *   (panel activates in standalone, attention-pulse in extension).
   * - Plain new sprinkles open in `attention` mode unconditionally
   *   so the icon shows but the panel stays collapsed and we don't
   *   cover whatever the user is doing.
   */
  async openNewAutoOpenSprinkles(): Promise<void> {
    const previouslyKnown = new Set(this.availableSprinkles.keys());
    await this.refresh();
    const attentionForAutoOpen = this.autoOpenBehavior === 'attention';
    let changed = false;
    for (const sprinkle of this.availableSprinkles.values()) {
      if (this.openSprinkles.has(sprinkle.name)) continue;
      const isNew = !previouslyKnown.has(sprinkle.name);
      if (isNew) changed = true;
      if (sprinkle.autoOpen) {
        try {
          await this.open(sprinkle.name, undefined, { attention: attentionForAutoOpen });
          log.info('Auto-opened new sprinkle after install', {
            name: sprinkle.name,
            attention: attentionForAutoOpen,
          });
        } catch {
          log.warn('Failed to auto-open new sprinkle', { name: sprinkle.name });
        }
      } else if (isNew) {
        try {
          await this.open(sprinkle.name, undefined, { attention: true });
          log.info('Surfaced newly-installed sprinkle in rail', { name: sprinkle.name });
        } catch {
          log.warn('Failed to surface newly-installed sprinkle', { name: sprinkle.name });
        }
      }
    }
    if (changed) {
      this.persistKnownSprinkles(new Set(this.availableSprinkles.keys()));
    }
  }

  /** Scan VFS and update available sprinkles. */
  async refresh(): Promise<void> {
    this.availableSprinkles = await discoverSprinkles(this.fs);
    log.info('Discovered sprinkles', { count: this.availableSprinkles.size });
  }

  /** Open a sprinkle by name, optionally in a specific zone. */
  async open(name: string, zone?: string, options: AddSprinkleOptions = {}): Promise<void> {
    if (this.openSprinkles.has(name)) {
      log.info('Sprinkle already open', { name });
      return;
    }

    let sprinkle = this.availableSprinkles.get(name);
    if (!sprinkle) {
      // Try refreshing first
      await this.refresh();
      sprinkle = this.availableSprinkles.get(name);
    }
    if (!sprinkle) {
      throw new Error(`Sprinkle not found: ${name}`);
    }

    const rawContent = await this.fs.readFile(sprinkle.path, { encoding: 'utf-8' });
    if (rawContent === undefined || rawContent === null) {
      throw new Error(
        `Failed to read sprinkle content: ${sprinkle.path} (file may be corrupted or missing)`
      );
    }
    const content =
      typeof rawContent === 'string' ? rawContent : new TextDecoder('utf-8').decode(rawContent);
    const container = document.createElement('div');
    container.className = 'sprinkle-panel';
    container.style.cssText =
      'width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;';
    container.dataset.sprinkle = name;

    // Attach container to the layout BEFORE rendering so the sandbox iframe
    // (extension mode) gets added to a live DOM subtree. Iframes in detached
    // subtrees won't fire their load event.
    this.openSprinkles.set(name, { renderer: null!, container });
    this.callbacks.addSprinkle(name, sprinkle.title, container, zone, options);

    const api = this.bridge.createAPI(name);
    const renderer = new SprinkleRenderer(container, api);
    await renderer.render(content, name);

    this.openSprinkles.get(name)!.renderer = renderer;
    this.persistOpenSprinkles();
    trackSprinkleView(name);
    log.info('Sprinkle opened', { name, title: sprinkle.title });
  }

  /** Close a sprinkle by name. */
  close(name: string): void {
    const entry = this.openSprinkles.get(name);
    if (!entry) return;

    entry.renderer?.dispose();
    entry.container.remove();
    this.bridge.removeSprinkle(name);
    this.openSprinkles.delete(name);
    this.callbacks.removeSprinkle(name);
    this.persistOpenSprinkles();
    log.info('Sprinkle closed', { name });
  }

  /** List available sprinkles. */
  available(): Sprinkle[] {
    return Array.from(this.availableSprinkles.values());
  }

  /** List open sprinkle names. */
  opened(): string[] {
    return Array.from(this.openSprinkles.keys());
  }

  /**
   * Set up a watcher that auto-surfaces newly-added `.shtml` files
   * in the rail. Calls `openNewAutoOpenSprinkles()` (which refreshes
   * the available list AND opens any new auto-open sprinkles), so
   * non-auto-open sprinkles still appear in the [+] picker without
   * a reload. Watches the whole VFS — `.shtml` files can land in
   * `/workspace/skills/`, `/shared/sprinkles/`, or anywhere else
   * `discoverSprinkles()` walks. Bursts are coalesced with a small
   * debounce so a single skill install doesn't trigger one refresh
   * per file.
   */
  setupWatcher(watcher: FsWatcher): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.watcherUnsub = watcher.watch(
      '/',
      (path) => path.endsWith('.shtml'),
      () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          void this.openNewAutoOpenSprinkles().catch((err) => {
            log.warn('Sprinkle refresh on watcher event failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, 150);
      }
    );
  }

  /** Clean up watcher subscriptions. */
  dispose(): void {
    this.watcherUnsub?.();
  }

  /** Push data to an open sprinkle (agent → sprinkle). */
  sendToSprinkle(name: string, data: unknown): void {
    const entry = this.openSprinkles.get(name);
    if (!entry) {
      log.warn('Cannot send to closed sprinkle', { name });
      return;
    }
    // In CLI mode, bridge listeners are on the real bridge object.
    this.bridge.pushUpdate(name, data);
    // In extension mode, listeners are inside the sandbox iframe.
    // Forward via the renderer's postMessage channel.
    entry.renderer.pushUpdate(data);
  }
}
