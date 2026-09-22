import { matchLickTargetAlias } from '../../base/lick-target-match.js';
import { isExtensionRealm } from '../../core/runtime-env.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import type {
  SprinkleOpenOptions,
  SprinkleSendTarget,
} from '../../shell/sprinkle-manager-handle.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleAddOptions, SprinkleManagerCallbacks } from '../sprinkle-manager.js';
import { requestPlacedSurfaceFullscreen } from './surface-fullscreen.js';
import type { WcShellRefs } from './wc-shell.js';
import {
  defaultRootOf,
  rootForSelection,
  selectedScoopTarget,
  selectScoopForContext,
} from './wc-unit-context.js';

const SPRINKLE_PREFIX = 'sprinkle:';

const SPRINKLE_ICON_LEDGER_KEY = 'slicc-sprinkle-icons';

export function readSprinkleIconLedger(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SPRINKLE_ICON_LEDGER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function pruneSprinkleIconLedger(valid: readonly string[]): void {
  try {
    const keep = new Set(valid);
    const pruned = Object.fromEntries(
      Object.entries(readSprinkleIconLedger()).filter(([name]) => keep.has(name))
    );
    localStorage.setItem(SPRINKLE_ICON_LEDGER_KEY, JSON.stringify(pruned));
  } catch {}
}

export function recordSprinkleIcon(name: string, icon: string): void {
  try {
    localStorage.setItem(
      SPRINKLE_ICON_LEDGER_KEY,
      JSON.stringify({ ...readSprinkleIconLedger(), [name]: icon })
    );
  } catch {}
}

export function isLucideIconSpec(spec: string | undefined | null): spec is string {
  return typeof spec === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec);
}

export function sprinkleSurfaceId(name: string): string {
  return `${SPRINKLE_PREFIX}${name}`;
}

export function sprinkleNameFromId(id: string | null | undefined): string | null {
  return id?.startsWith(SPRINKLE_PREFIX) ? id.slice(SPRINKLE_PREFIX.length) : null;
}

import type {
  DockTreeSpecLike,
  DockZoneName,
  SurfaceSizeSpecLike,
} from '../../base/dock-tree-spec.js';

export type { DockTreeSpecLike, DockZoneName, SurfaceSizeSpecLike };

interface DockTreeLike {
  setTree(spec: DockTreeSpecLike | null): void;
  getTree(): DockTreeSpecLike;
  getSurfaceIds(): string[];
  placeSurface(surfaceId: string, zone: DockZoneName): void;
  removeSurface(surfaceId: string): void;
  moveSurfaceToZone(surfaceId: string, zone: DockZoneName): void;
  setSurfaceSize(surfaceId: string, size: SurfaceSizeSpecLike): boolean;
  beginExternalDrag(surfaceId: string, pointerId?: number): void;
  setPinned(surfaceIds: string[]): void;
}

export const CHAT_SURFACE_ID = 'chat';

const TOOL_PANEL_IDS: ReadonlySet<string> = new Set(['files', 'term', 'memory', 'monitor']);

export const DEFAULT_TOOL_ZONE: DockZoneName = 'right';

const DEFAULT_TREE_ZONE: DockZoneName = DEFAULT_TOOL_ZONE;

export function isToolPanelId(id: string): boolean {
  return TOOL_PANEL_IDS.has(id);
}

type DockNodeLike =
  | { type: 'leaf'; surfaceId: string }
  | { type: 'split'; children: DockNodeLike[] };

function nodeHasSurface(node: unknown, surfaceId: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as DockNodeLike;
  if (n.type === 'leaf') return n.surfaceId === surfaceId;
  if (n.type === 'split') return n.children.some((c) => nodeHasSurface(c, surfaceId));
  return false;
}

export function zoneOfSurface(spec: DockTreeSpecLike, surfaceId: string): DockZoneName | null {
  for (const zone of Object.keys(spec.zones) as DockZoneName[]) {
    if (nodeHasSurface(spec.zones[zone], surfaceId)) return zone;
  }
  return null;
}

interface DockItemDescriptor {
  id: string;
  icon: string;
  label: string;
  kind: 'sprinkle';
  hue?: string;
}

export interface WcSprinkleZoneToolPanelHooks {
  onToolPanelActivate?: (id: string) => void;
  onToolPanelDeactivate?: (id: string) => void;

  hostSprinkleSurface?: (surfaceId: string, surface: HTMLElement) => void;

  removeSprinkleSurface?: (surfaceId: string) => void;
}

export class WcSprinkleZone {
  readonly #refs: WcShellRefs;
  readonly #dockItems = new Map<string, DockItemDescriptor>();
  readonly #surfaces = new Map<string, HTMLElement>();

  readonly #seeded = new Set<string>();

  readonly #openOrder: string[] = [];
  readonly #toolPanelHooks: WcSprinkleZoneToolPanelHooks;

  constructor(refs: WcShellRefs, toolPanelHooks: WcSprinkleZoneToolPanelHooks = {}) {
    this.#refs = refs;
    this.#toolPanelHooks = toolPanelHooks;
  }

  #dockTreeApi(): (DockTreeLike & HTMLElement) | undefined {
    return this.#refs.dockTree as unknown as (DockTreeLike & HTMLElement) | undefined;
  }

  applyLayout(tree: DockTreeSpecLike): void {
    const dockTree = this.#dockTreeApi();
    dockTree?.setTree(tree);

    for (const name of this.#openOrder) {
      dockTree?.placeSurface(sprinkleSurfaceId(name), DEFAULT_TREE_ZONE);
    }
  }

  placeSurface(zone: DockZoneName, surfaceId: string): void {
    const dockTree = this.#dockTreeApi();
    if (dockTree && !this.#toolPanelHooks.hostSprinkleSurface) {
      for (const other of dockTree.getSurfaceIds()) {
        if (other !== surfaceId && other !== CHAT_SURFACE_ID) this.removeSurface(other);
      }
    }
    dockTree?.placeSurface(surfaceId, zone);
    if (!this.#toolPanelHooks.hostSprinkleSurface) {
      const dock = this.#refs.dock as unknown as { active: string | null } | undefined;
      if (dock) dock.active = surfaceId;
    }
    if (isToolPanelId(surfaceId)) this.#toolPanelHooks.onToolPanelActivate?.(surfaceId);
  }

  moveSurfaceToZone(surfaceId: string, zone: DockZoneName): void {
    this.#dockTreeApi()?.moveSurfaceToZone(surfaceId, zone);
  }

  removeSurface(surfaceId: string): void {
    this.#dockTreeApi()?.removeSurface(surfaceId);
    if (isToolPanelId(surfaceId)) this.#toolPanelHooks.onToolPanelDeactivate?.(surfaceId);
  }

  setSurfaceSize(surfaceId: string, size: SurfaceSizeSpecLike): boolean {
    return this.#dockTreeApi()?.setSurfaceSize(surfaceId, size) ?? false;
  }

  seedDockItems(names: readonly string[]): void {
    const pickedIcons = readSprinkleIconLedger();
    let changed = false;
    for (const name of names) {
      if (this.#dockItems.has(name)) continue;
      this.#seeded.add(name);
      this.#dockItems.set(name, {
        id: sprinkleSurfaceId(name),
        icon: pickedIcons[name] ?? 'sparkles',
        label: name,
        kind: 'sprinkle',
      });
      changed = true;
    }
    if (changed) this.#sync();
  }

  dropUnconfirmedSeeds(): void {
    let changed = false;
    for (const name of this.#seeded) {
      if (!this.#surfaces.has(name)) {
        this.#dockItems.delete(name);
        changed = true;
      }
    }
    this.#seeded.clear();
    if (changed) this.#sync();
  }

  callbacks(): SprinkleManagerCallbacks {
    return {
      addSprinkle: (name, title, element, _zone, options) =>
        this.#add(name, title, element, options),
      removeSprinkle: (name) => this.#remove(name, { keepDockItem: false }),
      minimizeSprinkle: (name) => this.#minimize(name),
      registerSprinkle: (name, title, options) => this.#ensureDockItem(name, title, options?.icon),
      unregisterSprinkle: (name) => this.#unregister(name),
      closeSprinkleContent: (name) => this.#remove(name, { keepDockItem: true }),
    };
  }

  updateDockIcon(name: string, icon: string): void {
    const item = this.#dockItems.get(name);
    if (!item || item.icon === icon) return;
    this.#dockItems.set(name, { ...item, icon });
    this.#sync();
  }

  defaultIconNames(): string[] {
    return [...this.#dockItems.entries()]
      .filter(([, item]) => item.icon === 'sparkles')
      .map(([name]) => name);
  }

  isOpen(name: string): boolean {
    return this.#surfaces.has(name);
  }

  #add(name: string, title: string, element: HTMLElement, options?: SprinkleAddOptions): void {
    const id = sprinkleSurfaceId(name);
    const host = this.#toolPanelHooks.hostSprinkleSurface;
    let surface = this.#surfaces.get(name);
    const isNew = !surface;
    if (!surface) {
      surface = document.createElement('slicc-surface');
      surface.setAttribute('surface-id', id);
      surface.setAttribute('layout', 'flex');

      if (!host) (this.#refs.dockTree as unknown as HTMLElement | undefined)?.append(surface);
      this.#surfaces.set(name, surface);
    }
    surface.replaceChildren(element);
    this.#ensureDockItem(name, title, options?.icon);

    if (!this.#openOrder.includes(name)) this.#openOrder.push(name);

    if (host) {
      if (isNew) host(id, surface);
      return;
    }

    if (options?.attention || options?.background) return;

    this.placeSurface(DEFAULT_TREE_ZONE, id);
  }

  #remove(name: string, opts: { keepDockItem: boolean }): void {
    const id = sprinkleSurfaceId(name);
    this.#surfaces.get(name)?.remove();
    this.#surfaces.delete(name);
    if (!opts.keepDockItem) this.#dockItems.delete(name);
    const oi = this.#openOrder.indexOf(name);
    if (oi >= 0) this.#openOrder.splice(oi, 1);
    this.#sync();
    if (this.#toolPanelHooks.removeSprinkleSurface) {
      this.#toolPanelHooks.removeSprinkleSurface(id);
      return;
    }
    (this.#refs.dockTree as unknown as DockTreeLike | undefined)?.removeSurface(id);
  }

  #minimize(name: string): void {
    this.#refs.dock.removeAttribute('active');
    if (this.#toolPanelHooks.hostSprinkleSurface) return;
    this.removeSurface(sprinkleSurfaceId(name));
  }

  #ensureDockItem(name: string, title: string, iconSpec?: string): void {
    this.#seeded.delete(name);
    const icon = this.#resolveIcon(name, iconSpec);
    this.#dockItems.set(name, {
      id: sprinkleSurfaceId(name),
      icon,
      label: title,
      kind: 'sprinkle',
    });
    this.#sync();
  }

  #resolveIcon(name: string, spec?: string): string {
    return isLucideIconSpec(spec) ? spec : (readSprinkleIconLedger()[name] ?? 'sparkles');
  }

  #unregister(name: string): void {
    if (!this.#surfaces.has(name)) {
      this.#dockItems.delete(name);
      this.#sync();
    }
  }

  #sync(): void {
    (this.#refs.dock as HTMLElement & { items?: unknown }).items = [...this.#dockItems.values()];
  }
}

export interface WireWcSprinklesDeps {
  refs: WcShellRefs;
  client: OffscreenClient;

  getUnits(): readonly WorkUnitSummary[];

  getSelected(): WorkUnitSummary | null;

  selectScoop?(unit: WorkUnitSummary): void;
  fs: import('../../fs/virtual-fs.js').VirtualFS;

  instanceId?: string;

  onAttachImage?: (base64: string, name?: string, mimeType?: string) => void;

  onToolPanelActivate?: (id: string) => void;

  onToolPanelDeactivate?: (id: string) => void;

  hostSprinkleSurface?: (surfaceId: string, surface: HTMLElement) => void;
  removeSprinkleSurface?: (surfaceId: string) => void;

  interceptWelcomeLick?: (event: LickEvent) => boolean;
  log: BootStageLogger;
}

export function makeSprinkleLickHandler(
  client: Pick<OffscreenClient, 'sendSprinkleLick'>,
  interceptWelcomeLick?: (event: LickEvent) => boolean
): (event: LickEvent, originUnitId?: string) => void {
  return (event, originUnitId) => {
    if (event.type !== 'sprinkle' || !event.sprinkleName) return;
    if (interceptWelcomeLick?.(event)) return;
    if (originUnitId) {
      client.sendSprinkleLick(event.sprinkleName, event.body, event.targetScoop, {
        unitJid: originUnitId,
      });
      return;
    }
    client.sendSprinkleLick(event.sprinkleName, event.body, event.targetScoop);
  };
}

export interface WcSprinklesHandle {
  manager: import('../sprinkle-manager.js').SprinkleManager;
  zone: WcSprinkleZone;

  resync(): Promise<void>;
}

const LONGPRESS_PLACEMENT_FRAMES = 180;

function wireRailLongPressFullscreen(refs: WcShellRefs): void {
  refs.dock.addEventListener('slicc-dock-longpress', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;

    if (sprinkleNameFromId(id) === null && !isToolPanelId(id)) return;
    const tryFullscreen = (framesLeft: number): void => {
      if (requestPlacedSurfaceFullscreen(refs.frame ?? refs.dockTree, id)) return;
      if (framesLeft <= 0) return;
      requestAnimationFrame(() => tryFullscreen(framesLeft - 1));
    };
    tryFullscreen(LONGPRESS_PLACEMENT_FRAMES);
  });
}

interface SprinkleManagerGlobal {
  __slicc_sprinkleManager?: import('../sprinkle-manager.js').SprinkleManager;
}

export async function wireWcSprinkles(deps: WireWcSprinklesDeps): Promise<WcSprinklesHandle> {
  const {
    refs,
    client,
    fs,
    instanceId,
    onAttachImage,
    onToolPanelActivate,
    onToolPanelDeactivate,
    hostSprinkleSurface,
    removeSprinkleSurface,
    log,
  } = deps;
  const zone = new WcSprinkleZone(refs, {
    onToolPanelActivate,
    onToolPanelDeactivate,
    hostSprinkleSurface,
    removeSprinkleSurface,
  });
  const { loadSprinkleStyles } = await import('../legacy-styles.js');
  await loadSprinkleStyles();

  const { SprinkleManager, readKnownSprinkleNames } = await import('../sprinkle-manager.js');

  zone.seedDockItems(readKnownSprinkleNames());
  const { installSprinkleManagerHandlerOverChannel } = await import(
    '../../scoops/sprinkle-bridge-channel.js'
  );
  const { createSprinkleExecHandler } = await import('../boot/setup-sprinkle-exec.js');
  const { setDipExecHandler } = await import('../dip.js');

  const isExtension = isExtensionRealm();
  const execHandler = createSprinkleExecHandler(client);
  const selectScoop = deps.selectScoop;
  const manager = new SprinkleManager(
    fs,
    makeSprinkleLickHandler(client, deps.interceptWelcomeLick),
    zone.callbacks(),
    () => {
      const cone = defaultRootOf(deps.getUnits());
      if (cone) client.stopScoop(cone.id);
    },
    {
      ...(isExtension ? { autoOpenBehavior: 'attention' as const } : {}),

      inlineSprinkles: new Set(['welcome']),
      execHandler,
      onAttachImage: onAttachImage ?? (() => {}),
      resolveLickOriginUnitId: (target) => matchLickTargetAlias(deps.getUnits(), target)?.id,
      selectedScoopHandler: () => selectedScoopTarget(deps.getUnits(), deps.getSelected()?.id),
      ...(selectScoop
        ? {
            selectScoopHandler: (target: string) =>
              selectScoopForContext(deps.getUnits(), target, deps.getSelected()?.id, selectScoop),
          }
        : {}),
    }
  );
  (window as unknown as SprinkleManagerGlobal).__slicc_sprinkleManager = manager;
  setDipExecHandler(execHandler);
  if (instanceId !== undefined) {
    const stop = installSprinkleManagerHandlerOverChannel(manager, { instanceId });
    window.addEventListener('beforeunload', () => stop(), { once: true });
  } else if (isExtension) {
    const { handleSprinkleOp } = await import('../sprinkle-op-handler.js');
    client.setSprinkleOpHandler((payload: unknown) => {
      const { id, op, name, data, target, openOptions } = payload as {
        id: unknown;
        op: string;
        name: string;
        data: unknown;
        target?: SprinkleSendTarget;
        openOptions?: SprinkleOpenOptions;
      };
      void handleSprinkleOp(manager, id, op, name, data, target, openOptions);
    });
  }

  refs.dock.addEventListener('slicc-dock-select', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    const name = sprinkleNameFromId(id);
    if (name) {
      const openingRoot = rootForSelection(deps.getUnits(), deps.getSelected());
      const activation = openingRoot
        ? manager.activate(name, undefined, { lickOriginTarget: openingRoot.folder })
        : manager.activate(name);
      activation.catch((err) => log.error('WC sprinkle activate failed', err));
      return;
    }
    if (id && isToolPanelId(id)) {
      zone.placeSurface(DEFAULT_TOOL_ZONE, id);
    }
  });

  refs.dock.addEventListener('slicc-dock-collapse', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;
    if (isToolPanelId(id)) {
      zone.removeSurface(id);
      return;
    }
    const name = sprinkleNameFromId(id);
    if (name) manager.minimize(name);
  });
  wireRailLongPressFullscreen(refs);

  let enriching = false;
  const resync = async (): Promise<void> => {
    await manager.refresh();

    if (manager.available().length > 0) {
      zone.dropUnconfirmedSeeds();
      const names = manager.available().map((s) => s.name);
      const { pruneKnownSprinkleNames } = await import('../sprinkle-manager.js');
      pruneKnownSprinkleNames(names);
      pruneSprinkleIconLedger(names);
    }
    await manager.restoreOpenSprinkles().catch((err) => {
      log.warn('WC shell: failed to restore open sprinkles', err);
    });

    if (!enriching) {
      enriching = true;
      void import('../../providers/quick-llm.js')
        .then(({ pickLucideIcon }) =>
          enrichSprinkleIcons(zone, manager.available(), (subject) => pickLucideIcon({ subject }))
        )
        .catch(() => undefined)
        .finally(() => {
          enriching = false;
        });
    }
  };

  void resync().catch((err) => log.warn('WC shell: initial sprinkle resync failed', err));
  return { manager, zone, resync };
}

export async function enrichSprinkleIcons(
  zone: WcSprinkleZone,
  sprinkles: ReadonlyArray<{ name: string; title: string; icon?: string }>,
  pickIcon: (subject: string) => Promise<string | null>
): Promise<void> {
  const needy = new Set(zone.defaultIconNames());
  const ledger = readSprinkleIconLedger();
  for (const sprinkle of sprinkles) {
    if (!needy.has(sprinkle.name)) continue;
    if (isLucideIconSpec(sprinkle.icon)) continue;
    const remembered = ledger[sprinkle.name];
    if (remembered) {
      zone.updateDockIcon(sprinkle.name, remembered);
      continue;
    }
    const icon = await pickIcon(`"${sprinkle.title}" — a SLICC sprinkle panel (${sprinkle.name})`);
    if (!icon) continue;
    recordSprinkleIcon(sprinkle.name, icon);
    zone.updateDockIcon(sprinkle.name, icon);
  }
}
