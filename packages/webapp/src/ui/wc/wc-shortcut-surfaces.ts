import { requestPlacedSurfaceFullscreen } from './surface-fullscreen.js';
import { createShortcutCaps } from './wc-shortcut-caps.js';
import { createShortcutUsage } from './wc-shortcut-usage.js';
import {
  type ShortcutComposerMeta,
  type ShortcutDock,
  type ShortcutFreezer,
  type ShortcutHandles,
  type ShortcutList,
  type ShortcutSwitcher,
  wireKeyboardShortcuts,
} from './wc-shortcuts.js';

interface ComposerLike extends HTMLElement {
  toggleHandsFree(): boolean;
}

export interface ShortcutSurfaceDeps {
  inputCard: HTMLElement;

  thread: HTMLElement;

  frame?: ParentNode;

  dockTree: HTMLElement;

  dock: { readonly active: string | null; selectItem?(id: string): void };

  freezer: HTMLElement;

  composer: HTMLElement;

  chatPane: HTMLElement;

  fileTree: { visibleIds(): readonly string[]; selectFile(id: string): void };

  memoryHost: HTMLElement;
}

interface AddMenuLike extends HTMLElement {
  open(): void;
}

export function stopTurn(deps: ShortcutSurfaceDeps): void {
  deps.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true, composed: true }));
}

export function openAttachMenu(deps: ShortcutSurfaceDeps): void {
  const menu = deps.inputCard.querySelector('slicc-add-menu') as AddMenuLike | null;
  menu?.open?.();
}

export function toggleVoice(deps: ShortcutSurfaceDeps): void {
  const composer = deps.composer as ComposerLike;

  composer.toggleHandsFree?.();
}

export function peekTabs(deps: ShortcutSurfaceDeps): void {
  const overlay = deps.thread.ownerDocument.querySelector('slicc-tab-overlay') as
    | (HTMLElement & { peeking?: boolean })
    | null;
  if (overlay) overlay.peeking = true;
  deps.dock.selectItem?.('browser');
}

export function scrollMessage(deps: ShortcutSurfaceDeps, delta: 1 | -1): void {
  const thread = deps.thread;
  const top = thread.getBoundingClientRect().top;

  const offsets = [...thread.children].map((row) => row.getBoundingClientRect().top - top);
  const target =
    delta > 0 ? offsets.find((offset) => offset > 1) : offsets.filter((o) => o < -1).at(-1);
  if (target === undefined) return;
  thread.scrollTop += target;
}

function pressCopyRow(deps: ShortcutSurfaceDeps, type: 'short-click' | 'long-press'): void {
  const button = deps.thread.querySelector('.wc-copy-row slicc-press-button');
  button?.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail: {} }));
}

export function copyReply(deps: ShortcutSurfaceDeps): void {
  pressCopyRow(deps, 'short-click');
}

export function copyChat(deps: ShortcutSurfaceDeps): void {
  pressCopyRow(deps, 'long-press');
}

function dipDocument(frame: HTMLIFrameElement | null): Document | null {
  if (!frame) return null;
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}

export function focusApproval(deps: ShortcutSurfaceDeps): void {
  const cards = [...deps.thread.querySelectorAll<HTMLElement>('[data-tool-ui-request]')];
  if (cards.length === 0) return;
  const focused = deps.thread.ownerDocument.activeElement;

  const at = cards.findIndex((card) => focused instanceof Node && card.contains(focused));
  const card = cards[(at + 1) % cards.length];
  if (!card) return;
  const frame = card.querySelector('iframe');
  const inner = dipDocument(frame)?.querySelector<HTMLElement>('button[data-action]');

  const target =
    card.querySelector<HTMLElement>('button[data-action]:not([disabled])') ?? inner ?? frame;
  target?.focus?.();

  card.scrollIntoView?.({ block: 'nearest' });
}

export function zoomSurface(deps: ShortcutSurfaceDeps): void {
  const id = deps.dock.active;
  if (!id) return;
  requestPlacedSurfaceFullscreen(deps.frame ?? deps.dockTree, id);
}

export function shortcutLists(deps: ShortcutSurfaceDeps): {
  files: ShortcutList;
  memory: ShortcutList;
  sessions: ShortcutList;
} {
  const clickList = (root: () => ParentNode, selector: string): ShortcutList => ({
    size: () => root().querySelectorAll(selector).length,
    selectAt: (index) => {
      const el = root().querySelectorAll<HTMLElement>(selector)[index];
      el?.click();
    },
  });
  return {
    files: {
      size: () => deps.fileTree.visibleIds().length,
      selectAt: (index) => {
        const id = deps.fileTree.visibleIds()[index];
        if (id) deps.fileTree.selectFile(id);
      },
    },
    memory: clickList(() => deps.memoryHost, 'slicc-memrow'),

    sessions: clickList(() => deps.freezer, 'slicc-freezer-card:not(.match-hidden):not([hidden])'),
  };
}

export interface ShellKeyboardDeps extends ShortcutSurfaceDeps {
  switcher: ShortcutSwitcher;
  dock: ShortcutDock & { readonly active: string | null };
  freezer: ShortcutFreezer & HTMLElement;
  composerMeta: ShortcutComposerMeta;
}

export function wireShellKeyboard(deps: ShellKeyboardDeps): ShortcutHandles {
  return wireKeyboardShortcuts({
    switcher: deps.switcher,
    dock: deps.dock,
    freezer: deps.freezer,
    composerMeta: deps.composerMeta,
    hudHost: deps.chatPane,
    composerBand: deps.composer,
    focusComposer: () => deps.inputCard.focus(),

    composerAvailable: () =>
      !deps.composer.hasAttribute('hidden') && !deps.inputCard.hasAttribute('disabled'),
    stopTurn: () => stopTurn(deps),
    toggleVoice: () => toggleVoice(deps),
    scrollMessage: (delta) => scrollMessage(deps, delta),
    focusApproval: () => focusApproval(deps),
    openAttachMenu: () => openAttachMenu(deps),
    copyReply: () => copyReply(deps),
    copyChat: () => copyChat(deps),
    zoomSurface: () => zoomSurface(deps),
    peekTabs: () => peekTabs(deps),
    lists: shortcutLists(deps),

    caps: createShortcutCaps({
      inputCard: deps.inputCard,
      root: deps.chatPane,
      switcher: deps.switcher,
    }),

    usage: createShortcutUsage(deps.chatPane.ownerDocument),
  });
}
