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
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import { ansiToDom } from '../ansi-to-dom.js';
import type { BootStageLogger } from '../boot/types.js';
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
  watching: boolean;
}

interface OverlayLike extends HTMLElement {
  tabs: TabDescriptor[];
}

interface ComputersRuntime {
  deps: WcComputersDeps;
  bound: Map<SliccBashRendererComputer, BoundComputerRow>;
  overlayUnsubs: Array<() => void>;
  lightboxId: string | null;
  lightboxWatched: boolean;
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
export function parseFrozenFrameHint(output: string): FrozenFrameHint | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FROZEN_SCREEN_PREFIX)) continue;
    const path = trimmed.slice(FROZEN_SCREEN_PREFIX.length).trim();
    if (path) return { kind: 'path', path };
  }
  const image = classifyImageMarkers(output).find((m) => m.kind === 'image' && m.parsed);
  return image?.parsed ? { kind: 'data', src: image.parsed.dataUrl } : null;
}

export function frameToDataUrl(frame: ComputerFrame): string {
  return `data:${frame.mime};base64,${uint8ToBase64(frame.bytes)}`;
}

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
    lightboxId: null,
    lightboxWatched: false,
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
  const row: BoundComputerRow = { el, toolCallId, computerId, watching: false };
  ensureRuntime().bound.set(el, row);
  if (computerId && toolCallId) getComputersStore().recordInvocation(computerId, toolCallId);
  refreshAllRows();
}

function onRowUnbind(event: Event): void {
  const el = event.target as SliccBashRendererComputer;
  const rt = runtime;
  if (!rt) return;
  const row = rt.bound.get(el);
  rt.bound.delete(el);
  if (row?.watching && row.computerId) {
    try {
      getComputersStore().unwatch(row.computerId);
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
  const mode = decideComputerFrameMode({
    computerLive: computer?.state === 'live',
    newestToolCallId: row.computerId ? store.newestInvocation(row.computerId) : null,
    toolCallId: row.toolCallId,
    hasFrame: Boolean(hint || liveFrame),
  });
  row.el.frameMode = mode;
  syncRowWatch(row, mode === 'live');
  if (mode === 'live') {
    row.el.frameSrc = liveFrame ? frameToDataUrl(liveFrame) : row.el.frameSrc;
    return;
  }
  if (mode === 'frozen') void applyFrozenFrame(row, hint, liveFrame);
  else row.el.frameSrc = null;
}

function syncRowWatch(row: BoundComputerRow, shouldWatch: boolean): void {
  if (!row.computerId) return;
  const store = getComputersStore();
  if (shouldWatch && !row.watching) {
    store.watch(row.computerId, ROW_FPS, ROW_MAX_WIDTH);
    row.watching = true;
  } else if (!shouldWatch && row.watching) {
    store.unwatch(row.computerId);
    row.watching = false;
  }
}

async function applyFrozenFrame(
  row: BoundComputerRow,
  hint: FrozenFrameHint | null,
  liveFrame: ComputerFrame | null
): Promise<void> {
  if (hint?.kind === 'data') {
    row.el.frameSrc = hint.src;
    return;
  }
  if (hint?.kind === 'path') {
    const src = await readFrozenPath(hint.path);
    if (src) {
      row.el.frameSrc = src;
      return;
    }
  }
  row.el.frameSrc = liveFrame ? frameToDataUrl(liveFrame) : null;
}

async function readFrozenPath(path: string): Promise<string | null> {
  const openFs = runtime?.deps.openFs;
  if (!openFs) return null;
  try {
    const fs = await openFs();
    const raw = (await fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    bytes.set(raw);
    return `data:image/jpeg;base64,${uint8ToBase64(bytes)}`;
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
  for (const row of rt.bound.values()) {
    if (row.computerId === id && row.el.frameMode === 'live') row.el.frameSrc = src;
  }
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
  if (rt.lightboxId && rt.lightboxId !== computerId && rt.lightboxWatched) {
    store.unwatch(rt.lightboxId);
    rt.lightboxWatched = false;
  }
  if (rt.lightboxId !== computerId) {
    store.watch(computerId, LIGHTBOX_FPS, LIGHTBOX_MAX_WIDTH);
    rt.lightboxWatched = true;
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
  if (rt.lightboxWatched) {
    try {
      getComputersStore().unwatch(rt.lightboxId);
    } catch (err) {
      rt.deps.log.warn('WC computers: lightbox unwatch failed', err);
    }
    rt.lightboxWatched = false;
  }
  rt.lightboxId = null;
  rt.lightboxOrigin = null;
}

function overlayCardOrigin(overlay: OverlayLike, tabId: string): HTMLElement {
  return (overlay.shadowRoot?.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`) ??
    overlay) as HTMLElement;
}

function remeshOverlay(overlay: OverlayLike): void {
  if (!overlay.hasAttribute('open')) return;
  overlay.tabs = mergeOverlayTabs(overlay.tabs);
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
  const offList = store.onList(() => remeshOverlay(overlay));
  const offFrame = store.onFrame(() => remeshOverlay(overlay));
  return () => {
    overlay.removeEventListener('tab-activate', onActivate);
    overlay.removeEventListener('tab-peek', onActivate);
    overlay.removeEventListener('computer-softkey', onSoftKey);
    offList();
    offFrame();
  };
}

export function disposeWcComputers(): void {
  const rt = runtime;
  if (!rt) return;
  document.removeEventListener('computer-row-bind', onRowBind);
  document.removeEventListener('computer-row-unbind', onRowUnbind);
  document.removeEventListener('computer-frame-click', onRowFrameClick);
  for (const off of rt.overlayUnsubs) off();
  for (const row of rt.bound.values()) {
    if (row.watching && row.computerId) {
      try {
        getComputersStore().unwatch(row.computerId);
      } catch {
        /* store may already be reset in tests */
      }
    }
  }
  if (rt.lightboxWatched && rt.lightboxId) {
    try {
      getComputersStore().unwatch(rt.lightboxId);
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
