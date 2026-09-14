import { createLogger } from '../base/logger.js';
import type { SprinkleSummary } from '../scoops/tray-sync-protocol.js';
import { toPreviewUrl } from '../shell/supplemental-commands/shared.js';
import type { SprinkleBridgeAPI, SprinkleUsbApi } from './sprinkle-bridge.js';
import type { SprinkleAddOptions } from './sprinkle-manager.js';
import { SprinkleRenderer } from './sprinkle-renderer.js';

const log = createLogger('sprinkle-follower');

export interface SprinkleFollowerSync {
  fetchSprinkleContent(sprinkleName: string): Promise<string>;
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void;
  cancelSprinkleFetch(sprinkleName: string, reason?: string): void;

  reportSprinkleInstances(sprinkleNames: string[]): void;
}

export interface SprinkleFollowerControllerOptions {
  sync: SprinkleFollowerSync;

  addSprinkle: (
    name: string,
    title: string,
    element: HTMLElement,
    zone?: string,
    options?: SprinkleAddOptions
  ) => void;

  removeSprinkle: (name: string) => void;

  zone?: string;

  open?: (path: string) => void;
}

interface OpenEntry {
  renderer: SprinkleRenderer;
  container: HTMLElement;
}

type UpdateCallback = (data: unknown) => void;

function followerUsbApi(): SprinkleUsbApi {
  const unsupported = () =>
    Promise.reject(new Error('usb not supported in follower-rendered sprinkle'));
  return {
    list: unsupported,
    request: unsupported,
    open: unsupported,
    close: unsupported,
    reset: unsupported,
    selectConfiguration: unsupported,
    claimInterface: unsupported,
    releaseInterface: unsupported,
    clearHalt: unsupported,
    controlTransferIn: unsupported,
    controlTransferOut: unsupported,
    transferIn: unsupported,
    transferOut: unsupported,
  } as SprinkleUsbApi;
}

export class SprinkleFollowerController {
  private readonly sync: SprinkleFollowerSync;
  private readonly addSprinkle: SprinkleFollowerControllerOptions['addSprinkle'];
  private readonly removeSprinkle: SprinkleFollowerControllerOptions['removeSprinkle'];
  private readonly zone?: string;
  private readonly openPath?: SprinkleFollowerControllerOptions['open'];

  private readonly open = new Map<string, OpenEntry>();

  private readonly opening = new Set<string>();

  private latestDesiredOpen = new Set<string>();

  private readonly pendingUpdates = new Map<string, unknown>();

  private readonly updateListeners = new Map<string, Set<UpdateCallback>>();
  private disposed = false;

  constructor(options: SprinkleFollowerControllerOptions) {
    this.sync = options.sync;
    this.addSprinkle = options.addSprinkle;
    this.removeSprinkle = options.removeSprinkle;
    this.zone = options.zone;
    this.openPath = options.open;
  }

  async updateAvailable(sprinkles: SprinkleSummary[]): Promise<void> {
    if (this.disposed) return;

    const desiredOpen = new Map<string, SprinkleSummary>();
    for (const s of sprinkles) {
      if (s.open) desiredOpen.set(s.name, s);
    }

    this.latestDesiredOpen = new Set(desiredOpen.keys());

    for (const name of [...this.open.keys()]) {
      if (!desiredOpen.has(name)) this.closeLocally(name);
    }

    for (const name of [...this.pendingUpdates.keys()]) {
      if (!desiredOpen.has(name)) this.pendingUpdates.delete(name);
    }

    const opens: Promise<void>[] = [];
    for (const [name, summary] of desiredOpen) {
      if (this.open.has(name) || this.opening.has(name)) continue;
      opens.push(this.openLocally(name, summary));
    }
    await Promise.allSettled(opens);
    this.reportInstances();
  }

  handleSprinkleUpdate(sprinkleName: string, data: unknown): void {
    if (this.disposed) return;

    const entry = this.open.get(sprinkleName);
    if (entry) {
      entry.renderer.pushUpdate(data);
      this.fanOutToListeners(sprinkleName, data);
      return;
    }

    if (this.opening.has(sprinkleName)) {
      this.pendingUpdates.set(sprinkleName, data);
      return;
    }

    log.debug('Dropping sprinkle.update for unknown sprinkle', { sprinkleName });
  }

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
    renderer.activateBridgeLifecycle();
    if (!this.open.has(sprinkleName)) return;
    log.info('Sprinkle reloaded in place', { sprinkleName });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const name of [...this.open.keys()]) this.closeLocally(name);
    this.pendingUpdates.clear();
    this.latestDesiredOpen.clear();

    this.updateListeners.clear();

    this.reportInstances();
  }

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

    this.addSprinkle(name, summary.title, container, this.zone, { icon: summary.icon });
    try {
      await renderer.render(content, name);
    } catch (err) {
      log.warn('Sprinkle render failed', {
        sprinkleName: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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

    this.open.set(name, { renderer, container });
    this.opening.delete(name);
    renderer.activateBridgeLifecycle();

    this.reportInstances();
    if (!this.open.has(name)) return;
    const buffered = this.pendingUpdates.get(name);
    if (buffered !== undefined) {
      this.pendingUpdates.delete(name);
      renderer.pushUpdate(buffered);
      this.fanOutToListeners(name, buffered);
    }
  }

  private fanOutToListeners(sprinkleName: string, data: unknown): void {
    const listeners = this.updateListeners.get(sprinkleName);
    if (!listeners) return;

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

  private reportInstances(): void {
    try {
      this.sync.reportSprinkleInstances([...this.open.keys()]);
    } catch (err) {
      log.debug('Failed to report sprinkle instances', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private closeLocally(name: string): void {
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
    this.reportInstances();
  }

  private createBridge(sprinkleName: string): SprinkleBridgeAPI {
    const api: SprinkleBridgeAPI = {
      name: sprinkleName,
      lick: (event) => {
        const action = typeof event === 'string' ? event : event.action;
        const data = typeof event === 'string' ? undefined : event.data;

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
      minimize: () => {},
      stopCone: () => {
        this.sync.sendSprinkleLick(sprinkleName, { action: '__stopCone__' });
      },
      attachImage: () => {},
      captureScreen: () =>
        Promise.reject(new Error('captureScreen not supported in follower-rendered sprinkle')),

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

      hid: {
        list: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        request: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        open: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        close: () => Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        sendReport: () =>
          Promise.reject(new Error('hid not supported in follower-rendered sprinkle')),
        on: () => {},
        off: () => {},
      },
      serial: {
        list: () => Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
        request: () =>
          Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
        open: () => Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
        close: () =>
          Promise.reject(new Error('serial not supported in follower-rendered sprinkle')),
      },
      usb: followerUsbApi(),
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
