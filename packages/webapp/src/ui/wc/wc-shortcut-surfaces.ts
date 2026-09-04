/**
 * The shell half of keyboard mode: the surfaces `wc-shortcuts.ts` drives but
 * deliberately knows nothing about.
 *
 * The mode's rule is that every command reaches its surface through the event
 * a CLICK on that surface produces, so a shortcut can never drift from the
 * mouse. For the rails and the dock that event is a method the component
 * already exposes; for the six commands here it is a DOM lookup — the send
 * button's `stop`, the copy row's two press gestures, the add menu's own
 * `open()`, an approval card's button, the surface the dock is showing. That
 * lookup is what does not belong in the mode: it would tie the keymap to the
 * shell's markup and to a float that may not have any of it.
 *
 * Everything is resolved at press time and every miss is a silent no-op —
 * these run on floats whose composer is disabled, whose transcript is
 * read-only, or which never mounted a workbench at all. The HUD shows the key
 * dimmed and nothing happens, which is the honest reading of "there is no
 * copy row on this screen".
 */

import { requestPlacedSurfaceFullscreen } from './surface-fullscreen.js';
import {
  type ShortcutComposerMeta,
  type ShortcutDock,
  type ShortcutFreezer,
  type ShortcutHandles,
  type ShortcutList,
  type ShortcutSwitcher,
  wireKeyboardShortcuts,
} from './wc-shortcuts.js';

/**
 * A `<slicc-composer>`, as far as this module needs it: the band's hands-free
 * dictation entry point.
 */
interface ComposerLike extends HTMLElement {
  toggleHandsFree(): boolean;
}

/** The elements the shell already has when it wires the mode. */
export interface ShortcutSurfaceDeps {
  /** The composer's input card — the send button and the add menu live in it. */
  inputCard: HTMLElement;
  /** The transcript: approval cards and the copy row are rendered into it. */
  thread: HTMLElement;
  /**
   * Live shell frame that still contains workbench surfaces after
   * `panelizeShell` replaces the dock-tree with `<slicc-layout>`. When
   * omitted (unit harnesses that only mount a tree), {@link dockTree} is
   * the lookup root instead.
   */
  frame?: ParentNode;
  /** The workbench tree (classic layout); also the zoom fallback root. */
  dockTree: HTMLElement;
  /** The dock rail: which surface is open, and the way to open one. */
  dock: { readonly active: string | null; selectItem?(id: string): void };
  /** The left rail, which holds the archived-chat cards. */
  freezer: HTMLElement;
  /** The composer band, for the dictation turn `v` starts and ends. */
  composer: HTMLElement;
  /**
   * The chat column the keyboard-mode HUD pins to. The COLUMN, not the band:
   * a read-only scoop hides its composer entirely (#2312) and the mode has to
   * keep its indicator there.
   */
  chatPane: HTMLElement;
  /**
   * The file tree. `visibleIds()` is the list a positional key addresses —
   * the rows on screen, in order, which is NOT the `items` array: that is a
   * nested shape whose top level is `/workspace` and `/shared` with every
   * actual file under `children`.
   */
  fileTree: { visibleIds(): readonly string[]; selectFile(id: string): void };
  /** The memory panel host, whose `<slicc-memrow>` children are the list. */
  memoryHost: HTMLElement;
}

/** A `<slicc-add-menu>`, as far as this module needs it. */
interface AddMenuLike extends HTMLElement {
  open(): void;
}

/**
 * Stop the running turn.
 *
 * Dispatched at the input card rather than reached into the send button's
 * shadow root: `stop` is a composed, bubbling event, so the card is where the
 * host's listener already is, and the "is anything actually running?" guard
 * stays in that one listener instead of being second-guessed here.
 */
export function stopTurn(deps: ShortcutSurfaceDeps): void {
  deps.inputCard.dispatchEvent(new CustomEvent('stop', { bubbles: true, composed: true }));
}

/** Open the composer's add menu — the `+` button's own public `open()`. */
export function openAttachMenu(deps: ShortcutSurfaceDeps): void {
  const menu = deps.inputCard.querySelector('slicc-add-menu') as AddMenuLike | null;
  menu?.open?.();
}

/**
 * Start (or finish) a dictation turn.
 *
 * The one command here whose surface had to GROW an entry point rather than
 * being handed one it already had: push-to-talk arms on `pointerdown` and
 * holds until `pointerup`, which is not a thing a keyboard can express, so
 * `<slicc-composer>` gained `toggleHandsFree()` — the same press lifecycle
 * with no pointer. Everything else about the turn, including how the
 * transcript is appended and submitted, stays the gesture's own path.
 */
export function toggleVoice(deps: ShortcutSurfaceDeps): void {
  const composer = deps.composer as ComposerLike;
  // Absent on a float that never opted into push-to-talk (the extension side
  // panel, where Chrome denies the mic cross-origin), and on any composer the
  // custom element has not upgraded.
  composer.toggleHandsFree?.();
}

/**
 * Open the tab switcher with peek armed.
 *
 * Two steps in one gesture, and the ORDER is the whole trick: arm the overlay
 * first, then open it through the dock's own event. Opening it makes it modal,
 * which suspends every shell command — so by the time the user's next
 * keystroke lands, the switcher already owns the keyboard and already knows
 * the next activation is a peek. That is what makes `p 1` work as one motion
 * without this module knowing anything about tabs, and without the digit
 * having to be a chord.
 *
 * A float whose switcher cannot peek (a follower, whose tabs are the
 * leader's — `no-peek`) refuses the arming and simply opens: the same key,
 * one honest step less.
 */
export function peekTabs(deps: ShortcutSurfaceDeps): void {
  const overlay = deps.thread.ownerDocument.querySelector('slicc-tab-overlay') as
    | (HTMLElement & { peeking?: boolean })
    | null;
  if (overlay) overlay.peeking = true;
  deps.dock.selectItem?.('browser');
}

/**
 * Scroll the transcript by one message.
 *
 * Position, not selection: "next" is the first message whose top is below the
 * fold, so it means the same thing after the user has scrolled with the wheel
 * as it does after ten presses of the key. Measured against the thread's own
 * box and applied to its `scrollTop`, so a transcript inside a panel scrolls
 * itself rather than dragging the page around it.
 */
export function scrollMessage(deps: ShortcutSurfaceDeps, delta: 1 | -1): void {
  const thread = deps.thread;
  const top = thread.getBoundingClientRect().top;
  // A pixel of slack: a row sitting exactly at the fold is where we already
  // are, not the next place to go.
  const offsets = [...thread.children].map((row) => row.getBoundingClientRect().top - top);
  const target =
    delta > 0 ? offsets.find((offset) => offset > 1) : offsets.filter((o) => o < -1).at(-1);
  if (target === undefined) return;
  thread.scrollTop += target;
}

/**
 * The copy row's two gestures. `<slicc-press-button>` emits `short-click` and
 * `long-press`, and `wc-copy-row.ts` listens for exactly those — so the
 * keyboard fires the gesture rather than re-implementing what it means.
 */
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

/**
 * A dip's document, when this realm may touch it.
 *
 * An approval card is a `mountDip` iframe. In the ordinary float its sandbox
 * carries `allow-same-origin`, so the buttons inside are reachable and the key
 * can land on the primary one. In the extension the same card is served from
 * `sprinkle-sandbox.html` and is another origin, where reading
 * `contentDocument` returns null or throws — hence the try, and hence the
 * fallback of focusing the FRAME, which puts the keyboard inside the card and
 * lets Tab reach the buttons the parent is not allowed to see.
 */
function dipDocument(frame: HTMLIFrameElement | null): Document | null {
  if (!frame) return null;
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}

/**
 * Carry the keyboard to a pending approval card; pressing again goes to the
 * next one.
 *
 * FOCUS, never answer. A key that said "approve" could say it to a card that
 * finished rendering a frame earlier, so the shortcut only carries the user
 * to the request — where Enter belongs to the button itself and means what
 * the button says (keyboard mode leaves a focused button's Enter alone; see
 * `isActivationTarget`).
 *
 * PENDING is read off the container, not off the buttons: `WcChatController`
 * appends a `[data-tool-ui-request]` wrapper per card and removes it the
 * moment the request is answered or withdrawn, so the DOM already states
 * exactly which approvals are outstanding — and states it in the parent
 * document, on the near side of the iframe the card itself lives in.
 *
 * "Next" therefore needs no state either: the cycle is re-read every press, so
 * a card answered between two presses is simply not in the second one's list.
 */
export function focusApproval(deps: ShortcutSurfaceDeps): void {
  const cards = [...deps.thread.querySelectorAll<HTMLElement>('[data-tool-ui-request]')];
  if (cards.length === 0) return;
  const focused = deps.thread.ownerDocument.activeElement;
  // Focus inside a same-origin frame reads as the frame element out here, so
  // "which card am I on?" is a containment test either way.
  const at = cards.findIndex((card) => focused instanceof Node && card.contains(focused));
  const card = cards[(at + 1) % cards.length];
  if (!card) return;
  const frame = card.querySelector('iframe');
  const inner = dipDocument(frame)?.querySelector<HTMLElement>('button[data-action]');
  // An inline card's own button, then the button inside a reachable dip, then
  // the frame itself — first thing that can hold focus wins.
  const target =
    card.querySelector<HTMLElement>('button[data-action]:not([disabled])') ?? inner ?? frame;
  target?.focus?.();
  // Optional: jsdom has no `scrollIntoView`, and carrying the focus is the
  // part that matters — a browser scrolls a focused element into view anyway.
  card.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Full-screen the panel the dock is showing.
 *
 * The real Fullscreen API, like the dock item's long-press — which is why the
 * command runs synchronously inside the keydown: `requestFullscreen()` needs
 * transient user activation, and the keystroke only counts as one while its
 * handler is still on the stack. A surface still parked (`display:none`)
 * would reject, so an unplaced one is left alone rather than made to fail.
 * Placement gate + request live in {@link requestPlacedSurfaceFullscreen}.
 * Prefer `frame` over `dockTree` so panelized layouts (dock-tree removed)
 * still resolve the live leaf.
 */
export function zoomSurface(deps: ShortcutSurfaceDeps): void {
  const id = deps.dock.active;
  if (!id) return;
  requestPlacedSurfaceFullscreen(deps.frame ?? deps.dockTree, id);
}

/**
 * The lists a `<command> <digit>` chord indexes into.
 *
 * Each one activates its nth row the way a click does: the file tree's own
 * `selectFile`, and — for the two lists whose rows ARE their click handler
 * (`<slicc-freezer-card>`, `<slicc-memrow>`) — a click. Both are read live,
 * because half a chord is exactly long enough for a panel to finish mounting
 * or a session to be archived.
 */
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
    // `:not(.match-hidden)` is the search filter: `<slicc-freezer>` live-filters
    // its rows by toggling that class, leaving non-matches in the DOM. A
    // positional key has to mean the nth row the user can SEE, or `r 1` after
    // a search restores something that is not even on screen.
    sessions: clickList(() => deps.freezer, 'slicc-freezer-card:not(.match-hidden):not([hidden])'),
  };
}

/** What the shell hands the mode beyond the six DOM-reached commands. */
export interface ShellKeyboardDeps extends ShortcutSurfaceDeps {
  switcher: ShortcutSwitcher;
  dock: ShortcutDock & { readonly active: string | null };
  freezer: ShortcutFreezer & HTMLElement;
  composerMeta: ShortcutComposerMeta;
}

/**
 * Install keyboard mode over a mounted shell.
 *
 * The seam exists so `buildWcShellFrame` states WHAT the mode drives in one line
 * rather than carrying the closures for it, and so this file — which already
 * owns every DOM-reached command — owns the wiring that binds them too.
 */
export function wireShellKeyboard(deps: ShellKeyboardDeps): ShortcutHandles {
  return wireKeyboardShortcuts({
    switcher: deps.switcher,
    dock: deps.dock,
    freezer: deps.freezer,
    composerMeta: deps.composerMeta,
    hudHost: deps.chatPane,
    composerBand: deps.composer,
    focusComposer: () => deps.inputCard.focus(),
    /**
     * What `applyComposerAvailability` writes, read back: a scoop's band is
     * `hidden` (#2312) and a disconnected follower's card is `disabled`.
     * Either way there is nothing to type into, so keyboard mode is not a
     * choice there — see `ModeIntent`.
     */
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
  });
}
