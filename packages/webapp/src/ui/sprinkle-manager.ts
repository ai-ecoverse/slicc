/**
 * Sprinkle Manager — registry of available and open `.shtml` sprinkles,
 * and their placement in the layout.
 */

import { createLogger } from '../core/logger.js';
import type { FsWatcher, VirtualFS } from '../fs/index.js';
import { getPanelRpcClient, hasLocalDom } from '../kernel/panel-rpc.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import {
  type CaptureScreenResult,
  SprinkleBridge,
  type SprinkleExecHandler,
} from './sprinkle-bridge.js';
import { discoverSprinkles, type Sprinkle } from './sprinkle-discovery.js';
import { SprinkleRenderer } from './sprinkle-renderer.js';
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
  /**
   * Open the panel without activating it in the layout. Used by session
   * restore: the page's own view state (e.g. the `ws` URL param) decides
   * what is focused after a reload — restoring panels must not steal it.
   * Unlike `attention`, the sprinkle still counts as user-opened for
   * persistence (it stays in the `sprinkles` URL param).
   */
  background?: boolean;
}

export interface SprinkleAddOptions extends AddSprinkleOptions {
  /**
   * Raw icon spec from the .shtml. Forwarded so the layout can
   * render a per-sprinkle rail glyph instead of the generic
   * Sparkles default. See `sprinkle-icon.ts` for accepted formats.
   */
  icon?: string;
}

export interface SprinkleManagerCallbacks {
  /** Called to add a sprinkle to the layout (standalone: right column, extension: tab). */
  addSprinkle(
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: SprinkleAddOptions
  ): void;
  /** Called to remove a sprinkle from the layout. */
  removeSprinkle(name: string): void;
  /** Called to collapse the rail content panel without destroying the sprinkle. */
  minimizeSprinkle(name: string): void;
  /**
   * Called when a sprinkle is discovered in the VFS so its rail icon
   * can be added independently of `open()`. The layout treats the
   * icon as a launcher — clicking it routes back through the
   * activation callback. Optional for back-compat with callers that
   * don't surface always-visible rail icons (e.g. the follower
   * controller, which is told what to render by the leader).
   */
  registerSprinkle?(name: string, title: string, options?: { icon?: string; zone?: string }): void;
  /**
   * Called when a sprinkle disappears from the VFS so the layout
   * can remove its rail icon. Optional for back-compat.
   */
  unregisterSprinkle?(name: string): void;
  /**
   * Called when a sprinkle is closed but its rail icon should stay
   * (it's still in `availableSprinkles`). The layout clears the
   * panel content and collapses the rail panel without removing
   * the icon. Falls back to `removeSprinkle` when unset, preserving
   * the legacy "close → icon gone" behavior for callers that
   * haven't opted into always-visible icons.
   */
  closeSprinkleContent?(name: string): void;
}

const OPEN_SPRINKLES_KEY = 'slicc-open-sprinkles';
/**
 * Query parameter that carries the open-sprinkles set. URL is the
 * primary source of truth — a manual reload / shared link restores the
 * exact same panels. `OPEN_SPRINKLES_KEY` (localStorage) is kept for
 * one release as a migration fallback: `restoreOpenSprinkles` reads it
 * only when the URL has no `sprinkles` param, then clears it. New
 * writes go to both URL and localStorage during this window so a
 * downgrade in mid-migration doesn't lose the user's open set (see the
 * spec's Rollback Plan).
 */
const URL_OPEN_SPRINKLES_PARAM = 'sprinkles';

/**
 * Read the open-sprinkles set from the URL. Returns `null` when the
 * `sprinkles` param is absent (signaling "fall back to legacy or
 * first-run"); returns `[]` when the param is present-but-empty
 * (signaling "explicitly nothing open"). Safe to call from any
 * context — returns `null` outside the DOM (worker, SSR).
 */
export function readOpenSprinklesFromUrl(): string[] | null {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(URL_OPEN_SPRINKLES_PARAM);
    if (raw === null) return null;
    if (raw === '') return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/**
 * Replace the `sprinkles` query param without touching other params
 * (e.g. `tray`, `detached`) or pushing a new history entry. Empty
 * list removes the param entirely so a shared URL with no open
 * sprinkles doesn't grow `?sprinkles=`. No-ops outside the DOM.
 */
export function writeOpenSprinklesToUrl(names: readonly string[]): void {
  try {
    if (
      typeof window === 'undefined' ||
      !window.location ||
      typeof history === 'undefined' ||
      typeof history.replaceState !== 'function'
    ) {
      return;
    }
    const url = new URL(window.location.href);
    if (names.length === 0) {
      url.searchParams.delete(URL_OPEN_SPRINKLES_PARAM);
    } else {
      // Join with raw commas — names are basenames of `.shtml` files
      // and never contain commas. Leaving commas unencoded keeps the
      // URL readable in the address bar.
      url.searchParams.set(URL_OPEN_SPRINKLES_PARAM, names.join(','));
    }
    const next = url.pathname + url.search + url.hash;
    history.replaceState(history.state ?? null, '', next);
  } catch {
    /* history not writable, ignore */
  }
}
/**
 * Persistent ledger of every sprinkle name we've ever discovered in
 * this profile. When `restoreOpenSprinkles()` runs and finds an
 * entry in `availableSprinkles` that isn't in the ledger, it's a
 * just-installed sprinkle that hasn't been surfaced yet — open it
 * in attention mode so the rail icon shows up.
 */
const KNOWN_SPRINKLES_KEY = 'slicc-known-sprinkles';

/**
 * Prune the known-sprinkles ledger to names a COMPLETED discovery confirmed.
 * The ledger is otherwise monotonic (absent names are kept so they don't
 * re-surface as "new"), but names whose files are genuinely gone would ghost
 * the seeded rail forever — hosts prune after a discovery that found results.
 */
export function pruneKnownSprinkleNames(valid: readonly string[]): void {
  try {
    const keep = new Set(valid);
    const pruned = readKnownSprinkleNames().filter((n) => keep.has(n));
    localStorage.setItem(KNOWN_SPRINKLES_KEY, JSON.stringify(pruned));
  } catch {
    /* localStorage unavailable — ledger stays as-is */
  }
}

/**
 * Names of every sprinkle this profile has ever discovered (the persistent
 * known-sprinkles ledger). Layouts seed their rail launchers from this at
 * boot so the rail isn't empty while the (async, VFS-backed) discovery
 * runs — discovery then trues titles up and prunes uninstalled entries.
 */
export function readKnownSprinkleNames(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_SPRINKLES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
/**
 * One-shot consumption ledger for `data-sprinkle-autoopen` sprinkles.
 * Once a sprinkle has been auto-opened (via the first-run
 * `restoreOpenSprinkles` branch, `surfaceUnseenSprinkles`, or the
 * post-install `runOpenNewAutoOpenSprinkles` path), its name lands
 * here and the three auto-open paths skip it forever after. The user
 * closing the panel won't resurrect it, and an unrelated reset of the
 * known-sprinkles ledger won't either. User-driven opens (rail icon,
 * picker) bypass this ledger entirely.
 */
const AUTOOPENED_ONCE_KEY = 'slicc-autoopened-once';

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
  /**
   * Fired after `sendToSprinkle` pushes data to the local renderer.
   * The standalone-leader boot path in `ui/main.ts:mainStandaloneWorker`
   * (after `startPageLeaderTray`) wires this to
   * `pageLeaderTray.sync.broadcastSprinkleUpdate` so followers receive
   * the agent's push (`sprinkle.update` over the WebRTC channel).
   * Without this hook, `sendToSprinkle` updates only the leader's local
   * renderer — followers see the static initial content but never the
   * live state changes the agent pushes, and the only way to recover
   * is a manual snapshot refresh.
   *
   * Fires only when the named sprinkle is currently open locally;
   * skipped for closed sprinkles (matches the local-render behavior
   * — there's nothing to update on the leader side either).
   *
   * Hook exceptions are caught and logged — a broken broadcaster
   * must not skip the local renderer push or break the sprinkle.
   */
  onSendToSprinkle?: (name: string, data: unknown) => void;
  /** Called when a sprinkle pushes an image into the chat input via slicc.attachImage(). */
  onAttachImage?: (base64: string, name?: string, mimeType?: string) => void;
  /**
   * Sprinkle names whose `.shtml` file should NEVER surface a rail
   * icon (they back inline dips rendered elsewhere, e.g. the welcome
   * sprinkle). Matched by basename against discovered sprinkles
   * before `registerSprinkle` is invoked. Empty/unset means every
   * discovered sprinkle gets a rail icon.
   */
  inlineSprinkles?: ReadonlySet<string>;
  /**
   * Page→worker shell-exec transport handed to the `SprinkleBridge` so
   * `slicc.exec()` / `slicc.agent()` run in the same worker shell used
   * by `.jsh` / `node -e`. Wired by `ui/main.ts` over a
   * `TerminalSessionClient` on both the standalone-worker and extension
   * boot paths. When unset, the bridge surfaces a clean
   * "shell bridge not available" result instead of throwing.
   */
  execHandler?: SprinkleExecHandler;
}

/**
 * Roots that `discoverSprinkles` actually mines for `.shtml` files.
 * The watcher only registers under these so saves inside mounted
 * project folders (which can sit anywhere in the VFS) don't trigger
 * a full sprinkle rescan on every keystroke.
 */
const WATCHER_ROOTS = ['/workspace', '/shared', '/scoops'] as const;

/**
 * Minimum gap between back-to-back rescans triggered by
 * `openNewAutoOpenSprinkles()`. Coalesces watcher events and
 * post-install hooks (upskill, drag-drop, manual writes) that
 * otherwise drive two passes for the same install burst.
 */
const REFRESH_COOLDOWN_MS = 250;

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
  /**
   * Sprinkle names whose rail entry is currently in attention-only
   * mode. They're tracked so they're excluded from
   * `slicc-open-sprinkles` — the user never actually opened the
   * panel, and persisting them as user-opened would resurrect
   * uninvited panels on every reload.
   */
  private attentionOnly = new Set<string>();
  private inflightRefresh: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private autoOpenBehavior: 'activate' | 'attention';
  private onSendToSprinkle?: (name: string, data: unknown) => void;
  /**
   * Names whose rail icons have been pushed to the layout via
   * `callbacks.registerSprinkle`. Used to diff against the next
   * `refresh()` discovery and surface install/uninstall as icon
   * register/unregister events. Empty when the callback is unset
   * (legacy callers that don't surface always-visible icons).
   */
  private registeredSprinkles = new Set<string>();
  private readonly inlineSprinkles: ReadonlySet<string>;
  private readonly changeListeners = new Set<() => void>();
  private changeNotifyScheduled = false;
  /**
   * Coalesce URL writes — `open()` + `close()` bursts inside a single
   * microtask should produce ONE `history.replaceState` call against
   * the final snapshot, not one per mutation. Without this an
   * open-then-immediately-close sequence (e.g. restore + auto-close)
   * spams history and wastes the chance to keep the address bar quiet.
   */
  private urlWriteScheduled = false;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    callbacks: SprinkleManagerCallbacks,
    stopConeHandler: () => void,
    options: SprinkleManagerOptions = {}
  ) {
    this.fs = fs;

    const captureScreenHandler = async (): Promise<CaptureScreenResult> => {
      const mimeType = 'image/png';
      const quality = 1.0;

      const local = hasLocalDom();
      const panelRpc = getPanelRpcClient();

      if (!local && !panelRpc) {
        throw new Error('Screen capture unavailable in this environment');
      }

      if (local && !navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen capture not supported in this browser');
      }

      let bytes: ArrayBuffer;
      let width: number;
      let height: number;

      if (local) {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        try {
          const video = document.createElement('video');
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () =>
              video
                .play()
                .then(() => resolve())
                .catch(reject);
            video.onerror = () => reject(new Error('Failed to load video stream'));
          });
          await new Promise<void>((r) => setTimeout(r, 100));
          width = video.videoWidth;
          height = video.videoHeight;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Failed to get canvas context');
          ctx.drawImage(video, 0, 0, width, height);
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error('Failed to create image blob'))),
              mimeType,
              quality
            );
          });
          bytes = await blob.arrayBuffer();
        } finally {
          for (const t of stream.getTracks()) t.stop();
        }
      } else {
        const result = await panelRpc!.call(
          'screencapture',
          { mimeType, quality },
          { timeoutMs: 5 * 60_000 }
        );
        bytes = result.bytes;
        width = result.width;
        height = result.height;
      }

      const uint8 = new Uint8Array(bytes);
      const parts: string[] = [];
      const chunk = 8192;
      for (let i = 0; i < uint8.length; i += chunk) {
        parts.push(String.fromCharCode(...uint8.subarray(i, i + chunk)));
      }
      const base64 = btoa(parts.join(''));
      return { base64, width, height, mimeType };
    };

    this.bridge = new SprinkleBridge(
      fs,
      lickHandler,
      (name) => this.close(name),
      (name) => this.minimize(name),
      stopConeHandler,
      options.onAttachImage ?? (() => {}),
      captureScreenHandler,
      options.execHandler,
      // Forward host-pushed device events (currently `hid:inputreport`)
      // to the open sprinkle's iframe via the renderer's
      // `pushDeviceEvent`. Inline-mode sprinkles never go through here
      // — their listeners are invoked directly inside the bridge.
      (name, channel, payload) => {
        const entry = this.openSprinkles.get(name);
        entry?.renderer.pushDeviceEvent(channel, payload);
      }
    );
    this.callbacks = callbacks;
    this.autoOpenBehavior = options.autoOpenBehavior ?? 'activate';
    this.onSendToSprinkle = options.onSendToSprinkle;
    this.inlineSprinkles = options.inlineSprinkles ?? new Set();
  }

  /**
   * Replace the leader-broadcast hook after construction. Used by the
   * standalone-leader boot path in `ui/main.ts`: `SprinkleManager` is
   * built unconditionally early in `mainStandaloneWorker`, while
   * `startPageLeaderTray` runs later inside the `storedWorkerBaseUrl`
   * branch and reads `sprinkleManager`-backed callbacks (`getSprinkles`,
   * `readSprinkleContent`) into its options. The manager therefore
   * has to exist first, but the hook back into the tray's sync can
   * only be installed once `pageLeaderTray.sync` is available.
   * Calling this with `undefined` detaches the hook — currently invoked
   * by the `slicc:tray-join` listener in `ui/main.ts` when the standalone
   * runtime switches from leader to follower mode. (`host reset` does
   * NOT detach: it calls `pageLeaderTray.reset()` which keeps the same
   * `sync` instance alive so the hook stays functional.)
   */
  setSendToSprinkleHook(hook: ((name: string, data: unknown) => void) | undefined): void {
    if (this.onSendToSprinkle && !hook) {
      // Audit a defined → undefined transition at `error` level —
      // prod log gate is ERROR, so `info` would be suppressed
      // exactly when operators need this signal. In-flight
      // `sendToSprinkle` calls between this detach and the next attach
      // (e.g. mid-transition from leader to follower mode) silently
      // drop the broadcast half — leader-local rendering still works,
      // but followers never see the update. Mode switches are
      // user-driven and rare, so error-level isn't noisy; QA reports
      // "sprinkle blank on follower after mode switch" map cleanly to
      // this entry.
      log.error('SprinkleManager broadcast hook detached');
    }
    this.onSendToSprinkle = hook;
  }

  /** Restore sprinkles that were open in the previous session.
   *  URL `?sprinkles=` is the primary source of truth — a manual
   *  reload or shared link reopens the same panels. When the URL
   *  has no `sprinkles` param we fall back to the legacy
   *  `slicc-open-sprinkles` localStorage entry once (then clear it).
   *  On first run (no URL param AND no localStorage entry),
   *  auto-open sprinkles marked with data-sprinkle-autoopen.
   *  Always surfaces sprinkles that have landed in the VFS since
   *  the last time the panel saw them (skill installs in a prior
   *  session, or the very first time we boot a profile that
   *  predates the known-sprinkles ledger). */
  async restoreOpenSprinkles(): Promise<void> {
    try {
      const urlNames = readOpenSprinklesFromUrl();
      if (urlNames !== null) {
        await this.reopenInBackground(urlNames);
        // URL is the explicit source of truth — a shared link should
        // reopen exactly the panels it names. Skip the unseen-surfacing
        // pass so a fresh profile loading `?sprinkles=dash` doesn't
        // also attention-surface every other discoverable sprinkle.
        return;
      }
      const raw = localStorage.getItem(OPEN_SPRINKLES_KEY);
      if (raw) await this.restoreFromLegacyStorage(raw);
      else await this.autoOpenFirstRun();
    } catch {
      /* corrupt localStorage, ignore */
    }
    await this.surfaceUnseenSprinkles();
  }

  /**
   * Reopen restored panels in BACKGROUND mode: the panel comes back but must
   * not steal focus — what's on screen after a reload is the page's own view
   * state (the `ws` URL param), not the open set. Per-name failures warn and
   * continue.
   */
  private async reopenInBackground(names: readonly string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.open(name, undefined, { background: true });
      } catch {
        log.warn('Failed to restore sprinkle', { name });
      }
    }
  }

  /**
   * One-time migration: legacy localStorage → URL. The `open()` calls each
   * re-persist (URL + localStorage), and after the burst the legacy key is
   * cleared so future reloads take the URL branch.
   */
  private async restoreFromLegacyStorage(raw: string): Promise<void> {
    try {
      await this.reopenInBackground(JSON.parse(raw) as string[]);
    } finally {
      try {
        localStorage.removeItem(OPEN_SPRINKLES_KEY);
      } catch {
        /* localStorage unavailable, ignore */
      }
    }
  }

  /**
   * First run (no URL param, no legacy storage): open `data-sprinkle-autoopen`
   * sprinkles not yet consumed by the one-shot ledger. Non-autoopen sprinkles
   * get their rail icon via `surfaceUnseenSprinkles()` instead.
   */
  private async autoOpenFirstRun(): Promise<void> {
    const attention = this.autoOpenBehavior === 'attention';
    const autoOpenedOnce = this.loadAutoOpenedOnce();
    const consumed = new Set<string>();
    for (const sprinkle of this.availableSprinkles.values()) {
      if (!sprinkle.autoOpen || autoOpenedOnce.has(sprinkle.name)) continue;
      try {
        await this.open(sprinkle.name, undefined, { attention });
        consumed.add(sprinkle.name);
      } catch {
        log.warn('Failed to auto-open sprinkle', { name: sprinkle.name });
      }
    }
    if (consumed.size > 0) this.persistAutoOpenedOnce(consumed);
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
    const autoOpenedOnce = this.loadAutoOpenedOnce();
    const attentionForAutoOpen = this.autoOpenBehavior === 'attention';
    const consumed = new Set<string>();
    for (const sprinkle of this.availableSprinkles.values()) {
      if (known.has(sprinkle.name)) continue;
      if (this.openSprinkles.has(sprinkle.name)) continue;
      // Auto-open sprinkles are one-shot: if we've already consumed
      // this one in a prior session, skip it entirely even though
      // the known-sprinkles ledger doesn't list it.
      if (sprinkle.autoOpen && autoOpenedOnce.has(sprinkle.name)) continue;
      try {
        await this.open(sprinkle.name, undefined, {
          attention: sprinkle.autoOpen ? attentionForAutoOpen : true,
        });
        if (sprinkle.autoOpen) consumed.add(sprinkle.name);
        log.info('Surfaced previously-unseen sprinkle', { name: sprinkle.name });
      } catch {
        log.warn('Failed to surface unseen sprinkle', { name: sprinkle.name });
      }
    }
    this.persistKnownSprinkles(new Set(this.availableSprinkles.keys()));
    if (consumed.size > 0) this.persistAutoOpenedOnce(consumed);
  }

  private loadKnownSprinkles(): Set<string> {
    return new Set(readKnownSprinkleNames());
  }

  /**
   * Union the given names into the persistent ledger. The ledger is
   * monotonic — a previously-known sprinkle that is temporarily
   * absent (mount unavailable, branch checkout, transient FS error)
   * must NOT be forgotten, otherwise it would re-surface as "new"
   * and pulse for attention again the next time it reappears.
   */
  private persistKnownSprinkles(names: Set<string>): void {
    try {
      const merged = new Set<string>([...this.loadKnownSprinkles(), ...names]);
      localStorage.setItem(KNOWN_SPRINKLES_KEY, JSON.stringify([...merged]));
    } catch {
      /* localStorage full, ignore */
    }
  }

  private loadAutoOpenedOnce(): Set<string> {
    try {
      const raw = localStorage.getItem(AUTOOPENED_ONCE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
    } catch {
      return new Set();
    }
  }

  /**
   * Union the given names into the persistent one-shot ledger. Like
   * `persistKnownSprinkles`, the merge is monotonic — once a
   * `data-sprinkle-autoopen` sprinkle has been auto-opened, the
   * ledger entry stays even if the sprinkle disappears from the VFS
   * (uninstall, branch checkout, mount unavailable) so a later
   * reappearance does NOT re-trigger the welcome flow.
   */
  private persistAutoOpenedOnce(names: Set<string>): void {
    try {
      const merged = new Set<string>([...this.loadAutoOpenedOnce(), ...names]);
      localStorage.setItem(AUTOOPENED_ONCE_KEY, JSON.stringify([...merged]));
    } catch {
      /* localStorage full, ignore */
    }
  }

  /**
   * Persist only sprinkles the user has actively opened. Entries
   * still in `attentionOnly` (passive surfacing, never clicked) are
   * filtered out — restoring a panel the user never engaged with
   * would be surprising on reload.
   *
   * URL `?sprinkles=...` is the primary store (so reload / shared
   * link restores the same panels). `slicc-open-sprinkles` in
   * localStorage is still written during this release as a safety
   * net for downgrades and as the migration source for the
   * URL-aware `restoreOpenSprinkles` branch. The URL write is
   * coalesced via `queueMicrotask` so an open+close burst yields
   * one `history.replaceState`, not several.
   */
  private persistOpenSprinkles(): void {
    try {
      const userOpened = [...this.openSprinkles.keys()].filter(
        (name) => !this.attentionOnly.has(name)
      );
      localStorage.setItem(OPEN_SPRINKLES_KEY, JSON.stringify(userOpened));
    } catch {
      /* localStorage full, ignore */
    }
    this.schedulePersistOpenSprinklesToUrl();
  }

  private schedulePersistOpenSprinklesToUrl(): void {
    if (this.urlWriteScheduled) return;
    this.urlWriteScheduled = true;
    queueMicrotask(() => {
      this.urlWriteScheduled = false;
      const userOpened = [...this.openSprinkles.keys()].filter(
        (name) => !this.attentionOnly.has(name)
      );
      writeOpenSprinklesToUrl(userOpened);
    });
  }

  /**
   * Refresh and surface newly-discovered sprinkles in the rail.
   *
   * Only sprinkles that just appeared in the VFS (relative to the
   * pre-refresh available set) are surfaced. Pre-existing sprinkles
   * are left alone — if the user has closed an auto-open sprinkle,
   * an unrelated `.shtml` write must NOT pop it back open.
   *
   * - `data-sprinkle-autoopen` + isNew → honor `autoOpenBehavior`
   *   (panel activates in standalone, attention-pulse in extension).
   * - Plain new sprinkle → attention mode (icon pulses, panel stays
   *   collapsed; doesn't cover whatever the user is doing).
   *
   * Concurrent / back-to-back invocations within
   * `REFRESH_COOLDOWN_MS` are coalesced. Watcher events and the
   * post-install `refreshSprinklesAfterInstall()` hook would
   * otherwise fire two passes for the same install burst.
   */
  async openNewAutoOpenSprinkles(): Promise<void> {
    if (this.inflightRefresh) return this.inflightRefresh;
    if (Date.now() - this.lastRefreshAt < REFRESH_COOLDOWN_MS) return;
    this.inflightRefresh = this.runOpenNewAutoOpenSprinkles().finally(() => {
      this.lastRefreshAt = Date.now();
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async runOpenNewAutoOpenSprinkles(): Promise<void> {
    const previouslyKnown = new Set(this.availableSprinkles.keys());
    await this.refresh();
    const attentionForAutoOpen = this.autoOpenBehavior === 'attention';
    const autoOpenedOnce = this.loadAutoOpenedOnce();
    const consumedAutoOpen = new Set<string>();
    let changed = false;
    for (const sprinkle of this.availableSprinkles.values()) {
      if (this.openSprinkles.has(sprinkle.name)) continue;
      const isNew = !previouslyKnown.has(sprinkle.name);
      if (!isNew) continue;
      changed = true;
      if (sprinkle.autoOpen) {
        // Already consumed in a prior session — never auto-open
        // again, even if the known-sprinkles ledger has been reset
        // or the sprinkle was uninstalled and reappeared.
        if (autoOpenedOnce.has(sprinkle.name)) {
          log.info('Skipped one-shot auto-open for previously-consumed sprinkle', {
            name: sprinkle.name,
          });
          continue;
        }
        try {
          await this.open(sprinkle.name, undefined, { attention: attentionForAutoOpen });
          consumedAutoOpen.add(sprinkle.name);
          log.info('Auto-opened new sprinkle after install', {
            name: sprinkle.name,
            attention: attentionForAutoOpen,
          });
        } catch {
          log.warn('Failed to auto-open new sprinkle', { name: sprinkle.name });
        }
      } else {
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
    if (consumedAutoOpen.size > 0) {
      this.persistAutoOpenedOnce(consumedAutoOpen);
    }
  }

  /** Scan VFS and update available sprinkles. */
  async refresh(): Promise<void> {
    this.availableSprinkles = await discoverSprinkles(this.fs);
    log.info('Discovered sprinkles', { count: this.availableSprinkles.size });
    this.syncRegisteredIcons();
    this.notifyChange();
  }

  /**
   * Diff `availableSprinkles` against the layout's registered rail
   * icons and surface install/uninstall as register/unregister
   * callbacks. No-op when `callbacks.registerSprinkle` is unset
   * (legacy callers that don't surface always-visible icons).
   *
   * `inlineSprinkles` are filtered out so dip-only sprinkles never
   * leak into the rail. An open sprinkle that has disappeared from
   * the VFS is closed first so its content unmounts before the icon
   * is dropped.
   */
  private syncRegisteredIcons(): void {
    if (!this.callbacks.registerSprinkle) return;
    const next = new Set<string>();
    for (const sprinkle of this.availableSprinkles.values()) {
      if (this.inlineSprinkles.has(sprinkle.name)) continue;
      next.add(sprinkle.name);
    }
    for (const sprinkle of this.availableSprinkles.values()) {
      if (!next.has(sprinkle.name)) continue;
      if (this.registeredSprinkles.has(sprinkle.name)) continue;
      try {
        this.callbacks.registerSprinkle(sprinkle.name, sprinkle.title, {
          icon: sprinkle.icon,
        });
        this.registeredSprinkles.add(sprinkle.name);
      } catch (err) {
        log.warn('registerSprinkle callback threw', {
          name: sprinkle.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const name of [...this.registeredSprinkles]) {
      if (next.has(name)) continue;
      if (this.openSprinkles.has(name)) this.close(name);
      try {
        this.callbacks.unregisterSprinkle?.(name);
      } catch (err) {
        log.warn('unregisterSprinkle callback threw', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.registeredSprinkles.delete(name);
    }
  }

  /**
   * Subscribe to coalesced change notifications. Fires after `refresh()`,
   * `open()`, `close()`, and `markActivated()` mutate the available/opened
   * state. Multiple mutations within a single microtask collapse into a
   * single notification — the listener observes the post-mutation snapshot
   * rather than every intermediate step. Used by the panel-side leader
   * sync (`installLeaderHooks`) to push sprinkle snapshots to followers.
   *
   * Returns an unsubscribe function. Listener exceptions are caught and
   * logged so a broken subscriber can't break the manager or other
   * subscribers.
   */
  onChange(handler: () => void): () => void {
    this.changeListeners.add(handler);
    return () => {
      this.changeListeners.delete(handler);
    };
  }

  private notifyChange(): void {
    if (this.changeNotifyScheduled) return;
    this.changeNotifyScheduled = true;
    queueMicrotask(() => {
      this.changeNotifyScheduled = false;
      for (const fn of this.changeListeners) {
        try {
          fn();
        } catch (err) {
          log.error('SprinkleManager.onChange handler threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
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
    if (options.attention) this.attentionOnly.add(name);
    else this.attentionOnly.delete(name);
    this.callbacks.addSprinkle(name, sprinkle.title, container, zone, {
      ...options,
      icon: sprinkle.icon,
    });

    const api = this.bridge.createAPI(name);
    const renderer = new SprinkleRenderer(container, api);
    await renderer.render(content, name);

    this.openSprinkles.get(name)!.renderer = renderer;
    this.persistOpenSprinkles();
    trackSprinkleView(name);
    log.info('Sprinkle opened', { name, title: sprinkle.title });
    this.notifyChange();
  }

  /**
   * Mark an attention-mode sprinkle as user-activated. Called from
   * the layout when the user clicks a pulsing rail icon — flips the
   * entry from passive surfacing to genuinely "open", so it now
   * persists into `slicc-open-sprinkles` and survives reload.
   */
  markActivated(name: string): void {
    if (!this.attentionOnly.has(name)) return;
    this.attentionOnly.delete(name);
    this.persistOpenSprinkles();
    log.info('Sprinkle promoted from attention to user-opened', { name });
    this.notifyChange();
  }

  /**
   * Route a rail-icon click to the right action based on current
   * state. When the sprinkle was surfaced in attention mode, promote
   * it to user-opened (`markActivated`). When it has a registered
   * rail icon but no content yet, open it. Already-open user-driven
   * entries get no extra work — the rail-zone toggle has already
   * shown the panel.
   */
  async activate(name: string, zone?: string): Promise<void> {
    if (this.attentionOnly.has(name)) {
      this.markActivated(name);
      return;
    }
    if (!this.openSprinkles.has(name)) {
      try {
        await this.open(name, zone);
      } catch (err) {
        log.warn('Failed to open sprinkle from rail-icon click', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Close a sprinkle by name. */
  close(name: string): void {
    const entry = this.openSprinkles.get(name);
    if (!entry) return;

    entry.renderer?.dispose();
    entry.container.remove();
    this.bridge.removeSprinkle(name);
    this.openSprinkles.delete(name);
    this.attentionOnly.delete(name);
    // Prefer `closeSprinkleContent` so the rail icon survives the
    // close — the sprinkle is still in `availableSprinkles` and
    // clicking the icon should reopen it. Fall back to the legacy
    // `removeSprinkle` for callers that haven't opted into
    // always-visible icons (back-compat for tests and any caller
    // wired before the split).
    if (this.callbacks.closeSprinkleContent) {
      this.callbacks.closeSprinkleContent(name);
    } else {
      this.callbacks.removeSprinkle(name);
    }
    this.persistOpenSprinkles();
    log.info('Sprinkle closed', { name });
    this.notifyChange();
  }

  /**
   * Minimize (collapse) a sprinkle by name. The rail icon stays visible and
   * the sprinkle remains open/registered — the user can click the icon to
   * reopen it. No-op if the sprinkle is not open.
   */
  minimize(name: string): void {
    if (!this.openSprinkles.has(name)) return;
    this.callbacks.minimizeSprinkle(name);
    log.info('Sprinkle minimized', { name });
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
   * Set up watchers that auto-surface newly-added `.shtml` files in
   * the rail. Calls `openNewAutoOpenSprinkles()` (refreshes the
   * available list AND surfaces new sprinkles), so non-auto-open
   * sprinkles appear in the rail without a reload.
   *
   * Watches only canonical sprinkle roots (`WATCHER_ROOTS`). A
   * watcher rooted at `/` would re-scan the entire VFS on every
   * `.shtml` save anywhere, including saves inside mounted project
   * folders — expensive and unnecessary, since `discoverSprinkles`
   * doesn't surface sprinkles outside these roots.
   *
   * Bursts are coalesced with a small debounce so a single skill
   * install doesn't trigger one refresh per file. Concurrent
   * invocations on the SprinkleManager itself are deduped via
   * `REFRESH_COOLDOWN_MS`.
   */
  setupWatcher(watcher: FsWatcher): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void this.openNewAutoOpenSprinkles().catch((err) => {
          log.warn('Sprinkle refresh on watcher event failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, 150);
    };
    const unsubs: Array<() => void> = WATCHER_ROOTS.map((root) =>
      watcher.watch(root, (path) => path.endsWith('.shtml'), trigger)
    );
    this.watcherUnsub = () => {
      for (const u of unsubs) u();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
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
    // Notify the broadcast hook (wired by `ui/main.ts`'s standalone-
    // leader boot path to `pageLeaderTray.sync.broadcastSprinkleUpdate`)
    // so followers receive the same payload as a `sprinkle.update` over
    // the WebRTC channel. Hook exceptions are swallowed — a broken
    // broadcaster must not skip or undo the local pushes above.
    if (this.onSendToSprinkle) {
      try {
        this.onSendToSprinkle(name, data);
      } catch (err) {
        // `error` not `warn` — prod default log level is ERROR. A
        // broken broadcaster here would silently drop the agent's
        // sprinkle push for every connected follower with no log
        // signal.
        log.error('onSendToSprinkle hook threw', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
