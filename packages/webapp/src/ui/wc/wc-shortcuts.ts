/**
 * Keyboard shortcuts for the WC shell.
 *
 * Two rules shape everything here:
 *
 * 1. **Never fight the browser.** ⌘1–9 switches Chrome tabs on macOS and
 *    Ctrl+1–9 does the same on Windows/Linux, so neither can be the unit
 *    switcher. The one chord free on all three is Ctrl+Shift+<digit>; macOS
 *    additionally leaves plain Ctrl+<digit> unclaimed, so the Mac binding
 *    drops the Shift (and still accepts it, so muscle memory travels).
 * 2. **Go through the strip, not around it.** A digit resolves to a tab in
 *    `<slicc-agent-tabs>` and calls its `select()`, which fires the same
 *    `slicc-scoop-select` a click does. Every float — leader, extension
 *    popout, follower — already listens for that event, so the shortcut
 *    inherits their selection semantics (queue stashing, read-only locks,
 *    tray round trips) instead of re-implementing them and drifting.
 *
 * Digits index the strip AS RENDERED (`orderForSwitcher`: cones first, then
 * the selected cone's scoops), so "the third thing I can see" is the third
 * thing that happens. `9` is the LAST unit rather than the ninth, matching
 * the browser-tab convention it borrows the chord's shape from.
 *
 * Unmodified letters (`/`, `?`, `c`) only fire when the user is not typing —
 * see {@link isTypingTarget}, which reads `composedPath()` so a textarea
 * inside a component's shadow root still counts as typing.
 */

/** The bit of `<slicc-agent-tabs>` the shortcuts need. */
export interface ShortcutSwitcher {
  /** Tab descriptors in rendered order; `key` is the unit's jid. */
  readonly scoops: ReadonlyArray<{ key: string; label?: string }>;
  /** Select by key — dispatches `slicc-scoop-select`, exactly like a click. */
  select(key: string): void;
}

export interface ShortcutDeps {
  switcher: ShortcutSwitcher;
  /** Put the caret in the composer (`c`). Omit on floats without one. */
  focusComposer?: () => void;
  /** Injected for tests; defaults to the switcher's own document. */
  doc?: Document;
  /**
   * Platform override for tests. When unset it is sniffed from the
   * `navigator` of `doc`'s window.
   */
  isMac?: boolean;
}

export interface ShortcutHandles {
  /** Remove the global listener and any open overlay. */
  dispose(): void;
  /** Open the help overlay (what `?` does). */
  showHelp(): void;
  /** Close it, if open. */
  hideHelp(): void;
  /** The mounted overlay element, or `null` when closed (for tests). */
  helpOverlay(): HTMLElement | null;
}

type HelpDialog = HTMLElement & { show?: () => void; hide?: () => void };

/** One documented binding: the keys, and what they do. */
export interface ShortcutRow {
  keys: string[];
  description: string;
}

const STYLE_ID = 'slicc-shortcuts-style';
const CSS = `
slicc-dialog.wcsc-dialog::part(dialog){width:min(420px,92vw);}
.wcsc{display:flex;flex-direction:column;gap:2px;font-family:var(--ui);color:var(--ink);}
.wcsc__row{display:flex;align-items:center;gap:12px;padding:7px 2px;border-bottom:1px solid var(--line);}
.wcsc__row:last-child{border-bottom:0;}
.wcsc__desc{flex:1;min-width:0;font-size:12.5px;}
.wcsc__keys{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
.wcsc__key{font:600 11px/1 var(--mono,ui-monospace,monospace);color:var(--txt-2);background:var(--ghost);border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:4px 6px;white-space:nowrap;}
.wcsc__sep{font-size:11px;color:var(--txt-3);}
`;

/**
 * Sniff macOS. `userAgentData.platform` is the modern spelling;
 * `navigator.platform` is deprecated but still the only thing Safari and
 * older Chrome report.
 */
export function detectMac(nav: Navigator | undefined): boolean {
  if (!nav) return false;
  const modern = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  return /mac/i.test(modern || nav.platform || nav.userAgent || '');
}

/**
 * Is the event headed somewhere the user is typing? Read from
 * `composedPath()` so a `<textarea>` inside a shadow root (the composer, the
 * terminal's helper input) is seen for what it is — `event.target` would be
 * retargeted to the host element and read as "not typing".
 */
export function isTypingTarget(event: Event): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const node = (path[0] as EventTarget | undefined) ?? event.target;
  if (!node || typeof node !== 'object') return false;
  // Duck-typed, not `instanceof HTMLElement`: an element from another realm
  // (an iframe, jsdom) fails the identity check while being exactly the
  // thing we must not steal keystrokes from.
  const el = node as Partial<HTMLElement> & { tagName?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  // `isContentEditable` is a computed property some DOM implementations
  // (jsdom) never define, and it is the only one that sees inheritance —
  // hence the walk to the nearest declaring ancestor rather than a lookup
  // on the target alone.
  const editable = (el as Partial<Element>).closest?.('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable') !== 'false';
}

/** The digit 1–9 a key event names, by physical position, or `null`. */
export function digitFor(event: KeyboardEvent): number | null {
  // `code` first: with Shift held, `key` is `!`/`@`/… on a US layout, so the
  // physical key is the only stable reading of "the 3 key".
  const byCode = /^Digit([1-9])$/.exec(event.code ?? '');
  if (byCode) return Number(byCode[1]);
  return /^[1-9]$/.test(event.key) ? Number(event.key) : null;
}

/**
 * Does this event carry the unit-switch modifier? Ctrl and nothing else on
 * macOS (⌘ and ⌥ stay with the OS and the browser); Ctrl+Shift everywhere
 * else, because bare Ctrl+<digit> is Chrome's own tab switcher there.
 */
export function hasSwitchModifier(event: KeyboardEvent, isMac: boolean): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey) return false;
  return isMac || event.shiftKey;
}

/**
 * The unit a digit selects: `1`–`8` index the strip, `9` is always the last
 * tab (Chrome's `⌘9`). `null` when the strip is shorter than the digit.
 */
export function unitKeyForDigit(
  scoops: ReadonlyArray<{ key: string }>,
  digit: number
): string | null {
  if (scoops.length === 0) return null;
  if (digit === 9) return scoops[scoops.length - 1].key;
  return scoops[digit - 1]?.key ?? null;
}

/** The documented bindings, with the platform's spelling of the modifier. */
export function shortcutRows(isMac: boolean): ShortcutRow[] {
  const chord = isMac ? ['Ctrl'] : ['Ctrl', 'Shift'];
  return [
    { keys: [...chord, '1'], description: 'Switch to the first agent in the strip' },
    { keys: [...chord, '2 – 8'], description: 'Switch to the 2nd – 8th agent' },
    { keys: [...chord, '9'], description: 'Switch to the last agent' },
    { keys: ['c'], description: 'Focus the composer' },
    { keys: ['?'], description: 'Show this help' },
    { keys: ['Esc'], description: 'Close this help' },
  ];
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement)?.append(style);
}

/** The overlay body: one row per binding, keys rendered as `<kbd>`-ish chips. */
function buildHelpBody(doc: Document, rows: readonly ShortcutRow[]): HTMLElement {
  const list = doc.createElement('div');
  list.className = 'wcsc';
  for (const row of rows) {
    const line = doc.createElement('div');
    line.className = 'wcsc__row';
    const desc = doc.createElement('div');
    desc.className = 'wcsc__desc';
    desc.textContent = row.description;
    const keys = doc.createElement('div');
    keys.className = 'wcsc__keys';
    row.keys.forEach((key, index) => {
      if (index > 0) {
        const sep = doc.createElement('span');
        sep.className = 'wcsc__sep';
        sep.textContent = '+';
        keys.append(sep);
      }
      const kbd = doc.createElement('kbd');
      kbd.className = 'wcsc__key';
      kbd.textContent = key;
      keys.append(kbd);
    });
    line.append(desc, keys);
    list.append(line);
  }
  return list;
}

/**
 * Install the shell's global key handling. Safe to call on any float: the
 * only shell contract is the switcher, and `focusComposer` is optional.
 */
export function wireKeyboardShortcuts(deps: ShortcutDeps): ShortcutHandles {
  const doc = deps.doc ?? (deps.switcher as unknown as { ownerDocument?: Document })?.ownerDocument;
  if (!doc) throw new Error('wireKeyboardShortcuts: no document');
  const isMac = deps.isMac ?? detectMac(doc.defaultView?.navigator);
  let overlay: HelpDialog | null = null;

  const hideHelp = (): void => {
    if (!overlay) return;
    const open = overlay;
    overlay = null;
    open.hide?.();
    open.remove();
  };

  const showHelp = (): void => {
    if (overlay) return;
    ensureStyle(doc);
    const dialog = doc.createElement('slicc-dialog') as HelpDialog;
    dialog.className = 'wcsc-dialog';
    dialog.setAttribute('heading', 'Keyboard shortcuts');
    dialog.dataset.wcShortcuts = 'help';
    dialog.append(buildHelpBody(doc, shortcutRows(isMac)));
    // The dialog dismisses itself on Escape / ✕ / backdrop; drop our handle
    // so the next `?` builds a fresh one instead of toggling a dead node.
    dialog.addEventListener('slicc-dialog-close', () => {
      overlay = null;
      dialog.remove();
    });
    // On `document.body`, never inside the shell: the overlay must not
    // reflow a panel it happens to be mounted under.
    doc.body.append(dialog);
    overlay = dialog;
    dialog.show?.();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Something closer to the key already claimed it (a component's own
    // handler, an open dialog's Escape).
    if (event.defaultPrevented || event.isComposing) return;

    if (hasSwitchModifier(event, isMac)) {
      const digit = digitFor(event);
      if (digit === null) return;
      const key = unitKeyForDigit(deps.switcher.scoops, digit);
      if (key === null) return;
      // Claimed even when the user is typing: the chord produces no text, so
      // the composer has nothing to lose by it.
      event.preventDefault();
      deps.switcher.select(key);
      return;
    }

    // Bare letters below — a keystroke meant for a text field is never one.
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event)) return;

    if (event.key === '?' || event.key === '/') {
      event.preventDefault();
      // `?` toggles: a second press closes the overlay it opened.
      if (overlay) hideHelp();
      else showHelp();
      return;
    }
    if (event.key === 'c' && deps.focusComposer) {
      event.preventDefault();
      deps.focusComposer();
    }
  };

  doc.addEventListener('keydown', onKeyDown);

  return {
    dispose: () => {
      doc.removeEventListener('keydown', onKeyDown);
      hideHelp();
    },
    showHelp,
    hideHelp,
    helpOverlay: () => overlay,
  };
}
