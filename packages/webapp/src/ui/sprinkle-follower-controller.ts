/**
 * Sprinkle follower controller — page-side surface that mirrors the leader's
 * sprinkle list into the local layout. The leader's `SprinkleManager` owns the
 * canonical state; this controller is the follower-side counterpart that:
 *
 *   - reconciles open rail entries against incoming `sprinkles.list`
 *     (sprinkles with `open: true` on the leader are surfaced locally),
 *   - fetches `.shtml` content from the leader via `sync.fetchSprinkleContent`
 *     and renders it through the shared `SprinkleRenderer`,
 *   - forwards every `lick` from the sprinkle bridge back to the leader via
 *     `sync.sendSprinkleLick` (so the leader's lick router handles routing),
 *   - dispatches incoming `sprinkle.update` payloads to the open renderer.
 *
 * Modeled on the iOS follower's `AppState` + `SprinkleWebView` pair
 * (`packages/ios-app/SliccFollower/`). VFS bridge methods are intentionally
 * limited — the leader's VFS is not addressable from here.
 */

import { SprinkleRenderer } from './sprinkle-renderer.js';
import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';
import type { SprinkleAddOptions } from './sprinkle-manager.js';
import type { SprinkleSummary } from '../scoops/tray-sync-protocol.js';
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('sprinkle-follower');

/**
 * Subset of `FollowerSyncManager` that the controller relies on. Kept narrow
 * to make the controller trivially testable with a hand-rolled fake.
 */
export interface SprinkleFollowerSync {
  fetchSprinkleContent(sprinkleName: string): Promise<string>;
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void;
}

export interface SprinkleFollowerControllerOptions {
  sync: SprinkleFollowerSync;
  /** Add a sprinkle to the host layout. Same signature as `SprinkleManagerCallbacks.addSprinkle`. */
  addSprinkle: (
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: SprinkleAddOptions
  ) => void;
  /** Remove a sprinkle from the host layout. */
  removeSprinkle: (name: string) => void;
  /**
   * Optional rail placement zone (defaults to the layout's "sprinkles" zone).
   * Mirrors the standalone leader's behavior of letting the layout decide.
   */
  zone?: string;
}

interface OpenEntry {
  renderer: SprinkleRenderer;
  container: HTMLElement;
}

export class SprinkleFollowerController {
  private readonly sync: SprinkleFollowerSync;
  private readonly addSprinkle: SprinkleFollowerControllerOptions['addSprinkle'];
  private readonly removeSprinkle: SprinkleFollowerControllerOptions['removeSprinkle'];
  private readonly zone?: string;

  private readonly open = new Map<string, OpenEntry>();
  /** Sprinkle names with an in-flight open, used to dedupe rapid `updateAvailable` calls. */
  private readonly opening = new Set<string>();
  private disposed = false;

  constructor(options: SprinkleFollowerControllerOptions) {
    this.sync = options.sync;
    this.addSprinkle = options.addSprinkle;
    this.removeSprinkle = options.removeSprinkle;
    this.zone = options.zone;
  }

  /**
   * Reconcile the local open set against the leader's latest list. Sprinkles
   * with `open: true` get surfaced; ones with `open: false` (or absent) get
   * closed. Returns when all opens have resolved (best-effort — individual
   * failures are logged, not propagated, so one broken sprinkle doesn't take
   * the whole reconcile down).
   */
  async updateAvailable(sprinkles: SprinkleSummary[]): Promise<void> {
    if (this.disposed) return;

    const desiredOpen = new Map<string, SprinkleSummary>();
    for (const s of sprinkles) {
      if (s.open) desiredOpen.set(s.name, s);
    }

    // Close anything that's open locally but no longer open on the leader.
    for (const name of [...this.open.keys()]) {
      if (!desiredOpen.has(name)) this.closeLocally(name);
    }

    // Open everything that's open on the leader but not yet here.
    const opens: Promise<void>[] = [];
    for (const [name, summary] of desiredOpen) {
      if (this.open.has(name) || this.opening.has(name)) continue;
      opens.push(this.openLocally(name, summary));
    }
    await Promise.allSettled(opens);
  }

  /** Handle a `sprinkle.update` payload from the leader. */
  handleSprinkleUpdate(sprinkleName: string, data: unknown): void {
    const entry = this.open.get(sprinkleName);
    if (!entry) {
      log.debug('Dropping sprinkle.update for closed sprinkle', { sprinkleName });
      return;
    }
    entry.renderer.pushUpdate(data);
  }

  /** Tear down all open sprinkles. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const name of [...this.open.keys()]) this.closeLocally(name);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async openLocally(name: string, summary: SprinkleSummary): Promise<void> {
    this.opening.add(name);
    let content: string;
    try {
      content = await this.sync.fetchSprinkleContent(name);
    } catch (err) {
      this.opening.delete(name);
      log.warn('Failed to fetch sprinkle content from leader', {
        sprinkleName: name,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Re-check guards: another updateAvailable might have closed the sprinkle
    // (or disposed the controller) while we awaited content. Skip in that
    // case so we don't double-attach.
    if (this.disposed) {
      this.opening.delete(name);
      return;
    }

    const container = document.createElement('div');
    container.className = 'sprinkle-panel';
    container.style.cssText =
      'width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;';
    container.dataset.sprinkle = name;

    const api = this.createBridge(name);
    const renderer = new SprinkleRenderer(container, api);
    this.open.set(name, { renderer, container });
    this.opening.delete(name);

    // Surface in the layout BEFORE render so the (possible) sandbox iframe
    // gets attached to a live DOM subtree — iframes in detached subtrees
    // don't fire `load`. Matches `SprinkleManager.open` ordering.
    this.addSprinkle(name, summary.title, container, this.zone);
    try {
      await renderer.render(content, name);
    } catch (err) {
      log.warn('Sprinkle render failed', {
        sprinkleName: name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Leave the rail entry in place but the renderer may be partial. The
      // user's next reconcile will tear it down if the leader closes it.
    }
  }

  private closeLocally(name: string): void {
    const entry = this.open.get(name);
    if (!entry) return;
    try {
      entry.renderer.dispose();
    } catch (err) {
      log.warn('Sprinkle dispose threw', {
        sprinkleName: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    entry.container.remove();
    this.open.delete(name);
    try {
      this.removeSprinkle(name);
    } catch (err) {
      log.warn('removeSprinkle callback threw', {
        sprinkleName: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Bridge surface handed to the renderer. Mirrors `SprinkleWebView.bridgeJS`
   * in the iOS follower: `lick` / `on` / `off` / `setState` / `getState` /
   * `close` / `stopCone` work; VFS methods reject so sprinkles that rely on
   * filesystem access degrade gracefully (the leader's VFS is not addressable
   * from the follower).
   */
  private createBridge(sprinkleName: string): SprinkleBridgeAPI {
    const api: SprinkleBridgeAPI = {
      name: sprinkleName,
      lick: (event) => {
        const action = typeof event === 'string' ? event : event.action;
        const data = typeof event === 'string' ? undefined : event.data;
        // Follower-side licks go over the wire — the leader's lick router
        // owns `getSprinkleRoute(name)`, so we don't compute a targetScoop here.
        this.sync.sendSprinkleLick(sprinkleName, { action, data });
      },
      on: () => {
        /* Update listeners live in the renderer (sandbox or inline). The
         * SprinkleRenderer.pushUpdate path forwards `sprinkle.update` payloads
         * into the rendered context — no separate listener registry needed at
         * the controller level. */
      },
      off: () => {
        /* See `on`. */
      },
      readFile: () =>
        Promise.reject(new Error('readFile not supported in follower-rendered sprinkle')),
      writeFile: () =>
        Promise.reject(new Error('writeFile not supported in follower-rendered sprinkle')),
      readDir: () =>
        Promise.reject(new Error('readDir not supported in follower-rendered sprinkle')),
      exists: () => Promise.resolve(false),
      stat: () => Promise.reject(new Error('stat not supported in follower-rendered sprinkle')),
      mkdir: () => Promise.reject(new Error('mkdir not supported in follower-rendered sprinkle')),
      rm: () => Promise.reject(new Error('rm not supported in follower-rendered sprinkle')),
      screenshot: () =>
        Promise.reject(new Error('screenshot not supported in follower-rendered sprinkle')),
      setState: (data) => {
        try {
          localStorage.setItem(`slicc-sprinkle-state:${sprinkleName}`, JSON.stringify(data));
        } catch {
          /* localStorage full */
        }
      },
      getState: () => {
        try {
          const raw = localStorage.getItem(`slicc-sprinkle-state:${sprinkleName}`);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      open: (path: string) => {
        const url = /^https?:|^chrome-extension:/.test(path) ? path : toPreviewUrl(path);
        window.open(url, '_blank');
      },
      close: () => this.closeLocally(sprinkleName),
      stopCone: () => {
        // Special-case action that the leader's lick router maps to "abort
        // the cone agent." Matches iOS `SprinkleWebView` `case "stopCone"`.
        this.sync.sendSprinkleLick(sprinkleName, { action: '__stopCone__' });
      },
    };
    return api;
  }
}
