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

const log = createLogger('sprinkle-manager');

export interface SprinkleManagerCallbacks {
  /** Called to add a sprinkle to the layout (standalone: right column, extension: tab). */
  addSprinkle(name: string, title: string, element: HTMLElement, zone?: string): void;
  /** Called to remove a sprinkle from the layout. */
  removeSprinkle(name: string): void;
}

export class SprinkleManager {
  private fs: VirtualFS;
  private bridge: SprinkleBridge;
  private callbacks: SprinkleManagerCallbacks;
  private availableSprinkles = new Map<string, Sprinkle>();
  private openSprinkles = new Map<string, {
    renderer: SprinkleRenderer;
    container: HTMLElement;
  }>();

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    callbacks: SprinkleManagerCallbacks,
  ) {
    this.fs = fs;
    this.bridge = new SprinkleBridge(fs, lickHandler, (name) => this.close(name));
    this.callbacks = callbacks;
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

    const content = await this.fs.readFile(sprinkle.path, { encoding: 'utf-8' }) as string;
    const container = document.createElement('div');
    container.className = 'sprinkle-panel';
    container.dataset.sprinkle = name;

    const api = this.bridge.createAPI(name);
    const renderer = new SprinkleRenderer(container, api);
    await renderer.render(content, name);

    this.openSprinkles.set(name, { renderer, container });
    this.callbacks.addSprinkle(name, sprinkle.title, container, zone);
    log.info('Sprinkle opened', { name, title: sprinkle.title });
  }

  /** Close a sprinkle by name. */
  close(name: string): void {
    const entry = this.openSprinkles.get(name);
    if (!entry) return;

    entry.renderer.dispose();
    entry.container.remove();
    this.bridge.removeSprinkle(name);
    this.openSprinkles.delete(name);
    this.callbacks.removeSprinkle(name);
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

  /** Push data to an open sprinkle (agent → sprinkle). */
  sendToSprinkle(name: string, data: unknown): void {
    if (!this.openSprinkles.has(name)) {
      log.warn('Cannot send to closed sprinkle', { name });
      return;
    }
    this.bridge.pushUpdate(name, data);
  }
}
