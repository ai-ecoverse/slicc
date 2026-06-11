/**
 * Sprinkle surface for the WC shell. `WcSprinkleZone` implements the
 * `SprinkleManagerCallbacks` contract over the workbench chrome: each open
 * sprinkle gets a closable tab, a `<slicc-surface>` hosting the rendered
 * element, and a dock item; registered-but-closed sprinkles keep a dock
 * launcher. `wireWcSprinkles` constructs the real `SprinkleManager` (the
 * legacy renderer/bridge stack, reused verbatim) against the zone.
 */

import type { LickEvent } from '../../scoops/lick-manager.js';
import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleAddOptions, SprinkleManagerCallbacks } from '../sprinkle-manager.js';
import type { WcShellRefs } from './wc-shell.js';

const SPRINKLE_PREFIX = 'sprinkle:';

/** Workbench surface / tab / dock id for a sprinkle name. */
export function sprinkleSurfaceId(name: string): string {
  return `${SPRINKLE_PREFIX}${name}`;
}

/** Inverse of {@link sprinkleSurfaceId}; `null` for non-sprinkle ids. */
export function sprinkleNameFromId(id: string | null | undefined): string | null {
  return id?.startsWith(SPRINKLE_PREFIX) ? id.slice(SPRINKLE_PREFIX.length) : null;
}

interface TabDescriptor {
  id: string;
  label: string;
  kind: 'tool' | 'sprinkle';
  closable?: boolean;
}

interface DockItemDescriptor {
  id: string;
  icon: string;
  label: string;
  kind: 'sprinkle';
  hue?: string;
}

const BASE_TABS: readonly TabDescriptor[] = [
  { id: 'files', label: 'files', kind: 'tool' },
  { id: 'term', label: 'terminal', kind: 'tool' },
  { id: 'memory', label: 'memory', kind: 'tool' },
];

/** Tab/surface/dock bookkeeping behind `SprinkleManagerCallbacks`. */
export class WcSprinkleZone {
  readonly #refs: WcShellRefs;
  readonly #tabs = new Map<string, TabDescriptor>();
  readonly #dockItems = new Map<string, DockItemDescriptor>();
  readonly #surfaces = new Map<string, HTMLElement>();

  constructor(refs: WcShellRefs) {
    this.#refs = refs;
  }

  callbacks(): SprinkleManagerCallbacks {
    return {
      addSprinkle: (name, title, element, _zone, options) =>
        this.#add(name, title, element, options),
      removeSprinkle: (name) => this.#remove(name, { keepDockItem: false }),
      minimizeSprinkle: (name) => this.#minimize(name),
      registerSprinkle: (name, title) => this.#ensureDockItem(name, title),
      unregisterSprinkle: (name) => this.#unregister(name),
      closeSprinkleContent: (name) => this.#remove(name, { keepDockItem: true }),
    };
  }

  /** Whether the sprinkle currently has an open surface. */
  isOpen(name: string): boolean {
    return this.#surfaces.has(name);
  }

  #add(name: string, title: string, element: HTMLElement, options?: SprinkleAddOptions): void {
    const id = sprinkleSurfaceId(name);
    let surface = this.#surfaces.get(name);
    if (!surface) {
      surface = document.createElement('slicc-surface');
      surface.setAttribute('surface-id', id);
      surface.setAttribute('layout', 'flex');
      this.#refs.workbenchBody.append(surface);
      this.#surfaces.set(name, surface);
    }
    surface.replaceChildren(element);
    this.#tabs.set(name, { id, label: title, kind: 'sprinkle', closable: true });
    this.#ensureDockItem(name, title);
    this.#sync();
    if (!options?.attention) this.#activate(id);
  }

  #remove(name: string, opts: { keepDockItem: boolean }): void {
    const id = sprinkleSurfaceId(name);
    this.#surfaces.get(name)?.remove();
    this.#surfaces.delete(name);
    this.#tabs.delete(name);
    if (!opts.keepDockItem) this.#dockItems.delete(name);
    this.#sync();
    if (this.#refs.workbenchBody.getAttribute('active') === id) this.#activate('files');
  }

  #minimize(name: string): void {
    if (this.#refs.workbenchBody.getAttribute('active') === sprinkleSurfaceId(name)) {
      this.#refs.shell.removeAttribute('open');
      this.#refs.dock.removeAttribute('active');
    }
  }

  #ensureDockItem(name: string, title: string): void {
    this.#dockItems.set(name, {
      id: sprinkleSurfaceId(name),
      icon: 'sparkles',
      label: title,
      kind: 'sprinkle',
    });
    this.#sync();
  }

  #unregister(name: string): void {
    if (!this.#surfaces.has(name)) {
      this.#dockItems.delete(name);
      this.#sync();
    }
  }

  #sync(): void {
    this.#refs.tabBar.tabs = [...BASE_TABS, ...this.#tabs.values()];
    (this.#refs.dock as HTMLElement & { items?: unknown }).items = [...this.#dockItems.values()];
  }

  #activate(id: string): void {
    this.#refs.shell.setAttribute('open', '');
    this.#refs.workbenchBody.setAttribute('active', id);
    this.#refs.dock.setAttribute('active', id);
    this.#refs.tabBar.setAttribute('active', id);
  }
}

export interface WireWcSprinklesDeps {
  refs: WcShellRefs;
  client: OffscreenClient;
  fs: import('../../fs/virtual-fs.js').VirtualFS;
  instanceId: string;
  log: BootStageLogger;
}

/**
 * Construct the real `SprinkleManager` over the WC zone: VFS discovery, the
 * iframe renderer + bridge, exec via a worker terminal session, and licks
 * dispatched to the cone. The welcome-flow interceptor and tray follower
 * forwarding are not wired in WC mode yet.
 */
export async function wireWcSprinkles(deps: WireWcSprinklesDeps): Promise<void> {
  const { refs, client, fs, instanceId, log } = deps;
  const zone = new WcSprinkleZone(refs);

  const { SprinkleManager } = await import('../sprinkle-manager.js');
  const { installSprinkleManagerHandlerOverChannel } = await import(
    '../../scoops/sprinkle-bridge-channel.js'
  );
  const { createSprinkleExecHandler } = await import('../boot/setup-sprinkle-exec.js');
  const { setDipExecHandler } = await import('../dip.js');

  const execHandler = createSprinkleExecHandler(client);
  const manager = new SprinkleManager(
    fs,
    (event: LickEvent) => {
      if (event.type === 'sprinkle' && event.sprinkleName) {
        client.sendSprinkleLick(event.sprinkleName, event.body, event.targetScoop);
      }
    },
    zone.callbacks(),
    () => {
      const cone = client.getScoops().find((s) => s.isCone);
      if (cone) client.stopScoop(cone.jid);
    },
    {
      // `welcome` backs the inline onboarding dip; it must never appear as a
      // panel sprinkle (mirrors INLINE_DIP_SPRINKLES in main.ts).
      inlineSprinkles: new Set(['welcome']),
      execHandler,
      onAttachImage: () => {
        log.warn('WC shell: image attachments from sprinkles are not wired yet');
      },
    }
  );
  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = manager;
  setDipExecHandler(execHandler);
  const stop = installSprinkleManagerHandlerOverChannel(manager, { instanceId });
  window.addEventListener('beforeunload', () => stop(), { once: true });

  // Closing a sprinkle tab closes the sprinkle; clicking a dock launcher for
  // a registered-but-closed sprinkle opens it.
  refs.tabBar.addEventListener('tab-close', (event) => {
    const name = sprinkleNameFromId((event as CustomEvent<{ tabId?: string }>).detail?.tabId);
    if (name) manager.close(name);
  });
  refs.dock.addEventListener('slicc-dock-select', (event) => {
    const name = sprinkleNameFromId((event as CustomEvent<{ id?: string }>).detail?.id);
    if (name && !zone.isOpen(name)) {
      manager.open(name).catch((err) => log.error('WC sprinkle open failed', err));
    }
  });

  await manager.refresh();
  await manager.restoreOpenSprinkles().catch((err) => {
    log.warn('WC shell: failed to restore open sprinkles', err);
  });
}
