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

import { createLogger } from '../core/logger.js';
import type { SprinkleSummary } from '../scoops/tray-sync-protocol.js';
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';
import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';
import type { SprinkleAddOptions } from './sprinkle-manager.js';
import { SprinkleRenderer } from './sprinkle-renderer.js';

const log = createLogger('sprinkle-follower');

/**
 * Subset of `FollowerSyncManager` that the controller relies on. Kept narrow
 * to make the controller trivially testable with a hand-rolled fake.
 *
 * `cancelSprinkleFetch` is **required**, not optional — the bridge calls it
 * when the panel-side proxy times out, and a sync that silently drops the
 * cancel would let offscreen waiters accumulate across panel retries
 * (R2-IMP-2). Implementations whose `fetchSprinkleContent` is already
 * self-bounding (e.g. `PanelFollowerSprinkleProxy` with its own pending
 * timer) MAY provide a no-op body — but the method must be present so the
 * compiler catches a future sync surface that forgets to implement it.
 */
export interface SprinkleFollowerSync {
  fetchSprinkleContent(sprinkleName: string): Promise<string>;
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void;
  cancelSprinkleFetch(sprinkleName: string, reason?: string): void;
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
  /**
   * Optional override for the sprinkle bridge's `open(path)`. A no-kernel
   * follower has no page VFS responder, so the default `/preview/*` mapping
   * 404s; the follower passes a guard that only opens absolute URLs.
   */
  open?: (path: string) => void;
}

interface OpenEntry {
  renderer: SprinkleRenderer;
  container: HTMLElement;
}

type UpdateCallback = (data: unknown) => void;

export class SprinkleFollowerController {
  private readonly sync: SprinkleFollowerSync;
  private readonly addSprinkle: SprinkleFollowerControllerOptions['addSprinkle'];
  private readonly removeSprinkle: SprinkleFollowerControllerOptions['removeSprinkle'];
  private readonly zone?: string;
  private readonly openPath?: SprinkleFollowerControllerOptions['open'];

  private readonly open = new Map<string, OpenEntry>();
  /** Sprinkle names with an in-flight open, used to dedupe rapid `updateAvailable` calls. */
  private readonly opening = new Set<string>();
  /**
   * Latest desired-open snapshot the controller has been told to honor. Used
   * by `openLocally` after the await on `fetchSprinkleContent` resolves to
   * decide whether the leader still wants this sprinkle open — otherwise a
   * leader-driven close mid-fetch would lead to a zombie sprinkle attached
   * after the controller had already been told to drop it.
   */
  private latestDesiredOpen = new Set<string>();
  /**
   * Buffered `sprinkle.update` payloads keyed by sprinkleName, for sprinkles
   * currently in `opening` (the renderer doesn't exist yet, so we can't push
   * directly). Latest update wins — mirrors the iOS follower's
   * `AppState.sprinkleUpdates[name]` behavior. Replayed once the open
   * completes, then cleared.
   */
  private readonly pendingUpdates = new Map<string, unknown>();
  /**
   * Per-sprinkle update listener registry. The renderer's `pushUpdate` only
   * reaches the rendered context for iframe-based modes (extension sandbox,
   * full-doc srcdoc). In **CLI inline mode** the renderer executes the
   * sprinkle's `<script>` directly in the panel, so the only path for
   * `slicc.on('update', cb)` to receive updates is this registry — fanned
   * out alongside `renderer.pushUpdate` in `handleSprinkleUpdate`.
   */
  private readonly updateListeners = new Map<string, Set<UpdateCallback>>();
  private disposed = false;

  constructor(options: SprinkleFollowerControllerOptions) {
    this.sync = options.sync;
    this.addSprinkle = options.addSprinkle;
    this.removeSprinkle = options.removeSprinkle;
    this.zone = options.zone;
    this.openPath = options.open;
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
    // Publish before we start any awaits so a concurrent `openLocally` can
    // see the latest snapshot when its fetch resolves.
    this.latestDesiredOpen = new Set(desiredOpen.keys());

    // Close anything that's open locally but no longer open on the leader.
    for (const name of [...this.open.keys()]) {
      if (!desiredOpen.has(name)) this.closeLocally(name);
    }
    // Drop buffered updates for sprinkles the leader no longer wants open.
    // Otherwise a re-open via a fresh `sprinkles.list` would surface a stale
    // update from a different lifecycle.
    for (const name of [...this.pendingUpdates.keys()]) {
      if (!desiredOpen.has(name)) this.pendingUpdates.delete(name);
    }

    // Open everything that's open on the leader but not yet here.
    const opens: Promise<void>[] = [];
    for (const [name, summary] of desiredOpen) {
      if (this.open.has(name) || this.opening.has(name)) continue;
      opens.push(this.openLocally(name, summary));
    }
    await Promise.allSettled(opens);
  }

  /**
   * Handle a `sprinkle.update` payload from the leader.
   *
   * Three cases:
   *   - Sprinkle is open → push to its renderer AND fan out to bridge listeners.
   *   - Sprinkle is in `opening` (fetch in flight) → buffer the latest payload
   *     so it can be replayed when the open finishes (mirrors iOS).
   *   - Otherwise → drop silently. The leader is sending an update for a
   *     sprinkle the follower never opened (race, or the leader closed it
   *     between broadcasts).
   */
  handleSprinkleUpdate(sprinkleName: string, data: unknown): void {
    if (this.disposed) return;

    const entry = this.open.get(sprinkleName);
    if (entry) {
      entry.renderer.pushUpdate(data);
      this.fanOutToListeners(sprinkleName, data);
      return;
    }

    if (this.opening.has(sprinkleName)) {
      // Buffer the latest update — replayed by `openLocally` after the fetch
      // resolves and the sprinkle attaches.
      this.pendingUpdates.set(sprinkleName, data);
      return;
    }

    log.debug('Dropping sprinkle.update for unknown sprinkle', { sprinkleName });
  }

  /**
   * Handle a leader-side sprinkle reload: re-render in place so the
   * follower picks up new `.shtml` content without the panel disappearing.
   * The container stays in the layout — only the renderer's internal
   * content (iframe/scripts) is replaced.
   */
  async handleSprinkleReloaded(sprinkleName: string): Promise<void> {
    if (this.disposed) return;

    const entry = this.open.get(sprinkleName);
    if (!entry) {
      if (this.opening.has(sprinkleName)) {
        this.pendingUpdates.delete(sprinkleName);
      }
      return;
    }

    this.updateListeners.delete(sprinkleName);

    let content: string;
    try {
      content = await this.sync.fetchSprinkleContent(sprinkleName);
    } catch (err) {
      log.warn('Failed to fetch sprinkle content for reload', {
        sprinkleName,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (this.disposed || !this.open.has(sprinkleName)) return;

    try {
      entry.renderer.dispose();
    } catch (err) {
      log.warn('Sprinkle dispose threw during reload', {
        sprinkleName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const api = this.createBridge(sprinkleName);
    const renderer = new SprinkleRenderer(entry.container, api);
    try {
      await renderer.render(content, sprinkleName);
    } catch (err) {
      log.warn('Sprinkle re-render failed during reload', {
        sprinkleName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (this.disposed || !this.open.has(sprinkleName)) {
      renderer.dispose();
      return;
    }

    entry.renderer = renderer;
    log.info('Sprinkle reloaded in place', { sprinkleName });
  }

  /** Tear down all open sprinkles. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const name of [...this.open.keys()]) this.closeLocally(name);
    this.pendingUpdates.clear();
    this.latestDesiredOpen.clear();
    // Sprinkles still in `opening` (in-flight `openLocally` mid-await) have
    // bridge listeners registered against `updateListeners` that
    // `closeLocally` above didn't clear (because they aren't in `this.open`
    // yet). The post-render cleanup branch in `openLocally` will handle
    // them when its await resolves, but clearing here defends against a
    // future change to that branch and against GC retention through the
    // unsubscribed bridge closures.
    this.updateListeners.clear();
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
      this.pendingUpdates.delete(name);
      log.warn('Failed to fetch sprinkle content from leader', {
        sprinkleName: name,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Re-check both guards after the await: the controller may have been
    // disposed, OR the leader may have closed the sprinkle while the fetch
    // was in flight. In either case we must NOT attach — otherwise we'd
    // leave a zombie sprinkle in the rail that the next reconcile would
    // tear down (visible UX regression).
    if (this.disposed || !this.latestDesiredOpen.has(name)) {
      this.opening.delete(name);
      this.pendingUpdates.delete(name);
      return;
    }

    const container = document.createElement('div');
    container.className = 'sprinkle-panel';
    container.style.cssText =
      'width: 100%; height: 100%; display: flex; flex-direction: column; overflow-y: auto;';
    container.dataset.sprinkle = name;

    const api = this.createBridge(name);
    const renderer = new SprinkleRenderer(container, api);

    // Surface in the layout BEFORE render so the (possible) sandbox iframe
    // gets attached to a live DOM subtree — iframes in detached subtrees
    // don't fire `load`. Matches `SprinkleManager.open` ordering.
    //
    // We do NOT publish into `this.open` yet — keeping the sprinkle in
    // `opening` until render completes ensures any `sprinkle.update`
    // arriving during render continues to buffer (latest wins), instead
    // of taking the live `pushUpdate` path and then getting overwritten
    // by a stale buffered replay (R2-CRIT-1: order inversion).
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

    // The controller may have been disposed (or the leader may have closed
    // this sprinkle) while render was running. Tear down rather than
    // attach. Must mirror `closeLocally` exactly — in particular clearing
    // `updateListeners` so a CLI-inline `slicc.on('update', cb)` registered
    // during the just-completed render doesn't leak into a future re-open.
    if (this.disposed || !this.latestDesiredOpen.has(name)) {
      this.updateListeners.delete(name);
      this.opening.delete(name);
      this.pendingUpdates.delete(name);
      try {
        renderer.dispose();
      } catch (err) {
        log.warn('Sprinkle dispose threw during post-render cleanup', {
          sprinkleName: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      container.remove();
      try {
        this.removeSprinkle(name);
      } catch (err) {
        log.warn('removeSprinkle callback threw during post-render cleanup', {
          sprinkleName: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Transition opening → open AND drain any buffered update in a single
    // synchronous block. Updates arriving from this point flow through the
    // live `handleSprinkleUpdate` → `pushUpdate` path with no risk of
    // interleaving the buffered replay against them.
    this.open.set(name, { renderer, container });
    this.opening.delete(name);
    const buffered = this.pendingUpdates.get(name);
    if (buffered !== undefined) {
      this.pendingUpdates.delete(name);
      renderer.pushUpdate(buffered);
      this.fanOutToListeners(name, buffered);
    }
  }

  /**
   * Fan an update payload out to every callback registered against this
   * sprinkle via the bridge's `on('update', cb)`. Listener exceptions are
   * isolated — one broken handler does not starve siblings.
   */
  private fanOutToListeners(sprinkleName: string, data: unknown): void {
    const listeners = this.updateListeners.get(sprinkleName);
    if (!listeners) return;
    // Snapshot before iterating so a listener calling `off()` mid-fan-out
    // doesn't disturb the iteration order.
    for (const cb of [...listeners]) {
      try {
        cb(data);
      } catch (err) {
        log.warn('Sprinkle update listener threw', {
          sprinkleName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private closeLocally(name: string): void {
    // Clear listeners and pending updates regardless of whether the entry is
    // present — a re-open of the same sprinkle name must not inherit stale
    // listeners or undelivered updates from the previous renderer.
    this.updateListeners.delete(name);
    this.pendingUpdates.delete(name);

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
      on: (event, callback) => {
        if (event !== 'update') return;
        let set = this.updateListeners.get(sprinkleName);
        if (!set) {
          set = new Set();
          this.updateListeners.set(sprinkleName, set);
        }
        set.add(callback);
      },
      off: (event, callback) => {
        if (event !== 'update') return;
        const set = this.updateListeners.get(sprinkleName);
        set?.delete(callback);
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
        } catch (err) {
          // Real failure modes here: QuotaExceededError, SecurityError
          // (Safari private mode), JSON.stringify on circular refs. The
          // sprinkle silently loses its persisted state — log so the
          // failure is at least observable in DevTools.
          log.warn('Sprinkle setState failed', {
            sprinkleName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      getState: () => {
        try {
          const raw = localStorage.getItem(`slicc-sprinkle-state:${sprinkleName}`);
          return raw ? JSON.parse(raw) : null;
        } catch (err) {
          log.warn('Sprinkle getState failed', {
            sprinkleName,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      },
      open: (path: string) => {
        if (this.openPath) {
          this.openPath(path);
          return;
        }
        const url = /^https?:|^chrome-extension:/.test(path) ? path : toPreviewUrl(path);
        window.open(url, '_blank');
      },
      close: () => this.closeLocally(sprinkleName),
      minimize: () => {
        // Follower-rendered sprinkles don't have a managed rail — minimize
        // is a local UI operation on the leader. No-op on the follower side.
      },
      stopCone: () => {
        // Special-case action that the leader's lick router maps to "abort
        // the cone agent." Matches iOS `SprinkleWebView` `case "stopCone"`.
        this.sync.sendSprinkleLick(sprinkleName, { action: '__stopCone__' });
      },
      attachImage: () => {
        // No-op on follower — the follower doesn't own the chat input.
      },
      captureScreen: () =>
        Promise.reject(new Error('captureScreen not supported in follower-rendered sprinkle')),
      // The follower has no addressable worker shell on the leader, so
      // shell exec / agent spawn degrade to a clean non-zero result
      // rather than throwing into the sprinkle (mirrors the bridge's
      // "missing handler" contract).
      exec: Object.assign(
        () =>
          Promise.resolve({
            stdout: '',
            stderr: 'exec not supported in follower-rendered sprinkle\n',
            exitCode: 127,
          }),
        {
          spawn: () =>
            Promise.resolve({
              stdout: '',
              stderr: 'exec.spawn not supported in follower-rendered sprinkle\n',
              exitCode: 127,
            }),
        }
      ) as SprinkleBridgeAPI['exec'],
      agent: () =>
        Promise.resolve({
          stdout: 'agent not supported in follower-rendered sprinkle\n',
          exitCode: 127,
        }),
      // The Tier 1 jsh globals all require the leader's worker realm,
      // which the follower can't reach, so they reject with a clear
      // error rather than silently no-op.
      fetch: () => Promise.reject(new Error('fetch not supported in follower-rendered sprinkle')),
      http: {
        client: () => {
          const reject = () =>
            Promise.reject(new Error('http not supported in follower-rendered sprinkle'));
          return { get: reject, post: reject, put: reject, patch: reject, delete: reject };
        },
      },
      browser: {
        findTab: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
        ensureTab: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
        eval: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
        evalAsync: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
        cookie: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
        localStorage: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
        fetch: () =>
          Promise.reject(new Error('browser not supported in follower-rendered sprinkle')),
      },
      // The page-side device registries live on the leader and aren't
      // addressable from a follower. Reject every call with a clean
      // error rather than silently no-op so follower sprinkles surface
      // the unsupported path immediately.
      hid: {
        list: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        request: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        open: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        close: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        sendReport: () =>
          Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        on: () => {
          /* follower has no leader-side push channel for input reports */
        },
        off: () => {
          /* follower has no leader-side push channel for input reports */
        },
      },
      serial: {
        list: () => Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
        request: () =>
          Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
        open: () => Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
        close: () =>
          Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
      },
      usb: {
        list: () => Promise.reject(new Error('usb not supported in follower-rendered sprinkle')),
        request: () => Promise.reject(new Error('usb not supported in follower-rendered sprinkle')),
        open: () => Promise.reject(new Error('usb not supported in follower-rendered sprinkle')),
        close: () => Promise.reject(new Error('usb not supported in follower-rendered sprinkle')),
      },
      readFileBinary: () =>
        Promise.reject(new Error('readFileBinary not supported in follower-rendered sprinkle')),
      writeFileBinary: () =>
        Promise.reject(new Error('writeFileBinary not supported in follower-rendered sprinkle')),
      fetchToFile: () =>
        Promise.reject(new Error('fetchToFile not supported in follower-rendered sprinkle')),
      _jsh: () =>
        Promise.reject(new Error('jsh globals not supported in follower-rendered sprinkle')),
      _device: () =>
        Promise.reject(new Error('device ops not supported in follower-rendered sprinkle')),
    };
    return api;
  }
}
