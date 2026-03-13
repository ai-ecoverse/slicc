/**
 * Panel Manager — registry of available and open `.shtml` panels,
 * and their placement in the layout.
 */

import type { VirtualFS } from '../fs/index.js';
import { discoverShtmlPanels, type ShtmlPanel } from './shtml-discovery.js';
import { ShtmlBridge } from './shtml-bridge.js';
import { ShtmlPanelRenderer } from './shtml-panel.js';
import type { LickEvent } from '../scoops/lick-manager.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('panel-manager');

export interface PanelManagerCallbacks {
  /** Called to add a panel to the layout (standalone: right column, extension: tab). */
  addPanel(name: string, title: string, element: HTMLElement, zone?: string): void;
  /** Called to remove a panel from the layout. */
  removePanel(name: string): void;
}

export class PanelManager {
  private fs: VirtualFS;
  private bridge: ShtmlBridge;
  private callbacks: PanelManagerCallbacks;
  private availablePanels = new Map<string, ShtmlPanel>();
  private openPanels = new Map<string, {
    renderer: ShtmlPanelRenderer;
    container: HTMLElement;
  }>();

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    callbacks: PanelManagerCallbacks,
  ) {
    this.fs = fs;
    this.bridge = new ShtmlBridge(fs, lickHandler, (name) => this.close(name));
    this.callbacks = callbacks;
  }

  /** Scan VFS and update available panels. */
  async refresh(): Promise<void> {
    this.availablePanels = await discoverShtmlPanels(this.fs);
    log.info('Discovered SHTML panels', { count: this.availablePanels.size });
  }

  /** Open a panel by name, optionally in a specific zone. */
  async open(name: string, zone?: string): Promise<void> {
    if (this.openPanels.has(name)) {
      log.info('Panel already open', { name });
      return;
    }

    let panel = this.availablePanels.get(name);
    if (!panel) {
      // Try refreshing first
      await this.refresh();
      panel = this.availablePanels.get(name);
    }
    if (!panel) {
      throw new Error(`Panel not found: ${name}`);
    }

    const content = await this.fs.readFile(panel.path, { encoding: 'utf-8' }) as string;
    const container = document.createElement('div');
    container.className = 'shtml-panel';
    container.dataset.panel = name;

    const api = this.bridge.createAPI(name);
    const renderer = new ShtmlPanelRenderer(container, api);
    await renderer.render(content, name);

    this.openPanels.set(name, { renderer, container });
    this.callbacks.addPanel(name, panel.title, container, zone);
    log.info('Panel opened', { name, title: panel.title });
  }

  /** Close a panel by name. */
  close(name: string): void {
    const entry = this.openPanels.get(name);
    if (!entry) return;

    entry.renderer.dispose();
    entry.container.remove();
    this.bridge.removePanel(name);
    this.openPanels.delete(name);
    this.callbacks.removePanel(name);
    log.info('Panel closed', { name });
  }

  /** List available panels. */
  available(): ShtmlPanel[] {
    return Array.from(this.availablePanels.values());
  }

  /** List open panel names. */
  opened(): string[] {
    return Array.from(this.openPanels.keys());
  }

  /** Push data to an open panel (agent → panel). */
  sendToPanel(name: string, data: unknown): void {
    if (!this.openPanels.has(name)) {
      log.warn('Cannot send to closed panel', { name });
      return;
    }
    this.bridge.pushUpdate(name, data);
  }
}
