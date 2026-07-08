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

interface TabDescriptor {
  id: string;
  label: string;
  kind: 'tool' | 'sprinkle';
  closable?: boolean;
  badge?: string;
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
  { id: 'monitor', label: 'monitor', kind: 'tool' },
];

/** Tab/surface/dock bookkeeping behind `SprinkleManagerCallbacks`. */
export class WcSprinkleZone {
  readonly #refs: WcShellRefs;
  readonly #tabs = new Map<string, TabDescriptor>();
  readonly #dockItems = new Map<string, DockItemDescriptor>();
  readonly #surfaces = new Map<string, HTMLElement>();
  /** Names seeded from the known-sprinkles ledger, not yet confirmed by discovery. */
  readonly #seeded = new Set<string>();

  constructor(refs: WcShellRefs) {
    this.#refs = refs;
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
    let surface = this.#surfaces.get(name);
    if (!surface) {
      surface = document.createElement('slicc-surface');
      surface.setAttribute('surface-id', id);
      surface.setAttribute('layout', 'flex');
      this.#refs.workbenchBody.append(surface);
      this.#surfaces.set(name, surface);
    }
    surface.replaceChildren(element);
    const icon = this.#resolveIcon(name, options?.icon);

    this.#tabs.set(name, { id, label: title, kind: 'sprinkle', closable: true, badge: icon });
    this.#ensureDockItem(name, title, options?.icon);
    this.#sync();
    // Background adds (session restore) keep the current focus: what's on
    // screen after a reload is the `ws` URL param's call, not the open set.
    if (!options?.attention && !options?.background) this.#activate(id);
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
    this.#refs.tabBar.tabs = [...BASE_TABS, ...this.#tabs.values()];
    (this.#refs.dock as HTMLElement & { items?: unknown }).items = [...this.#dockItems.values()];
    // The tab bar renders ONLY sprinkle tabs (tools live in the dock) — keep
    // the header strip hidden while it would be empty chrome.
    this.#refs.workbenchHeader.toggleAttribute('hidden', this.#tabs.size === 0);
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
  /**
   * Standalone kernel-worker id; enables the worker→panel sprinkle-ops
   * BroadcastChannel. Absent in the extension float, where those ops arrive
   * over the chrome.runtime relay instead (not wired in WC mode yet).
   */
  instanceId?: string;
  /** Stage an image attachment from a sprinkle into the chat input. */
  onAttachImage?: (base64: string, name?: string, mimeType?: string) => void;
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
export async function wireWcSprinkles(deps: WireWcSprinklesDeps): Promise<WcSprinklesHandle> {
  const { refs, client, fs, instanceId, onAttachImage, log } = deps;
  const zone = new WcSprinkleZone(refs);
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

  // Closing a sprinkle tab closes the sprinkle; clicking a dock launcher
  // routes through `activate` so an attention-surfaced sprinkle is promoted
  // to user-opened (and persists) and a closed one reopens.
  wireSprinkleTabClose(refs.tabBar, (name) => manager.close(name));
  refs.dock.addEventListener('slicc-dock-select', (event) => {
    const name = sprinkleNameFromId((event as CustomEvent<{ id?: string }>).detail?.id);
    if (name) {
      manager.activate(name).catch((err) => log.error('WC sprinkle activate failed', err));
    }
  });

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

/**
 * Route the tab bar's canonical `tab-close` (detail field `id` — the child
 * tab's own raw event uses `tabId`, the bar re-emits with `id`) to a sprinkle
 * close. Without the manager-side close, the tab disappears from the strip
 * but the sprinkle stays open — it lingers in the `sprinkles` URL param and
 * reopens on the next reload.
 */
export function wireSprinkleTabClose(tabBar: HTMLElement, close: (name: string) => void): void {
  tabBar.addEventListener('tab-close', (event) => {
    const name = sprinkleNameFromId((event as CustomEvent<{ id?: string }>).detail?.id);
    if (name) close(name);
  });
}
