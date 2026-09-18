import { createLogger } from '../base/logger.js';
import { SPRINKLE_ROOTS } from '../base/sprinkle-roots.js';
import type { FsWatcher, VirtualFS } from '../fs/index.js';
import { getPanelRpcClient, hasLocalDom } from '../kernel/panel-rpc.js';
import { trackSprinkleView } from '../kernel/telemetry.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { LEADER_RUNTIME_ID } from '../shell/sprinkle-instances.js';
import type {
  SprinkleBroadcastResult,
  SprinkleManagerHandle,
  SprinkleOpenOptions,
  SprinkleSendReport,
  SprinkleSendTarget,
} from '../shell/sprinkle-manager-handle.js';
import {
  type CaptureScreenResult,
  SprinkleBridge,
  type SprinkleExecHandler,
} from './sprinkle-bridge.js';
import { discoverSprinkles, type Sprinkle } from './sprinkle-discovery.js';
import { SprinkleRenderer } from './sprinkle-renderer.js';

const log = createLogger('sprinkle-manager');

export interface AddSprinkleOptions {
  attention?: boolean;

  background?: boolean;
}

type SprinkleManagerOpenOptions = AddSprinkleOptions & SprinkleOpenOptions;

export interface SprinkleAddOptions extends AddSprinkleOptions {
  icon?: string;
}

export interface SprinkleManagerCallbacks {
  addSprinkle(
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: SprinkleAddOptions
  ): void;

  removeSprinkle(name: string): void;

  minimizeSprinkle(name: string): void;

  registerSprinkle?(name: string, title: string, options?: { icon?: string; zone?: string }): void;

  unregisterSprinkle?(name: string): void;

  closeSprinkleContent?(name: string): void;
}

const OPEN_SPRINKLES_KEY = 'slicc-open-sprinkles';

const URL_OPEN_SPRINKLES_PARAM = 'sprinkles';

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
      url.searchParams.set(URL_OPEN_SPRINKLES_PARAM, names.join(','));
    }
    const next = url.pathname + url.search + url.hash;
    history.replaceState(history.state ?? null, '', next);
  } catch {}
}

const KNOWN_SPRINKLES_KEY = 'slicc-known-sprinkles';

export function pruneKnownSprinkleNames(valid: readonly string[]): void {
  try {
    const keep = new Set(valid);
    const pruned = readKnownSprinkleNames().filter((n) => keep.has(n));
    localStorage.setItem(KNOWN_SPRINKLES_KEY, JSON.stringify(pruned));
  } catch {}
}

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

const AUTOOPENED_ONCE_KEY = 'slicc-autoopened-once';

export type SprinkleBroadcastHook = (
  name: string,
  data: unknown,
  target?: SprinkleSendTarget
) => SprinkleBroadcastResult | void;

export interface SprinkleManagerOptions {
  autoOpenBehavior?: 'activate' | 'attention';

  onSendToSprinkle?: SprinkleBroadcastHook;

  onSprinkleReloaded?: (name: string) => void;

  onAttachImage?: (base64: string, name?: string, mimeType?: string) => void;

  inlineSprinkles?: ReadonlySet<string>;

  execHandler?: SprinkleExecHandler;

  resolveLickOriginUnitId?: (target: string) => string | undefined;
}

const WATCHER_ROOTS = SPRINKLE_ROOTS;

const REFRESH_COOLDOWN_MS = 250;

export class SprinkleManager implements SprinkleManagerHandle {
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
      lickOriginUnitId?: string;
    }
  >();

  private attentionOnly = new Set<string>();

  private rendererOperationTails = new Map<string, Promise<void>>();
  private inflightRefresh: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private autoOpenBehavior: 'activate' | 'attention';
  private onSendToSprinkle?: SprinkleBroadcastHook;
  private onSprinkleReloaded?: (name: string) => void;
  private readonly resolveLickOriginUnitId?: (target: string) => string | undefined;

  private registeredSprinkles = new Set<string>();
  private readonly inlineSprinkles: ReadonlySet<string>;
  private readonly changeListeners = new Set<() => void>();
  private changeNotifyScheduled = false;

  private urlWriteScheduled = false;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent, originUnitId?: string) => void,
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

      (name, channel, payload) => {
        const entry = this.openSprinkles.get(name);
        entry?.renderer.pushDeviceEvent(channel, payload);
      }
    );
    this.callbacks = callbacks;
    this.autoOpenBehavior = options.autoOpenBehavior ?? 'activate';
    this.onSendToSprinkle = options.onSendToSprinkle;
    this.onSprinkleReloaded = options.onSprinkleReloaded;
    this.resolveLickOriginUnitId = options.resolveLickOriginUnitId;
    this.inlineSprinkles = options.inlineSprinkles ?? new Set();
  }

  setSendToSprinkleHook(hook: SprinkleBroadcastHook | undefined): void {
    if (this.onSendToSprinkle && !hook) {
      log.error('SprinkleManager broadcast hook detached');
    }
    this.onSendToSprinkle = hook;
  }

  setReloadHook(hook: ((name: string) => void) | undefined): void {
    this.onSprinkleReloaded = hook;
  }

  private enqueueRendererOperation(name: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.rendererOperationTails.get(name) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.rendererOperationTails.set(name, current);
    return current.finally(() => {
      if (this.rendererOperationTails.get(name) === current) {
        this.rendererOperationTails.delete(name);
      }
    });
  }

  reload(name: string): Promise<void> {
    return this.enqueueRendererOperation(name, () => this.reloadNow(name));
  }

  private async reloadNow(name: string): Promise<void> {
    const entry = this.openSprinkles.get(name);
    if (!entry) {
      log.info('Cannot reload closed sprinkle', { name });
      return;
    }

    let sprinkle = this.availableSprinkles.get(name);
    if (!sprinkle) {
      await this.refresh();
      sprinkle = this.availableSprinkles.get(name);
    }
    if (!sprinkle) {
      log.warn('Sprinkle not found during reload', { name });
      return;
    }

    const rawContent = await this.fs.readFile(sprinkle.path, { encoding: 'utf-8' });
    if (rawContent === undefined || rawContent === null) {
      log.warn('Failed to read sprinkle content during reload', { name });
      return;
    }
    const content =
      typeof rawContent === 'string' ? rawContent : new TextDecoder('utf-8').decode(rawContent);

    entry.renderer?.dispose();
    this.bridge.removeSprinkle(name);

    const api = this.bridge.createAPI(name, () => entry.lickOriginUnitId);
    const renderer = new SprinkleRenderer(entry.container, api);
    await renderer.render(content, name);

    if (!this.openSprinkles.has(name)) {
      renderer.dispose();
      return;
    }
    entry.renderer = renderer;
    renderer.activateBridgeLifecycle();
    if (!this.openSprinkles.has(name)) return;

    log.info('Sprinkle reloaded', { name });
    this.notifyChange();

    if (this.onSprinkleReloaded) {
      try {
        this.onSprinkleReloaded(name);
      } catch (err) {
        log.error('onSprinkleReloaded hook threw', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async restoreOpenSprinkles(): Promise<void> {
    try {
      const urlNames = readOpenSprinklesFromUrl();
      if (urlNames !== null) {
        await this.reopenInBackground(urlNames);

        return;
      }
      const raw = localStorage.getItem(OPEN_SPRINKLES_KEY);
      if (raw) await this.restoreFromLegacyStorage(raw);
      else await this.autoOpenFirstRun();
    } catch {}
    await this.surfaceUnseenSprinkles();
  }

  private async reopenInBackground(names: readonly string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.open(name, undefined, { background: true });
      } catch {
        log.warn('Failed to restore sprinkle', { name });
      }
    }
  }

  private async restoreFromLegacyStorage(raw: string): Promise<void> {
    try {
      await this.reopenInBackground(JSON.parse(raw) as string[]);
    } finally {
      try {
        localStorage.removeItem(OPEN_SPRINKLES_KEY);
      } catch {}
    }
  }

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

  private async surfaceUnseenSprinkles(): Promise<void> {
    const known = this.loadKnownSprinkles();
    const autoOpenedOnce = this.loadAutoOpenedOnce();
    const attentionForAutoOpen = this.autoOpenBehavior === 'attention';
    const consumed = new Set<string>();
    for (const sprinkle of this.availableSprinkles.values()) {
      if (known.has(sprinkle.name)) continue;
      if (this.openSprinkles.has(sprinkle.name)) continue;

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

  private persistKnownSprinkles(names: Set<string>): void {
    try {
      const merged = new Set<string>([...this.loadKnownSprinkles(), ...names]);
      localStorage.setItem(KNOWN_SPRINKLES_KEY, JSON.stringify([...merged]));
    } catch {}
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

  private persistAutoOpenedOnce(names: Set<string>): void {
    try {
      const merged = new Set<string>([...this.loadAutoOpenedOnce(), ...names]);
      localStorage.setItem(AUTOOPENED_ONCE_KEY, JSON.stringify([...merged]));
    } catch {}
  }

  private persistOpenSprinkles(): void {
    try {
      const userOpened = [...this.openSprinkles.keys()].filter(
        (name) => !this.attentionOnly.has(name)
      );
      localStorage.setItem(OPEN_SPRINKLES_KEY, JSON.stringify(userOpened));
    } catch {}
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

  async openNewAutoOpenSprinkles(): Promise<void> {
    if (this.inflightRefresh !== null) return this.inflightRefresh;
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

  async refresh(): Promise<void> {
    this.availableSprinkles = await discoverSprinkles(this.fs);
    log.info('Discovered sprinkles', { count: this.availableSprinkles.size });
    this.syncRegisteredIcons();
    this.notifyChange();
  }

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

  open(name: string, zone?: string, options: SprinkleManagerOpenOptions = {}): Promise<void> {
    return this.enqueueRendererOperation(name, () => this.openNow(name, zone, options));
  }

  private async openNow(
    name: string,
    zone?: string,
    options: SprinkleManagerOpenOptions = {}
  ): Promise<void> {
    if (this.openSprinkles.has(name)) {
      log.info('Sprinkle already open', { name });
      return;
    }

    let sprinkle = this.availableSprinkles.get(name);
    if (!sprinkle) {
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
      'width: 100%; height: 100%; display: flex; flex-direction: column; overflow-y: auto;';
    container.dataset.sprinkle = name;

    const lickOriginUnitId = options.lickOriginTarget
      ? this.resolveLickOriginUnitId?.(options.lickOriginTarget)
      : undefined;
    const entry = { renderer: null!, container, lickOriginUnitId };
    this.openSprinkles.set(name, entry);
    if (options.attention) this.attentionOnly.add(name);
    else this.attentionOnly.delete(name);
    this.callbacks.addSprinkle(name, sprinkle.title, container, zone, {
      attention: options.attention,
      background: options.background,
      icon: sprinkle.icon,
    });

    const api = this.bridge.createAPI(name, () => entry.lickOriginUnitId);
    const renderer = new SprinkleRenderer(container, api);
    await renderer.render(content, name);

    const openEntry = this.openSprinkles.get(name);
    if (!openEntry) {
      renderer.dispose();
      return;
    }
    openEntry.renderer = renderer;
    renderer.activateBridgeLifecycle();
    if (!this.openSprinkles.has(name)) return;
    this.persistOpenSprinkles();
    trackSprinkleView(name);
    log.info('Sprinkle opened', { name, title: sprinkle.title });
    this.notifyChange();
  }

  markActivated(name: string): void {
    if (!this.attentionOnly.has(name)) return;
    this.attentionOnly.delete(name);
    this.persistOpenSprinkles();
    log.info('Sprinkle promoted from attention to user-opened', { name });
    this.notifyChange();
  }

  async activate(name: string, zone?: string, options: SprinkleOpenOptions = {}): Promise<void> {
    const wasAttentionOnly = this.attentionOnly.has(name);
    const entry = this.openSprinkles.get(name);
    if (wasAttentionOnly && entry && options.lickOriginTarget) {
      entry.lickOriginUnitId = this.resolveLickOriginUnitId?.(options.lickOriginTarget);
    }
    if (wasAttentionOnly) {
      this.markActivated(name);
    }
    if (!entry) {
      try {
        await this.open(name, zone, options);
      } catch (err) {
        log.warn('Failed to open sprinkle from rail-icon click', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const sprinkle = this.availableSprinkles.get(name);
    this.callbacks.addSprinkle(name, sprinkle?.title ?? name, entry.container, zone, {
      icon: sprinkle?.icon,
    });
  }

  close(name: string): void {
    const entry = this.openSprinkles.get(name);
    if (!entry) return;

    entry.renderer?.dispose();
    entry.container.remove();
    this.bridge.removeSprinkle(name);
    this.openSprinkles.delete(name);
    this.attentionOnly.delete(name);

    if (this.callbacks.closeSprinkleContent) {
      this.callbacks.closeSprinkleContent(name);
    } else {
      this.callbacks.removeSprinkle(name);
    }
    this.persistOpenSprinkles();
    log.info('Sprinkle closed', { name });
    this.notifyChange();
  }

  minimize(name: string): void {
    if (!this.openSprinkles.has(name)) return;
    this.callbacks.minimizeSprinkle(name);
    log.info('Sprinkle minimized', { name });
  }

  available(): Sprinkle[] {
    return Array.from(this.availableSprinkles.values());
  }

  opened(): string[] {
    return Array.from(this.openSprinkles.keys());
  }

  lickOriginUnitIdOf(name: string): string | undefined {
    return this.openSprinkles.get(name)?.lickOriginUnitId;
  }

  setupWatcher(watcher: FsWatcher): void {
    let newSprinkleTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const RELOAD_DEBOUNCE_MS = 300;

    const trigger = (events: Array<{ path: string }>) => {
      let needsNewSprinkleScan = false;
      for (const event of events) {
        const matchingName = this.findOpenSprinkleByPath(event.path);
        if (matchingName) {
          const existing = reloadTimers.get(matchingName);
          if (existing) clearTimeout(existing);
          reloadTimers.set(
            matchingName,
            setTimeout(() => {
              reloadTimers.delete(matchingName);
              void this.reload(matchingName).catch((err) => {
                log.warn('Sprinkle reload on watcher event failed', {
                  name: matchingName,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }, RELOAD_DEBOUNCE_MS)
          );
        } else {
          needsNewSprinkleScan = true;
        }
      }

      if (needsNewSprinkleScan && !newSprinkleTimer) {
        newSprinkleTimer = setTimeout(() => {
          newSprinkleTimer = null;
          void this.openNewAutoOpenSprinkles().catch((err) => {
            log.warn('Sprinkle refresh on watcher event failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, 150);
      }
    };
    const unsubs: Array<() => void> = WATCHER_ROOTS.map((root) =>
      watcher.watch(root, (path) => path.endsWith('.shtml'), trigger)
    );
    this.watcherUnsub = () => {
      for (const u of unsubs) u();
      if (newSprinkleTimer) {
        clearTimeout(newSprinkleTimer);
        newSprinkleTimer = null;
      }
      for (const t of reloadTimers.values()) clearTimeout(t);
      reloadTimers.clear();
    };
  }

  private findOpenSprinkleByPath(path: string): string | null {
    for (const [name] of this.openSprinkles) {
      const sprinkle = this.availableSprinkles.get(name);
      if (sprinkle && sprinkle.path === path) return name;
    }
    return null;
  }

  dispose(): void {
    this.watcherUnsub?.();
  }

  sendToSprinkle(name: string, data: unknown, target?: SprinkleSendTarget): SprinkleSendReport {
    const wantsLeader = !target?.runtime || target.runtime === LEADER_RUNTIME_ID;
    const wantsFollowers = !target?.runtime || target.runtime !== LEADER_RUNTIME_ID;
    const report: SprinkleSendReport = { leader: false, followers: [] };

    if (wantsLeader) {
      const entry = this.openSprinkles.get(name);
      if (entry) {
        this.bridge.pushUpdate(name, data);

        entry.renderer.pushUpdate(data);
        report.leader = true;
      } else {
        log.warn('Cannot send to closed sprinkle', { name });
      }
    }

    if (wantsFollowers && this.onSendToSprinkle) {
      try {
        const result = this.onSendToSprinkle(name, data, target);
        if (result) {
          report.followers = result.followers;
          if (result.unknownRuntime) report.unknownRuntime = result.unknownRuntime;
        }
      } catch (err) {
        log.error('onSendToSprinkle hook threw', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return report;
  }
}
