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

const OPEN_SPRINKLES_KEY = 'slicc-open-sprinkles';
const PLAYGROUND_STATE_PREFIX = 'slicc-playground-state:';
const PLAYGROUND_CHANNEL = 'slicc-playground';

export class SprinkleManager {
  private fs: VirtualFS;
  private bridge: SprinkleBridge;
  private lickHandler: (event: LickEvent) => void;
  private callbacks: SprinkleManagerCallbacks;
  private availableSprinkles = new Map<string, Sprinkle>();
  private openSprinkles = new Map<string, {
    renderer: SprinkleRenderer;
    container: HTMLElement;
  }>();
  /** Registered playground tabs: id → path */
  private playgrounds = new Map<string, string>();
  private playgroundChannel: BroadcastChannel | null = null;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    callbacks: SprinkleManagerCallbacks,
  ) {
    this.fs = fs;
    this.lickHandler = lickHandler;
    this.bridge = new SprinkleBridge(fs, lickHandler, (name) => this.close(name));
    this.callbacks = callbacks;
  }

  /** Restore sprinkles that were open in the previous session. */
  async restoreOpenSprinkles(): Promise<void> {
    try {
      const raw = localStorage.getItem(OPEN_SPRINKLES_KEY);
      if (!raw) return;
      const names: string[] = JSON.parse(raw);
      for (const name of names) {
        try {
          await this.open(name);
        } catch {
          log.warn('Failed to restore sprinkle', { name });
        }
      }
    } catch { /* corrupt localStorage, ignore */ }
  }

  private persistOpenSprinkles(): void {
    try {
      localStorage.setItem(OPEN_SPRINKLES_KEY, JSON.stringify([...this.openSprinkles.keys()]));
    } catch { /* localStorage full, ignore */ }
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
    container.style.cssText = 'width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;';
    container.dataset.sprinkle = name;

    // Expand/collapse button
    const expandBar = document.createElement('div');
    expandBar.className = 'sprinkle-panel__expand-bar';
    const expandBtn = document.createElement('button');
    expandBtn.className = 'sprinkle-panel__expand-btn';
    expandBtn.title = 'Expand to full page';
    expandBtn.setAttribute('aria-label', 'Expand to full page');
    expandBtn.setAttribute('data-tooltip', 'Expand to full page');
    expandBtn.textContent = '\u26F6'; // ⛶ square with corners
    expandBtn.addEventListener('click', () => {
      const expanded = container.classList.toggle('sprinkle-panel--expanded');
      expandBtn.textContent = expanded ? '\u2716' : '\u26F6'; // ✖ or ⛶
      expandBtn.title = expanded ? 'Collapse' : 'Expand to full page';
      expandBtn.setAttribute('aria-label', expandBtn.title);
      expandBtn.setAttribute('data-tooltip', expandBtn.title);
    });
    expandBar.appendChild(expandBtn);
    container.appendChild(expandBar);

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

  /** Push data to an open sprinkle or playground (agent → sprinkle/playground). */
  sendToSprinkle(name: string, data: unknown): void {
    // Check for playground: prefix → delegate to playground channel
    if (name.startsWith('playground:')) {
      const pgId = name.slice('playground:'.length);
      this.sendToPlayground(pgId, data);
      return;
    }

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

  /** Send data to a playground tab via BroadcastChannel. */
  sendToPlayground(id: string, data: unknown): void {
    if (!this.playgroundChannel) {
      log.warn('Playground discovery not started, cannot send', { id });
      return;
    }
    // Find the playground by id or by path match
    const targetId = this.resolvePlaygroundId(id);
    if (!targetId) {
      log.warn('Playground not found', { id });
      return;
    }
    this.playgroundChannel.postMessage({
      type: 'playground-update',
      targetId,
      data,
    });
  }

  /** Resolve a playground reference to its registered ID.
   *  Accepts a full ID or a path prefix (e.g. /shared/app.html). */
  private resolvePlaygroundId(ref: string): string | null {
    // Direct ID match
    if (this.playgrounds.has(ref)) return ref;
    // Try matching by path prefix (ref is a VFS path like /shared/app.html)
    for (const [pgId, pgPath] of this.playgrounds) {
      if (pgId.startsWith(ref + ':') || pgPath === ref) return pgId;
    }
    return null;
  }

  /**
   * Start listening for playground tab registrations via BroadcastChannel.
   * Playgrounds are preview-tab HTML pages that get `window.slicc` injected
   * automatically by the preview service worker.
   */
  startPlaygroundDiscovery(): void {
    if (this.playgroundChannel) return;

    this.playgroundChannel = new BroadcastChannel(PLAYGROUND_CHANNEL);
    this.playgroundChannel.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'playground-ready':
          this.playgrounds.set(msg.id, msg.path);
          log.info('Playground registered', { id: msg.id, path: msg.path });
          break;

        case 'playground-lick': {
          const lickEvent: LickEvent = {
            type: 'sprinkle',
            sprinkleName: `playground:${msg.id}`,
            targetScoop: undefined,
            timestamp: new Date().toISOString(),
            body: { action: msg.action, data: msg.data },
          };
          this.lickHandler(lickEvent);
          break;
        }

        case 'playground-set-state':
          try {
            localStorage.setItem(PLAYGROUND_STATE_PREFIX + msg.id, JSON.stringify(msg.data));
          } catch { /* localStorage full */ }
          break;

        case 'playground-get-state': {
          let data: unknown = null;
          try {
            const raw = localStorage.getItem(PLAYGROUND_STATE_PREFIX + msg.id);
            data = raw ? JSON.parse(raw) : null;
          } catch { /* corrupt */ }
          this.playgroundChannel!.postMessage({
            type: 'playground-state-response',
            targetId: msg.id,
            data,
          });
          break;
        }

        case 'playground-readfile':
          (async () => {
            try {
              const content = await this.fs.readFile(msg.path, { encoding: 'utf-8' }) as string;
              this.playgroundChannel!.postMessage({
                type: 'playground-readfile-response',
                targetId: msg.id,
                requestId: msg.requestId,
                content,
              });
            } catch (err) {
              this.playgroundChannel!.postMessage({
                type: 'playground-readfile-response',
                targetId: msg.id,
                requestId: msg.requestId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
          break;

        case 'playground-close':
          this.playgrounds.delete(msg.id);
          log.info('Playground unregistered', { id: msg.id });
          break;
      }
    };

    log.info('Playground discovery started');
  }
}
