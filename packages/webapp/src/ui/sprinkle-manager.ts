/**
 * Sprinkle Manager — registry of available and open `.shtml` sprinkles,
 * and their placement in the layout.
 */

import type { VirtualFS } from '../fs/index.js';
import { discoverSprinkles, type Sprinkle } from './sprinkle-discovery.js';
import { SprinkleBridge } from './sprinkle-bridge.js';
import { SprinkleRenderer } from './sprinkle-renderer.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { createLogger } from '../core/logger.js';
import { trackSprinkleView } from './telemetry.js';

const log = createLogger('sprinkle-manager');

export interface SprinkleManagerCallbacks {
  /** Called to add a sprinkle to the layout (standalone: right column, extension: tab). */
  addSprinkle(name: string, title: string, element: HTMLElement, zone?: string): void;
  /** Called to remove a sprinkle from the layout. */
  removeSprinkle(name: string): void;
}

const OPEN_SPRINKLES_KEY = 'slicc-open-sprinkles';

export class SprinkleManager {
  private fs: VirtualFS;
  private bridge: SprinkleBridge;
  private callbacks: SprinkleManagerCallbacks;
  private availableSprinkles = new Map<string, Sprinkle>();
  private openSprinkles = new Map<
    string,
    {
      renderer: SprinkleRenderer;
      container: HTMLElement;
    }
  >();

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    callbacks: SprinkleManagerCallbacks
  ) {
    this.fs = fs;
    this.bridge = new SprinkleBridge(fs, lickHandler, (name) => this.close(name));
    this.callbacks = callbacks;
  }

  /** Restore sprinkles that were open in the previous session.
   *  On first run (no localStorage entry), auto-open sprinkles marked with data-sprinkle-autoopen. */
  async restoreOpenSprinkles(): Promise<void> {
    try {
      const raw = localStorage.getItem(OPEN_SPRINKLES_KEY);
      if (!raw) {
        // First run — open sprinkles with autoOpen flag
        for (const sprinkle of this.availableSprinkles.values()) {
          if (sprinkle.autoOpen) {
            try {
              await this.open(sprinkle.name);
            } catch {
              log.warn('Failed to auto-open sprinkle', { name: sprinkle.name });
            }
          }
        }
        return;
      }
      const names: string[] = JSON.parse(raw);
      for (const name of names) {
        try {
          await this.open(name);
        } catch {
          log.warn('Failed to restore sprinkle', { name });
        }
      }
    } catch {
      /* corrupt localStorage, ignore */
    }
  }

  private persistOpenSprinkles(): void {
    try {
      localStorage.setItem(OPEN_SPRINKLES_KEY, JSON.stringify([...this.openSprinkles.keys()]));
    } catch {
      /* localStorage full, ignore */
    }
  }

  /** Refresh and auto-open any new sprinkles with autoOpen that aren't already open. */
  async openNewAutoOpenSprinkles(): Promise<void> {
    await this.refresh();
    for (const sprinkle of this.availableSprinkles.values()) {
      if (sprinkle.autoOpen && !this.openSprinkles.has(sprinkle.name)) {
        try {
          await this.open(sprinkle.name);
          log.info('Auto-opened new sprinkle after install', { name: sprinkle.name });
        } catch {
          log.warn('Failed to auto-open new sprinkle', { name: sprinkle.name });
        }
      }
    }
  }

  /** Scan VFS and update available sprinkles. */
  async refresh(): Promise<void> {
    this.availableSprinkles = await discoverSprinkles(this.fs);
    log.info('Discovered sprinkles', { count: this.availableSprinkles.size });
  }

  /** Open a sprinkle by name, optionally in a specific zone. */
  async open(name: string, zone?: string): Promise<void> {
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

    const content = (await this.fs.readFile(sprinkle.path, { encoding: 'utf-8' })) as string;
    const container = document.createElement('div');
    container.className = 'sprinkle-panel';
    container.style.cssText =
      'width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;';
    container.dataset.sprinkle = name;

    // Attach container to the layout BEFORE rendering so the sandbox iframe
    // (extension mode) gets added to a live DOM subtree. Iframes in detached
    // subtrees won't fire their load event.
    this.openSprinkles.set(name, { renderer: null!, container });
    this.callbacks.addSprinkle(name, sprinkle.title, container, zone);

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

  /** Set the shell exec handler for sprinkle bridge. */
  setExecHandler(
    handler: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  ): void {
    this.bridge.setExecHandler(handler);
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
