/**
 * Page wiring for `computer` UI: overlay cards after browser tabs, live
 * lightbox watch/unwatch, and bash-row live vs frozen frames.
 *
 * Overlay merge is consumed by `wireWcBrowser`; row/lightbox install is
 * called from the workbench boot so transcript rebuilds still bind.
 */

import type { ComputerDescriptor, ComputerFrame } from '@slicc/shared-ts';
import { uint8ToBase64 } from '@slicc/shared-ts';
import {
  decideComputerFrameMode,
  type SliccBashRendererComputer,
  type SliccImagePreview,
  setComputerOutputRenderer,
  type TabDescriptor,
} from '@slicc/webcomponents';
import { classifyImageMarkers } from '../../base/image-markers.js';
import { coerceComputerFrameBytes, sniffFrameMime } from '../../computers/frame-bytes.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { ansiToDom } from '../ansi-to-dom.js';
import type { BootStageLogger } from '../boot/types.js';
import { frameToDataUrl } from '../computer-frame-url.js';
import { getComputersStore } from '../computers-store.js';

export const COMPUTER_OVERLAY_PREFIX = 'computer:';
export const FROZEN_SCREEN_PREFIX = 'screen: ';

const LIGHTBOX_FPS = 4;
const LIGHTBOX_MAX_WIDTH = 768;
const ROW_FPS = 2;
const ROW_MAX_WIDTH = 480;

export type FrozenFrameHint = { kind: 'path'; path: string } | { kind: 'data'; src: string };

export interface WcComputersDeps {
  log: BootStageLogger;
  openFs?: () => Promise<Pick<LocalVfsClient, 'readFile'>>;
}

interface BoundComputerRow {
  el: SliccBashRendererComputer;
  toolCallId: string;
  computerId: string | null;
  watchToken: number | null;
}

interface OverlayLike extends HTMLElement {
  tabs: TabDescriptor[];
}

interface ComputersRuntime {
  deps: WcComputersDeps;
  bound: Map<SliccBashRendererComputer, BoundComputerRow>;
  overlayUnsubs: Array<() => void>;
  overlayWatchIds: Map<string, number>;
  lightboxId: string | null;
  lightboxWatchToken: number | null;
  lightboxOrigin: HTMLElement | null;
  preview: SliccImagePreview | null;
  installed: boolean;
}

const silentLog: BootStageLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let runtime: ComputersRuntime | null = null;

export function computerOverlayId(id: string): string {
  return `${COMPUTER_OVERLAY_PREFIX}${id}`;
}

export function parseComputerOverlayId(tabId: string): string | null {
  return tabId.startsWith(COMPUTER_OVERLAY_PREFIX)
    ? tabId.slice(COMPUTER_OVERLAY_PREFIX.length)
    : null;
}

/** Pull `-c` / `--computer` from a `computer …` bash command line. */
export function parseComputerIdFromCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-c' || tokens[i] === '--computer') return tokens[i + 1] ?? null;
  }
  return null;
}

/** Frozen still from `screen: <path>` or a well-formed `<img:>` marker. */
export function parseFrozenScreenPath(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FROZEN_SCREEN_PREFIX)) continue;
    const path = trimmed.slice(FROZEN_SCREEN_PREFIX.length).trim();
    if (path) return path;
  }
  return null;
}

export function parseFrozenImgSrc(output: string): string | null {
  const image = classifyImageMarkers(output).find((m) => m.kind === 'image' && m.parsed);
  return image?.parsed?.dataUrl ?? null;
}

export function parseFrozenFrameHint(output: string): FrozenFrameHint | null {
  const path = parseFrozenScreenPath(output);
  if (path) return { kind: 'path', path };
  const src = parseFrozenImgSrc(output);
  return src ? { kind: 'data', src } : null;
}

export { frameToDataUrl } from '../computer-frame-url.js';

export function computerToTab(
  computer: ComputerDescriptor,
  frame: ComputerFrame | null
): TabDescriptor {
  return {
    id: computerOverlayId(computer.id),
    title: computer.title,
    url: computer.kind,
    screenshot: frame ? frameToDataUrl(frame) : undefined,
    kind: 'computer',
    live: computer.state === 'live',
    softKeys: computer.softKeys?.map((k) => ({ label: k.label, keysym: k.keysym })),
  };
}

/** Browser tabs first, then every registered computer. */
export function mergeOverlayTabs(
  browserTabs: TabDescriptor[],
  computers: ComputerDescriptor[] = getComputersStore().list()
): TabDescriptor[] {
  const store = getComputersStore();
  const pages = browserTabs.filter((tab) => tab.kind !== 'computer');
  const cards = computers.map((c) => computerToTab(c, store.lastFrame(c.id)));
  return [...pages, ...cards];
}

function ensureRuntime(deps?: Partial<WcComputersDeps>): ComputersRuntime {
  if (runtime) {
    if (deps?.log) runtime.deps.log = deps.log;
    if (deps?.openFs) runtime.deps.openFs = deps.openFs;
    return runtime;
  }
  runtime = {
    deps: { log: deps?.log ?? silentLog, openFs: deps?.openFs },
    bound: new Map(),
    overlayUnsubs: [],
    overlayWatchIds: new Map(),
    lightboxId: null,
    lightboxWatchToken: null,
    lightboxOrigin: null,
    preview: null,
    installed: false,
  };
  return runtime;
}

function paintOutput(target: HTMLElement, text: string): void {
  target.append(ansiToDom(text));
}

function onRowBind(event: Event): void {
  const el = event.target as SliccBashRendererComputer;
  const detail = (event as CustomEvent<{ toolCallId: string; command: string; output: string }>)
    .detail;
  const computerId = parseComputerIdFromCommand(detail.command ?? el.command ?? '');
  const toolCallId = detail.toolCallId || el.toolCallId;
  const row: BoundComputerRow = { el, toolCallId, computerId, watchToken: null };
  ensureRuntime().bound.set(el, row);
  el.addEventListener('computer-row-unbind', onRowUnbind);
  if (computerId && toolCallId) getComputersStore().recordInvocation(computerId, toolCallId);
  refreshAllRows();
}

function onRowUnbind(event: Event): void {
  const el = event.target as SliccBashRendererComputer;
  const rt = runtime;
  if (!rt) return;
  const row = rt.bound.get(el);
  if (!row) return;
  rt.bound.delete(el);
  el.removeEventListener('computer-row-unbind', onRowUnbind);
  if (row.watchToken !== null && row.computerId) {
    try {
      getComputersStore().unwatch(row.computerId, row.watchToken);
    } catch (err) {
      rt.deps.log.warn('WC computers: unwatch on row unbind failed', err);
    }
  }
  refreshAllRows();
}

function onRowFrameClick(event: Event): void {
  const el = event.target as SliccBashRendererComputer;
  const row = runtime?.bound.get(el);
  const src = (event as CustomEvent<{ src: string }>).detail?.src;
  if (!row?.computerId || !src) return;
  openComputerLightbox(row.computerId, src, el);
}

function refreshAllRows(): void {
  const rt = runtime;
  if (!rt) return;
  for (const row of rt.bound.values()) refreshRow(row);
}

function refreshRow(row: BoundComputerRow): void {
  const store = getComputersStore();
  const computer = row.computerId ? store.get(row.computerId) : null;
  const hint = parseFrozenFrameHint(row.el.output ?? '');
  const liveFrame = row.computerId ? store.lastFrame(row.computerId) : null;
  const newest = row.computerId ? store.newestInvocation(row.computerId) : null;
  const shouldWatch =
    Boolean(row.computerId) && computer?.state === 'live' && newest === row.toolCallId;
  const mode = decideComputerFrameMode({
    computerLive: computer?.state === 'live',
    newestToolCallId: newest,
    toolCallId: row.toolCallId,
    hasFrame: Boolean(hint),
    hasPushedFrame: Boolean(liveFrame),
  });
  row.el.frameMode = mode;
  syncRowWatch(row, shouldWatch);
  if (mode === 'live' && liveFrame) {
    row.el.frameSrc = frameToDataUrl(liveFrame);
    return;
  }
  if (mode === 'frozen') void applyFrozenFrame(row, row.el.output ?? '');
  else row.el.frameSrc = null;
}

function syncRowWatch(row: BoundComputerRow, shouldWatch: boolean): void {
  if (!row.computerId) return;
  const store = getComputersStore();
  if (shouldWatch && row.watchToken === null) {
    row.watchToken = store.watch(row.computerId, ROW_FPS, ROW_MAX_WIDTH);
  } else if (!shouldWatch && row.watchToken !== null) {
    store.unwatch(row.computerId, row.watchToken);
    row.watchToken = null;
  }
}

async function applyFrozenFrame(row: BoundComputerRow, output: string): Promise<void> {
  const path = parseFrozenScreenPath(output);
  if (path) {
    const src = await readFrozenPath(path);
    if (src) {
      row.el.frameSrc = src;
      return;
    }
  }
  row.el.frameSrc = parseFrozenImgSrc(output);
}

async function readFrozenPath(path: string): Promise<string | null> {
  const openFs = runtime?.deps.openFs;
  if (!openFs) return null;
  try {
    const fs = await openFs();
    const raw = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
    const bytes = coerceComputerFrameBytes(raw);
    const mime = sniffFrameMime(bytes) ?? 'image/jpeg';
    return `data:${mime};base64,${uint8ToBase64(bytes)}`;
  } catch (err) {
    runtime?.deps.log.warn('WC computers: frozen frame read failed', { path, err });
    return null;
  }
}

function onStoreFrame(id: string, frame: ComputerFrame): void {
  const src = frameToDataUrl(frame);
  const rt = ensureRuntime();
  if (rt.lightboxId === id) {
    const preview = ensurePreview();
    if (preview.isOpen) preview.setSrc(src);
    else preview.open(src, rt.lightboxOrigin ?? preview);
  }
  refreshAllRows();
}

function ensurePreview(): SliccImagePreview {
  const rt = ensureRuntime();
  if (rt.preview?.isConnected) return rt.preview;
  const host = document.createElement('slicc-image-preview');
  host.setAttribute('data-computer-live', '');
  document.body.append(host);
  host.addEventListener('slicc-image-preview-close', () => closeComputerLightbox());
  rt.preview = host;
  return host;
}

function openComputerLightbox(computerId: string, src: string, origin: HTMLElement): void {
  const rt = ensureRuntime();
  const store = getComputersStore();
  if (rt.lightboxId && rt.lightboxId !== computerId && rt.lightboxWatchToken !== null) {
    store.unwatch(rt.lightboxId, rt.lightboxWatchToken);
    rt.lightboxWatchToken = null;
  }
  if (rt.lightboxId !== computerId || rt.lightboxWatchToken === null) {
    rt.lightboxWatchToken = store.watch(computerId, LIGHTBOX_FPS, LIGHTBOX_MAX_WIDTH);
    rt.lightboxId = computerId;
  }
  rt.lightboxOrigin = origin;
  const preview = ensurePreview();
  const live = store.lastFrame(computerId);
  const nextSrc = live ? frameToDataUrl(live) : src;
  if (!nextSrc) return;
  if (preview.isOpen) preview.setSrc(nextSrc);
  else preview.open(nextSrc, origin);
}

function closeComputerLightbox(): void {
  const rt = runtime;
  if (!rt?.lightboxId) return;
  if (rt.lightboxWatchToken !== null) {
    try {
      getComputersStore().unwatch(rt.lightboxId, rt.lightboxWatchToken);
    } catch (err) {
      rt.deps.log.warn('WC computers: lightbox unwatch failed', err);
    }
    rt.lightboxWatchToken = null;
  }
  rt.lightboxId = null;
  rt.lightboxOrigin = null;
}

function overlayCardOrigin(overlay: OverlayLike, tabId: string): HTMLElement {
  return (overlay.shadowRoot?.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`) ??
    overlay) as HTMLElement;
}

function dropOverlayWatches(): void {
  const rt = runtime;
  if (!rt) return;
  const store = getComputersStore();
  for (const [id, token] of [...rt.overlayWatchIds]) {
    try {
      store.unwatch(id, token);
    } catch {
      /* store may already be reset in tests */
    }
    rt.overlayWatchIds.delete(id);
  }
}

function remeshOverlay(overlay: OverlayLike): void {
  syncOverlayWatches(overlay);
  if (!overlay.hasAttribute('open')) return;
  overlay.tabs = mergeOverlayTabs(overlay.tabs);
}

/**
 * Overlay cards only get thumbnails from `store.lastFrame`, and that map
 * fills from `computer-frame` pushes. Watch every registered computer
 * while the overlay is open so the kernel pump actually runs.
 */
function syncOverlayWatches(overlay: OverlayLike): void {
  const rt = ensureRuntime();
  const store = getComputersStore();
  const want = overlay.hasAttribute('open') ? store.list().map((c) => c.id) : [];
  const wantSet = new Set(want);
  for (const [id, token] of [...rt.overlayWatchIds]) {
    if (wantSet.has(id)) continue;
    try {
      store.unwatch(id, token);
    } catch (err) {
      rt.deps.log.warn('WC computers: overlay unwatch failed', err);
    }
    rt.overlayWatchIds.delete(id);
  }
  for (const id of want) {
    if (rt.overlayWatchIds.has(id)) continue;
    try {
      rt.overlayWatchIds.set(id, store.watch(id, ROW_FPS, ROW_MAX_WIDTH));
    } catch (err) {
      rt.deps.log.warn('WC computers: overlay watch failed', err);
    }
  }
}

/**
 * Document-level install: ANSI output hook, bash-row bind/unbind, live
 * frames. Idempotent — a second call updates `openFs` / `log`.
 */
export function installWcComputers(deps: WcComputersDeps): () => void {
  const rt = ensureRuntime(deps);
  setComputerOutputRenderer(paintOutput);
  if (rt.installed) return disposeWcComputers;
  rt.installed = true;
  document.addEventListener('computer-row-bind', onRowBind);
  document.addEventListener('computer-row-unbind', onRowUnbind);
  document.addEventListener('computer-frame-click', onRowFrameClick);
  const store = getComputersStore();
  rt.overlayUnsubs.push(store.onList(() => refreshAllRows()));
  rt.overlayUnsubs.push(store.onInvocations(() => refreshAllRows()));
  rt.overlayUnsubs.push(store.onFrame(onStoreFrame));
  return disposeWcComputers;
}

/** Merge computer cards into an existing tab overlay and handle activate/softkeys. */
export function bindComputerOverlay(overlay: OverlayLike, log?: BootStageLogger): () => void {
  const rt = ensureRuntime(log ? { log } : undefined);
  const store = getComputersStore();
  const onActivate = (event: Event): void => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    const computerId = id ? parseComputerOverlayId(id) : null;
    if (!computerId) return;
    const frame = store.lastFrame(computerId);
    const src = frame ? frameToDataUrl(frame) : '';
    if (!src) {
      rt.deps.log.warn('WC computers: no frame yet for lightbox', { id: computerId });
    }
    openComputerLightbox(computerId, src, overlayCardOrigin(overlay, id));
  };
  const onSoftKey = (event: Event): void => {
    const detail = (event as CustomEvent<{ id: string; keysym: string }>).detail;
    const computerId = detail?.id ? parseComputerOverlayId(detail.id) : null;
    if (!computerId || !detail.keysym) return;
    try {
      store.input(computerId, [{ type: 'key', keysym: detail.keysym }]);
    } catch (err) {
      rt.deps.log.warn('WC computers: softkey input failed', err);
    }
  };
  overlay.addEventListener('tab-activate', onActivate);
  overlay.addEventListener('tab-peek', onActivate);
  overlay.addEventListener('computer-softkey', onSoftKey);
  const onClose = (): void => remeshOverlay(overlay);
  overlay.addEventListener('overlay-close', onClose);
  const mo = new MutationObserver(() => remeshOverlay(overlay));
  mo.observe(overlay, { attributes: true, attributeFilter: ['open'] });
  const offList = store.onList(() => remeshOverlay(overlay));
  const offFrame = store.onFrame(() => remeshOverlay(overlay));
  remeshOverlay(overlay);
  return () => {
    overlay.removeEventListener('tab-activate', onActivate);
    overlay.removeEventListener('tab-peek', onActivate);
    overlay.removeEventListener('computer-softkey', onSoftKey);
    overlay.removeEventListener('overlay-close', onClose);
    mo.disconnect();
    offList();
    offFrame();
    dropOverlayWatches();
  };
}

export function disposeWcComputers(): void {
  const rt = runtime;
  if (!rt) return;
  document.removeEventListener('computer-row-bind', onRowBind);
  document.removeEventListener('computer-row-unbind', onRowUnbind);
  document.removeEventListener('computer-frame-click', onRowFrameClick);
  for (const off of rt.overlayUnsubs) off();
  dropOverlayWatches();
  for (const row of rt.bound.values()) {
    if (row.watchToken !== null && row.computerId) {
      try {
        getComputersStore().unwatch(row.computerId, row.watchToken);
      } catch {
        /* store may already be reset in tests */
      }
    }
  }
  if (rt.lightboxWatchToken !== null && rt.lightboxId) {
    try {
      getComputersStore().unwatch(rt.lightboxId, rt.lightboxWatchToken);
    } catch {
      /* ignore */
    }
  }
  rt.preview?.remove();
  runtime = null;
}

export function disposeWcComputersForTests(): void {
  disposeWcComputers();
}
