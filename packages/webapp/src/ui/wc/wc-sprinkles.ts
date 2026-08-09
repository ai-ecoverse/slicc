/**
 * Sprinkle surface for the WC shell. `WcSprinkleZone` implements the
 * `SprinkleManagerCallbacks` contract over the workbench chrome: each open
 * sprinkle gets a closable tab, a `<slicc-surface>` hosting the rendered
 * element, and a dock item; registered-but-closed sprinkles keep a dock
 * launcher. `wireWcSprinkles` constructs the real `SprinkleManager` (the
 * legacy renderer/bridge stack, reused verbatim) against the zone.
 */

import { isExtensionRealm } from '../../core/runtime-env.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleAddOptions, SprinkleManagerCallbacks } from '../sprinkle-manager.js';
import type { WcShellRefs } from './wc-shell.js';

const SPRINKLE_PREFIX = 'sprinkle:';

/**
 * Persistent ledger of LLM-picked rail icons, keyed by sprinkle name. A
 * sprinkle that declares its own icon (`data-sprinkle-icon`) never lands
 * here; the ledger only backfills the ones that would otherwise show the
 * generic sparkles glyph, so each sprinkle is labeled at most once.
 */
const SPRINKLE_ICON_LEDGER_KEY = 'slicc-sprinkle-icons';

/** Read the picked-icon ledger (name → lucide kebab name). */
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

/** Drop icon-ledger entries for sprinkles a completed discovery didn't confirm. */
export function pruneSprinkleIconLedger(valid: readonly string[]): void {
  try {
    const keep = new Set(valid);
    const pruned = Object.fromEntries(
      Object.entries(readSprinkleIconLedger()).filter(([name]) => keep.has(name))
    );
    localStorage.setItem(SPRINKLE_ICON_LEDGER_KEY, JSON.stringify(pruned));
  } catch {
    /* localStorage unavailable — ledger stays as-is */
  }
}

/** Persist one picked icon into the ledger (merge, best-effort). */
export function recordSprinkleIcon(name: string, icon: string): void {
  try {
    localStorage.setItem(
      SPRINKLE_ICON_LEDGER_KEY,
      JSON.stringify({ ...readSprinkleIconLedger(), [name]: icon })
    );
  } catch {
    /* localStorage full/unavailable — the pick just isn't remembered */
  }
}

/**
 * Whether a declared icon spec is a lucide kebab name the dock-item can
 * render. Sprinkles may also declare VFS paths / inline SVG / data URLs —
 * those render in other surfaces but not in the rail, so they fall through
 * to the ledger / default.
 */
export function isLucideIconSpec(spec: string | undefined | null): spec is string {
  return typeof spec === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec);
}

/** Workbench surface / tab / dock id for a sprinkle name. */
export function sprinkleSurfaceId(name: string): string {
  return `${SPRINKLE_PREFIX}${name}`;
}

/** Inverse of {@link sprinkleSurfaceId}; `null` for non-sprinkle ids. */
export function sprinkleNameFromId(id: string | null | undefined): string | null {
  return id?.startsWith(SPRINKLE_PREFIX) ? id.slice(SPRINKLE_PREFIX.length) : null;
}

/**
 * The dock-tree spec types now live in `core/dock-tree-spec.ts` — the shell, scoops
 * and kernel layers need them and cannot import `ui/` (layer stack). Re-exported here
 * so this module's existing consumers keep their import path.
 */
import type {
  DockTreeSpecLike,
  DockZoneName,
  SurfaceSizeSpecLike,
} from '../../core/dock-tree-spec.js';

export type { DockTreeSpecLike, DockZoneName, SurfaceSizeSpecLike };

/** The subset of `<slicc-dock-tree>`'s public API the zone drives in tree-layout mode. */
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

/**
 * Reserved, non-closable dock-tree surface id for the live chat pane —
 * shared vocabulary across the "chat as a movable panel" feature (mirrors
 * `CHAT_SURFACE_ID` exported by `@slicc/webcomponents`' `slicc-dock-tree.ts`;
 * redeclared here, not imported, for the same no-runtime-dependency reason as
 * `DockZoneName`/`DockTreeSpecLike` above).
 */
export const CHAT_SURFACE_ID = 'chat';

/**
 * Dock-rail ids of the fixed tool panels — each an independent, permanently
 * mounted `<slicc-surface>` composed directly into the dock-tree (see
 * `wc-shell.ts`'s `mountWcShell`), opened/closed via `placeSurface`/
 * `removeSurface` exactly like a sprinkle.
 */
const TOOL_PANEL_IDS: ReadonlySet<string> = new Set(['files', 'term', 'memory', 'monitor']);

/** Zone a tool panel lands in the first time it's opened (each one independent — no shared leaf). */
export const DEFAULT_TOOL_ZONE: DockZoneName = 'right';

/** Zone a newly opened sprinkle (no drag gesture) lands in — same zone as the tool panels, so sprinkles tab alongside VFS/terminal instead of claiming their own column. */
const DEFAULT_TREE_ZONE: DockZoneName = DEFAULT_TOOL_ZONE;

/** Whether a dock-rail id is one of the fixed tool panels (not a sprinkle). */
export function isToolPanelId(id: string): boolean {
  return TOOL_PANEL_IDS.has(id);
}

/** A dock-tree node: a single-surface leaf, or a directional split of child nodes. */
type DockNodeLike =
  | { type: 'leaf'; surfaceId: string }
  | { type: 'split'; children: DockNodeLike[] };

/** Whether a `surfaceId` appears anywhere in a node (leaf or nested split). */
function nodeHasSurface(node: unknown, surfaceId: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as DockNodeLike;
  if (n.type === 'leaf') return n.surfaceId === surfaceId;
  if (n.type === 'split') return n.children.some((c) => nodeHasSurface(c, surfaceId));
  return false;
}

/** The zone a `surfaceId` currently lives in within a tree spec, or `null` if absent. */
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

/**
 * Tool-panel lifecycle hooks a `WcSprinkleZone` fires whenever `placeSurface`/
 * `removeSurface` places or removes a fixed tool-panel id (files/term/memory/
 * monitor — see `isToolPanelId`) — start/stop its poller or lazy-mount,
 * regardless of whether the placement came from a dock-rail click or an
 * agent-driven `layout open`/`layout close`. A no-op for sprinkle/chat ids.
 */
export interface WcSprinkleZoneToolPanelHooks {
  onToolPanelActivate?: (id: string) => void;
  onToolPanelDeactivate?: (id: string) => void;
  /**
   * Where a newly created sprinkle surface should be hosted, and how it gets
   * placed. Set by `panelizeShell`, which REMOVES the dock-tree this class
   * otherwise appends to — without this, every sprinkle surface was created into
   * a detached element and could never render (the reported "I can't see the
   * sprinkles"). Absent in the classic shell, which keeps the dock-tree path.
   */
  hostSprinkleSurface?: (surfaceId: string, surface: HTMLElement) => void;
  /** Remove a sprinkle's panel from the panelized layout. */
  removeSprinkleSurface?: (surfaceId: string) => void;
}

/** Tab/surface/dock bookkeeping behind `SprinkleManagerCallbacks`. The dock-tree is the only layout system — every panel (chat, tool panels, sprinkles) is a permanent, independent tree leaf. */
export class WcSprinkleZone {
  readonly #refs: WcShellRefs;
  readonly #dockItems = new Map<string, DockItemDescriptor>();
  readonly #surfaces = new Map<string, HTMLElement>();
  /** Names seeded from the known-sprinkles ledger, not yet confirmed by discovery. */
  readonly #seeded = new Set<string>();
  /** Open order (sprinkles only — tool panels are boot-composed, not tracked here). */
  readonly #openOrder: string[] = [];
  readonly #toolPanelHooks: WcSprinkleZoneToolPanelHooks;

  constructor(refs: WcShellRefs, toolPanelHooks: WcSprinkleZoneToolPanelHooks = {}) {
    this.#refs = refs;
    this.#toolPanelHooks = toolPanelHooks;
  }

  /**
   * The dock-tree ref, cast as possibly `undefined` (not the non-optional
   * `WcShellRefs` type) so a fixture that omits `dockTree` degrades to a
   * no-op instead of throwing.
   */
  #dockTreeApi(): (DockTreeLike & HTMLElement) | undefined {
    return this.#refs.dockTree as unknown as (DockTreeLike & HTMLElement) | undefined;
  }

  /** Apply a layout: load the tree, then re-place any already-open sprinkles that aren't in it yet. */
  applyLayout(tree: DockTreeSpecLike): void {
    const dockTree = this.#dockTreeApi();
    dockTree?.setTree(tree);
    // `placeSurface` no-ops when the surfaceId is already anywhere in the
    // tree, so this never displaces a drag-drop position the new tree itself
    // didn't specify (e.g. re-applying a preset while sprinkles are open).
    for (const name of this.#openOrder) {
      dockTree?.placeSurface(sprinkleSurfaceId(name), DEFAULT_TREE_ZONE);
    }
  }

  /**
   * Explicit placement (dock-rail click, `layout open`/agent-driven): place a
   * surface into a zone. In the classic (non-panelized) dock-tree, only one
   * non-chat surface is ever visible at a time — mirrors the pre-panels
   * "one panel open" model, where opening anything replaced whatever was
   * already showing. Panelized shells (a `hostSprinkleSurface` hook) run
   * their own model and skip the collapse. Fires `onToolPanelActivate` for a
   * fixed tool-panel id — its own lazy-mount/poller lifecycle, distinct from
   * the dock-tree placement itself — regardless of which caller placed it.
   */
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

  /** Move a surface already in the tree to a different zone (e.g. `layout chat`/`layout move <id> <zone>`). */
  moveSurfaceToZone(surfaceId: string, zone: DockZoneName): void {
    this.#dockTreeApi()?.moveSurfaceToZone(surfaceId, zone);
  }

  /**
   * Detach a surface from the tree wherever it sits (dock-rail collapse,
   * `layout close`/agent-driven). No-op if pinned/locked/absent. Fires
   * `onToolPanelDeactivate` for a fixed tool-panel id.
   */
  removeSurface(surfaceId: string): void {
    this.#dockTreeApi()?.removeSurface(surfaceId);
    if (isToolPanelId(surfaceId)) this.#toolPanelHooks.onToolPanelDeactivate?.(surfaceId);
  }

  /** Resize a placed surface's leaf (e.g. `layout size <id> ...`). Returns whether anything actually changed. */
  setSurfaceSize(surfaceId: string, size: SurfaceSizeSpecLike): boolean {
    return this.#dockTreeApi()?.setSurfaceSize(surfaceId, size) ?? false;
  }

  /**
   * Pre-populate rail launchers (label = name) from the known-sprinkles
   * ledger so the rail isn't empty while VFS discovery runs. Discovery
   * trues up titles via `registerSprinkle`; {@link dropUnconfirmedSeeds}
   * removes seeds discovery didn't confirm (uninstalled sprinkles).
   */
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

  /** Remove seeded launchers the completed discovery did not confirm. */
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

  /** Update a launcher's icon in place (LLM enrichment landing late). */
  updateDockIcon(name: string, icon: string): void {
    const item = this.#dockItems.get(name);
    if (!item || item.icon === icon) return;
    this.#dockItems.set(name, { ...item, icon });
    this.#sync();
  }

  /** Names that currently show the generic sparkles glyph (enrichment targets). */
  defaultIconNames(): string[] {
    return [...this.#dockItems.entries()]
      .filter(([, item]) => item.icon === 'sparkles')
      .map(([name]) => name);
  }

  /** Whether the sprinkle currently has an open surface. */
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
      // Panelized shells supply a host: the dock-tree this used to append to has
      // been removed, so appending there would leave the surface detached and
      // invisible forever.
      if (!host) (this.#refs.dockTree as unknown as HTMLElement | undefined)?.append(surface);
      this.#surfaces.set(name, surface);
    }
    surface.replaceChildren(element);
    this.#ensureDockItem(name, title, options?.icon);

    // Track open order (deterministic re-place on `applyLayout`).
    if (!this.#openOrder.includes(name)) this.#openOrder.push(name);

    if (host) {
      // The host owns both mounting and placement in the panel layout.
      if (isNew) host(id, surface);
      return;
    }
    // Passive attention-pulse or background session-restore adds must not
    // steal the one visible slot — mirrors the pre-panels `#activate` skip
    // for these two modes (see `AddSprinkleOptions`). The dock item above
    // still registers so the rail icon is clickable; a later user click
    // (`activate`) or `ws`-driven restore does the actual placement.
    if (options?.attention || options?.background) return;
    // A new leaf lands in the default zone unless a drag or a restored/
    // persisted tree already placed it (`placeSurface` no-ops on a
    // duplicate surfaceId).
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

  /**
   * Minimize (collapse) a sprinkle: detach its leaf from the dock-tree,
   * parking it offstage (state preserved, not destroyed — dock-tree parking
   * hides via `display:none` rather than unmounting) so the rail icon can
   * reopen it later. Mirrors the pre-panels behavior, where minimizing
   * closed the single shared "workbench body" pane. Panelized shells (a
   * `hostSprinkleSurface` hook) manage their own hide affordance and are
   * left untouched here.
   */
  #minimize(name: string): void {
    this.#refs.dock.removeAttribute('active');
    if (this.#toolPanelHooks.hostSprinkleSurface) return;
    this.removeSurface(sprinkleSurfaceId(name));
  }

  /**
   * Icon priority: a declared lucide spec (`data-sprinkle-icon`) wins, then a
   * previously LLM-picked ledger entry, then the generic sparkles glyph.
   * Non-lucide declared specs (VFS paths, inline SVG) can't render in the
   * rail's dock-item and fall through.
   */
  #ensureDockItem(name: string, title: string, iconSpec?: string): void {
    // Discovery (or an open) confirmed this name — it's no longer a seed.
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
  fs: import('../../fs/virtual-fs.js').VirtualFS;
  /**
   * Standalone kernel-worker id; enables the worker→panel sprinkle-ops
   * BroadcastChannel. Absent in the extension float, where those ops arrive
   * over the chrome.runtime relay instead (not wired in WC mode yet).
   */
  instanceId?: string;
  /** Stage an image attachment from a sprinkle into the chat input. */
  onAttachImage?: (base64: string, name?: string, mimeType?: string) => void;
  /** A fixed tool panel's leaf was placed into the tree (opened) — start its poller/lazy-mount. */
  onToolPanelActivate?: (id: string) => void;
  /** A fixed tool panel's leaf was removed from the tree (closed) — stop its poller. */
  onToolPanelDeactivate?: (id: string) => void;
  /** Panelized shells host sprinkle surfaces themselves — see the zone's hooks. */
  hostSprinkleSurface?: (surfaceId: string, surface: HTMLElement) => void;
  removeSprinkleSurface?: (surfaceId: string) => void;
  log: BootStageLogger;
}

export interface WcSprinklesHandle {
  manager: import('../sprinkle-manager.js').SprinkleManager;
  zone: WcSprinkleZone;
  /**
   * Re-run discovery + session restore. A VFS RPC sent before the worker's
   * VfsRpcHost attaches is LOST (30s EIO), so the wire-up-time pass can come
   * back empty — hosts re-run this on kernel-ready (idempotent: `open()`
   * skips already-open names, the surfacing ledgers gate re-surfacing).
   */
  resync(): Promise<void>;
}

/**
 * Construct the real `SprinkleManager` over the WC zone: VFS discovery, the
 * iframe renderer + bridge, exec via a worker terminal session, and licks
 * dispatched to the cone. The welcome-flow interceptor is not wired in WC
 * mode yet. Returns the manager + zone so the tray wiring can broadcast
 * sprinkle state to followers.
 */
/**
 * Frame budget for the long-press placement wait: ~3s at 60Hz — generous
 * headroom for a cold sprinkle `open()` (VFS read) while staying inside the
 * ~5s transient-user-activation window `requestFullscreen` needs.
 */
const LONGPRESS_PLACEMENT_FRAMES = 180;

/**
 * Click-and-hold on a sprinkle launcher: its surface goes into BROWSER
 * fullscreen (the real Fullscreen API — the long-press release is the user
 * gesture that authorizes it; Esc / the UA chrome exits natively).
 *
 * This handler does NOT activate the sprinkle itself: the dock's
 * `#handleChildLongpress` calls `selectItem(id)` — emitting
 * `slicc-dock-select` — BEFORE re-emitting the long-press, so the select
 * listener above has already started `manager.activate`. Starting a second
 * activation here would race two `open()` calls into competing
 * containers/renderers. Instead, poll (bounded) until the activation's
 * placement lands in the dock-tree, then fullscreen: a not-yet-placed
 * surface sits parked at `display:none`, and `requestFullscreen()` on a
 * hidden element rejects — which is exactly how the pre-dock-tree gesture
 * broke when the workbench's open/activate step was dropped. If placement
 * outlives the frame budget (or the element denies fullscreen), the surface
 * stays open in the tree, just not fullscreen.
 */
function wireSprinkleLongPressFullscreen(refs: WcShellRefs): void {
  refs.dock.addEventListener('slicc-dock-longpress', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id || sprinkleNameFromId(id) === null) return;
    // Escape for a double-quoted attribute selector (CSS.escape is for
    // identifiers, and jsdom lacks it).
    const quoted = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const tryFullscreen = (framesLeft: number): void => {
      const surface = refs.dockTree.querySelector<HTMLElement>(`[surface-id="${quoted}"]`);
      const placed = surface && !surface.closest('.dock-tree__parking');
      if (placed) {
        void surface.requestFullscreen?.()?.catch(() => {
          // Denied / unsupported / gesture expired — the surface stays open.
        });
        return;
      }
      if (framesLeft <= 0) return;
      requestAnimationFrame(() => tryFullscreen(framesLeft - 1));
    };
    tryFullscreen(LONGPRESS_PLACEMENT_FRAMES);
  });
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
  // Instant rail: launchers for every sprinkle this profile has ever seen,
  // before the (VFS-backed, kernel-gated) discovery resolves.
  zone.seedDockItems(readKnownSprinkleNames());
  const { installSprinkleManagerHandlerOverChannel } = await import(
    '../../scoops/sprinkle-bridge-channel.js'
  );
  const { createSprinkleExecHandler } = await import('../boot/setup-sprinkle-exec.js');
  const { setDipExecHandler } = await import('../dip.js');

  const isExtension = isExtensionRealm();
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
      // Extension etiquette: auto-open sprinkles pulse for attention instead
      // of overlaying the chat mid-flow.
      ...(isExtension ? { autoOpenBehavior: 'attention' as const } : {}),
      // `welcome` backs the inline onboarding dip; it must never appear as a
      // panel sprinkle (mirrors INLINE_DIP_SPRINKLES in main.ts).
      inlineSprinkles: new Set(['welcome']),
      execHandler,
      onAttachImage: onAttachImage ?? (() => {}),
    }
  );
  (window as unknown as Record<string, unknown>).__slicc_sprinkleManager = manager;
  setDipExecHandler(execHandler);
  if (instanceId !== undefined) {
    // Standalone: worker→panel sprinkle ops over the BroadcastChannel.
    const stop = installSprinkleManagerHandlerOverChannel(manager, { instanceId });
    window.addEventListener('beforeunload', () => stop(), { once: true });
  } else if (isExtension) {
    // Extension: the offscreen orchestrator relays sprinkle ops over the
    // panel's OffscreenClient transport — same handler the legacy panel uses.
    const { handleSprinkleOp } = await import('../sprinkle-op-handler.js');
    client.setSprinkleOpHandler((payload: unknown) => {
      const { id, op, name, data } = payload as {
        id: unknown;
        op: string;
        name: string;
        data: unknown;
      };
      void handleSprinkleOp(manager, id, op, name, data);
    });
  }

  // Clicking a dock launcher routes through `activate` so an
  // attention-surfaced sprinkle is promoted to user-opened (and persists)
  // and a closed one reopens. Tool panels are independent, always-mounted
  // tree leaves (see `mountWcShell`) opened/closed via `zone.placeSurface`/
  // `zone.removeSurface` directly, exactly like a sprinkle — the zone itself
  // fires `onToolPanelActivate`/`onToolPanelDeactivate`, so this path and an
  // agent-driven `layout open`/`layout close` get identical lifecycle.
  refs.dock.addEventListener('slicc-dock-select', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    const name = sprinkleNameFromId(id);
    if (name) {
      manager.activate(name).catch((err) => log.error('WC sprinkle activate failed', err));
      return;
    }
    if (id && isToolPanelId(id)) {
      zone.placeSurface(DEFAULT_TOOL_ZONE, id);
    }
  });
  // Clicking the ACTIVE dock item emits collapse (not a second select).
  // Tool panels detach their leaf directly; a sprinkle routes through
  // `manager.minimize` so it goes through the same path as its own in-panel
  // minimize button (bookkeeping stays, only the leaf gets parked).
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
  wireSprinkleLongPressFullscreen(refs);

  let enriching = false;
  const resync = async (): Promise<void> => {
    await manager.refresh();
    // Only prune against a discovery that actually FOUND something — an
    // empty result may be a lost boot RPC, and wiping the seeded rail on it
    // is exactly the disappearing-rail bug class. A confirmed discovery also
    // scrubs the persistent ledgers, so uninstalled sprinkles stop ghosting
    // the seeded rail on later boots.
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
    // Backfill rail icons for sprinkles that declare none: a one-shot LLM
    // pick from the lucide registry, remembered in the icon ledger.
    // Fire-and-forget and single-flight — resync re-fires on kernel-ready.
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
  // Fire the initial discovery+restore in the BACKGROUND — never block the
  // caller on it. It is VFS-backed and kernel-gated, so a slow or stalled walk
  // must not strand the rest of boot: `attachWcClient` sequences the tray
  // leader wiring AFTER this returns, and the awaited resync used to hang there
  // forever when discovery stalled (the leader never started). Hosts re-run
  // resync() on kernel-ready as the recovery, and resync() is idempotent.
  void resync().catch((err) => log.warn('WC shell: initial sprinkle resync failed', err));
  return { manager, zone, resync };
}

/**
 * Pick rail icons for sprinkles still showing the generic sparkles glyph.
 * Declared lucide specs were honored at registration and never reach the
 * picker; ledger hits are reapplied without an LLM call; fresh picks are
 * recorded so each sprinkle is labeled at most once per profile.
 */
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
