/**
 * Modal keyboard mode for the WC shell — vim's idea, applied to a UI whose
 * primary control is a text field.
 *
 * SLICC is keyboard-heavy: the composer has focus most of the time, so any
 * unmodified single-letter shortcut would fight the thing the user is
 * actually doing, and every modified one collides with the browser (⌘+digit
 * and, off macOS, Ctrl+digit are its tab switcher). A MODE resolves both at
 * once: <kbd>Esc</kbd> leaves the text field and enters keyboard mode, and
 * inside it every binding is a bare letter.
 *
 * ## The Escape contract
 *
 * One press enters the mode and is swallowed; a second press exits it AND
 * leaves fullscreen. That is why the first press calls `preventDefault()` and
 * the second deliberately does not, and why the second also calls
 * `exitFullscreen()` explicitly: under Keyboard Lock (which this module
 * requests while the document is fullscreen — the only mechanism that can
 * hold Escape there) the browser would otherwise never see an Escape at all,
 * so the exit has to be performed rather than merely permitted.
 *
 * An Escape belonging to an open overlay is never taken: `<slicc-dialog>` and
 * `<slicc-tab-overlay>` stop propagation in the capture phase and so never
 * reach this listener at all, `<slicc-permissions>` calls `preventDefault()`,
 * and `<slicc-quick-look>` does neither — hence {@link hasOpenOverlay}, which
 * exists for that last one.
 *
 * ## Everything routes through the surface's own event
 *
 * A digit calls `switcher.select()`, a panel calls `dock.selectItem()`, the
 * rail calls `freezer.toggle()`, a new conversation dispatches the same
 * `new-chat-save` the rail's action row fires. Each is the exact event a
 * click produces, so every float's existing wiring — selection semantics,
 * queue stashing, read-only locks, sprinkle activation, tray round trips —
 * stays the single implementation, and a shortcut can never drift from what
 * the mouse does.
 *
 * ## Leaving the mode
 *
 * Navigation keys (digits, `d`, `b`, `s`, help) keep the mode: you are still
 * driving from the keyboard. Anything that hands focus to a surface (`c`,
 * Enter, `n`, `f`, `e`, `m`, `t`, `a`) leaves it. Focus entering a text field
 * by ANY route exits it too — otherwise the mode would silently eat what the
 * user types into the field they just clicked.
 */

/** The bit of `<slicc-agent-tabs>` the mode drives. */
export interface ShortcutSwitcher {
  /** Tab descriptors in rendered order; `key` is the unit's jid. */
  readonly scoops: ReadonlyArray<{ key: string; label?: string }>;
  /** The selected tab's key, used to find "the next one". */
  readonly active: string | null;
  /** Select by key — dispatches `slicc-scoop-select`, exactly like a click. */
  select(key: string): void;
}

/** The bit of `<slicc-dock>` the mode drives. */
export interface ShortcutDock {
  readonly items: ReadonlyArray<{ id: string; kind?: 'sprinkle' | 'tool' }>;
  readonly active: string | null;
  /** Select by id — dispatches `slicc-dock-select`, exactly like a click. */
  selectItem(id: string): void;
}

/** The bit of `<slicc-freezer>` the mode drives. */
export interface ShortcutFreezer extends EventTarget {
  /** Expand/collapse the left rail; emits `freezer-toggle`. */
  toggle(force?: boolean): void;
}

export interface ShortcutDeps {
  switcher: ShortcutSwitcher;
  /** The right-hand dock rail (files / terminal / memory / browser / sprinkles). */
  dock?: ShortcutDock;
  /** The left rail, toggled by `b` and the target of the new-conversation event. */
  freezer?: ShortcutFreezer;
  /** Put the caret in the composer (`c` / Enter). */
  focusComposer?: () => void;
  /** Injected for tests; defaults to the switcher's own document. */
  doc?: Document;
}

/** Actions the shell cannot reach on its own, registered by later wiring. */
export interface ShortcutActions {
  /** Open account settings (`a`) — wired by `wc-nav.ts`, leader-only. */
  accounts?: () => void;
}

export interface ShortcutHandles {
  /** Remove every listener, leave the mode, drop any open overlay. */
  dispose(): void;
  /** Open the help overlay (what `h` does). */
  showHelp(): void;
  /** Close it, if open. */
  hideHelp(): void;
  /** The mounted overlay element, or `null` when closed (for tests). */
  helpOverlay(): HTMLElement | null;
  /** Whether keyboard mode is on. */
  active(): boolean;
  /** Enter / leave keyboard mode programmatically. */
  setActive(on: boolean): void;
  /** Late-bind an action the shell itself cannot reach (see {@link ShortcutActions}). */
  setAction<K extends keyof ShortcutActions>(name: K, fn: ShortcutActions[K]): void;
}

type ModalElement = HTMLElement & { show?: () => void; hide?: () => void };

/** One documented binding: the keys, what it does, and whether it holds the mode. */
export interface ShortcutRow {
  keys: string[];
  description: string;
}

const STYLE_ID = 'slicc-shortcuts-style';
const CSS = `
slicc-dialog.wcsc-dialog::part(dialog){width:min(440px,92vw);}
.wcsc{display:flex;flex-direction:column;gap:2px;font-family:var(--ui);color:var(--ink);}
.wcsc__note{font-size:12px;color:var(--txt-3);padding:0 2px 8px;line-height:1.5;}
.wcsc__row{display:flex;align-items:center;gap:12px;padding:7px 2px;border-bottom:1px solid var(--line);}
.wcsc__row:last-child{border-bottom:0;}
.wcsc__desc{flex:1;min-width:0;font-size:12.5px;}
.wcsc__keys{display:flex;align-items:center;gap:4px;flex:0 0 auto;}
.wcsc__key{font:600 11px/1 var(--mono,ui-monospace,monospace);color:var(--txt-2);background:var(--ghost);border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;padding:4px 6px;white-space:nowrap;}
.wcsc__sep{font-size:11px;color:var(--txt-3);}
.wcsc-badge{position:fixed;left:50%;bottom:18px;z-index:90;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;pointer-events:none;font:600 11.5px/1 var(--ui);color:var(--ink);background:color-mix(in srgb,var(--canvas) 88%,transparent);border:1px solid var(--line);box-shadow:0 6px 20px -8px rgba(10,10,10,.45);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
.wcsc-badge__dot{width:7px;height:7px;border-radius:50%;background:var(--ctx,var(--waffle,#e6a03c));box-shadow:0 0 0 3px color-mix(in srgb,var(--ctx,#e6a03c) 22%,transparent);}
.wcsc-badge__hint{color:var(--txt-3);font-weight:500;}
@media (prefers-reduced-motion:no-preference){.wcsc-badge{animation:wcsc-badge-in .14s ease-out;}}
@keyframes wcsc-badge-in{from{opacity:0;transform:translateX(-50%) translateY(4px);}to{opacity:1;transform:translateX(-50%);}}
`;

/**
 * Is the event headed somewhere the user is typing? Read from
 * `composedPath()` so a `<textarea>` inside a shadow root (the composer, the
 * terminal's helper input) is seen for what it is — `event.target` would be
 * retargeted to the host element and read as "not typing".
 */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  // Duck-typed, not `instanceof HTMLElement`: an element from another realm
  // (an iframe, jsdom) fails the identity check while being exactly the thing
  // we must not steal keystrokes from.
  const el = target as Partial<HTMLElement> & { tagName?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  // `isContentEditable` is a computed property some DOM implementations
  // (jsdom) never define, and it is the only one that sees inheritance —
  // hence the walk to the nearest declaring ancestor rather than a lookup on
  // the target alone.
  const editable = (el as Partial<Element>).closest?.('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable') !== 'false';
}

/** The deepest node an event was dispatched at, piercing shadow roots. */
export function deepTarget(event: Event): EventTarget | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return (path[0] as EventTarget | undefined) ?? event.target;
}

/**
 * Is a modal surface open that owns Escape? Only `<slicc-quick-look>` really
 * needs asking — the other overlays either stop propagation before this
 * module's listener or mark the event handled — but the check is written over
 * all of them so a future overlay that forgets to do either is still
 * respected.
 */
export function hasOpenOverlay(doc: Document): boolean {
  return !!doc.querySelector(
    'slicc-quick-look, slicc-permissions, slicc-dialog[open], slicc-tab-overlay[open]'
  );
}

/** The digit 1–9 a key event names, or `null`. */
export function digitFor(event: KeyboardEvent): number | null {
  // `code` first: the physical key is the stable reading of "the 3 key"
  // across layouts and modifier states.
  const byCode = /^Digit([1-9])$/.exec(event.code ?? '');
  if (byCode) return Number(byCode[1]);
  return /^[1-9]$/.test(event.key) ? Number(event.key) : null;
}

/**
 * The unit a digit selects: `1`–`8` index the strip, `9` is always the last
 * tab (the browser-tab convention). `null` when the strip is shorter.
 */
export function unitKeyForDigit(
  scoops: ReadonlyArray<{ key: string }>,
  digit: number
): string | null {
  if (scoops.length === 0) return null;
  if (digit === 9) return scoops[scoops.length - 1].key;
  return scoops[digit - 1]?.key ?? null;
}

/**
 * The entry after `current`, wrapping — and the first entry when `current` is
 * unknown, so a cycle key always goes somewhere. `null` only for an empty list.
 */
export function nextInCycle(keys: readonly string[], current: string | null): string | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  return keys[(index + 1) % keys.length] ?? null;
}

/** Sprinkle launchers in the dock rail, in rail order. */
export function sprinkleIds(dock: ShortcutDock): string[] {
  return dock.items.filter((i) => i.kind === 'sprinkle' && i.id !== 'new').map((i) => i.id);
}

/** What a command needs to do its work. */
interface CommandContext {
  deps: ShortcutDeps;
  actions: ShortcutActions;
  toggleHelp(): void;
}

/**
 * One binding. `holdsMode` is the whole modal grammar in a boolean: a command
 * that navigates keeps keyboard mode, a command that hands focus to a surface
 * gives it up (the mode is dropped BEFORE the command runs, so a surface that
 * autofocuses is not immediately undone by it).
 */
interface Command {
  holdsMode: boolean;
  description: string;
  /** Extra keys that run the same command, for the help sheet. */
  aliases?: string[];
  run(ctx: CommandContext): void;
}

/** Open a dock surface — the same event the rail item's click emits. */
function surfaceCommand(id: string, description: string): Command {
  return { holdsMode: false, description, run: (ctx) => ctx.deps.dock?.selectItem(id) };
}

/**
 * The keyboard-mode command table. Insertion order is help order.
 *
 * Every entry reaches its surface through the surface's OWN event — the
 * strip's `select`, the dock's `selectItem`, the rail's `toggle`, the action
 * row's `new-chat-save` — so a shortcut is indistinguishable from a click and
 * cannot drift from one.
 */
const COMMANDS: Readonly<Record<string, Command>> = {
  d: {
    holdsMode: true,
    description: 'Next agent, looping',
    run: ({ deps }) => {
      const next = nextInCycle(
        deps.switcher.scoops.map((s) => s.key),
        deps.switcher.active
      );
      if (next) deps.switcher.select(next);
    },
  },
  c: {
    holdsMode: false,
    description: 'Back to the composer',
    aliases: ['Enter'],
    run: ({ deps }) => deps.focusComposer?.(),
  },
  n: {
    holdsMode: false,
    description: 'New conversation',
    // The event the rail's action row fires on a single click: save the
    // chat, extract memories, start a new one.
    run: ({ deps }) =>
      deps.freezer?.dispatchEvent(new CustomEvent('new-chat-save', { bubbles: true })),
  },
  b: {
    holdsMode: true,
    description: 'Toggle the left rail',
    run: ({ deps }) => deps.freezer?.toggle(),
  },
  f: surfaceCommand('files', 'File browser'),
  t: surfaceCommand('browser', 'Browser tabs'),
  e: surfaceCommand('term', 'Terminal'),
  m: surfaceCommand('memory', 'Memory'),
  s: {
    holdsMode: true,
    description: 'Sprinkles, looping',
    run: ({ deps }) => {
      const dock = deps.dock;
      if (!dock) return;
      const ids = sprinkleIds(dock);
      // With no sprinkles installed, the `new` launcher is what the rail's
      // only sprinkle affordance would open.
      if (ids.length === 0) {
        dock.selectItem('new');
        return;
      }
      const next = nextInCycle(ids, dock.active);
      if (next) dock.selectItem(next);
    },
  },
  a: {
    holdsMode: false,
    description: 'Accounts',
    run: ({ actions }) => actions.accounts?.(),
  },
  h: {
    holdsMode: true,
    description: 'This help',
    aliases: ['?', '/'],
    run: (ctx) => ctx.toggleHelp(),
  },
};

/** Key → command, aliases folded in. */
const COMMAND_FOR_KEY: ReadonlyMap<string, Command> = new Map(
  Object.entries(COMMANDS).flatMap(([key, command]) => [
    [key, command] as const,
    ...(command.aliases ?? []).map((alias) => [alias, command] as const),
  ])
);

/** The documented bindings, in help order. */
export function shortcutRows(): ShortcutRow[] {
  return [
    {
      keys: ['Esc'],
      description: 'Enter keyboard mode — press again to leave (and exit full screen)',
    },
    { keys: ['1 – 9'], description: 'Switch to that agent in the tab strip (9 = last)' },
    ...Object.entries(COMMANDS).map(([key, command]) => ({
      keys: [
        key === 'Enter' ? '⏎' : key,
        ...(command.aliases ?? []).map((a) => (a === 'Enter' ? '⏎' : a)),
      ],
      description: command.description,
    })),
  ];
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement)?.append(style);
}

/** The overlay body: a lead line, then one row per binding. */
function buildHelpBody(doc: Document, rows: readonly ShortcutRow[]): HTMLElement {
  const list = doc.createElement('div');
  list.className = 'wcsc';
  const note = doc.createElement('div');
  note.className = 'wcsc__note';
  note.textContent =
    'These keys work while keyboard mode is on. Press Esc from anywhere to enter it — ' +
    'outside it, typing is never intercepted.';
  list.append(note);
  for (const row of rows) {
    const line = doc.createElement('div');
    line.className = 'wcsc__row';
    const desc = doc.createElement('div');
    desc.className = 'wcsc__desc';
    desc.textContent = row.description;
    const keys = doc.createElement('div');
    keys.className = 'wcsc__keys';
    for (const key of row.keys) {
      const kbd = doc.createElement('kbd');
      kbd.className = 'wcsc__key';
      kbd.textContent = key;
      keys.append(kbd);
    }
    line.append(desc, keys);
    list.append(line);
  }
  return list;
}

/** The mode indicator: a non-interactive pill pinned above the composer. */
function buildBadge(doc: Document): HTMLElement {
  const badge = doc.createElement('div');
  badge.className = 'wcsc-badge';
  badge.dataset.wcShortcuts = 'badge';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  const dot = doc.createElement('span');
  dot.className = 'wcsc-badge__dot';
  const label = doc.createElement('span');
  label.textContent = 'Keyboard mode';
  const hint = doc.createElement('span');
  hint.className = 'wcsc-badge__hint';
  hint.textContent = 'h for help · Esc to leave';
  badge.append(dot, label, hint);
  return badge;
}

/** The help overlay's lifecycle, kept apart from the mode's. */
function createHelp(doc: Document): {
  show(): void;
  hide(): void;
  toggle(): void;
  element(): HTMLElement | null;
} {
  let overlay: ModalElement | null = null;
  const hide = (): void => {
    if (!overlay) return;
    const open = overlay;
    overlay = null;
    open.hide?.();
    open.remove();
  };
  const show = (): void => {
    if (overlay) return;
    ensureStyle(doc);
    const dialog = doc.createElement('slicc-dialog') as ModalElement;
    dialog.className = 'wcsc-dialog';
    dialog.setAttribute('heading', 'Keyboard mode');
    dialog.dataset.wcShortcuts = 'help';
    dialog.append(buildHelpBody(doc, shortcutRows()));
    // The dialog dismisses itself on Escape / ✕ / backdrop; drop our handle
    // so the next `h` builds a fresh one instead of toggling a dead node.
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
  return {
    show,
    hide,
    toggle: () => (overlay ? hide() : show()),
    element: () => overlay,
  };
}

/**
 * Hold Escape while the document is fullscreen. Keyboard Lock is the only API
 * that stops the browser from spending Escape on leaving fullscreen, which is
 * what makes the two-press contract hold there too. Chromium-only and
 * permission-gated: where it is unavailable the first press still enters the
 * mode, it just also drops out of fullscreen.
 */
function syncKeyboardLock(doc: Document): void {
  const keyboard = (
    doc.defaultView?.navigator as Navigator & {
      keyboard?: { lock(keys: string[]): Promise<void>; unlock(): void };
    }
  )?.keyboard;
  if (!keyboard) return;
  if (doc.fullscreenElement) void keyboard.lock(['Escape']).catch(() => undefined);
  else keyboard.unlock();
}

/** The mode flag plus the badge that makes it visible. */
function createMode(doc: Document): { on(): boolean; set(next: boolean): void } {
  let modeOn = false;
  let badge: HTMLElement | null = null;
  return {
    on: () => modeOn,
    set: (next: boolean) => {
      if (next === modeOn) return;
      modeOn = next;
      doc.documentElement.toggleAttribute('data-slicc-keyboard-mode', next);
      if (!next) {
        badge?.remove();
        badge = null;
        return;
      }
      ensureStyle(doc);
      badge = buildBadge(doc);
      doc.body.append(badge);
      // The caret would otherwise keep blinking in a composer that no longer
      // receives what is typed.
      const focused = doc.activeElement as HTMLElement | null;
      if (isTypingTarget(focused)) focused?.blur();
    },
  };
}

/**
 * Install the shell's modal key handling. Safe on any float: only the
 * switcher is required, and every other surface degrades to a no-op binding.
 */
export function wireKeyboardShortcuts(deps: ShortcutDeps): ShortcutHandles {
  const doc = deps.doc ?? (deps.switcher as unknown as { ownerDocument?: Document })?.ownerDocument;
  if (!doc) throw new Error('wireKeyboardShortcuts: no document');
  const actions: ShortcutActions = {};
  const help = createHelp(doc);
  const mode = createMode(doc);
  const ctx: CommandContext = { deps, actions, toggleHelp: help.toggle };

  /** The Escape contract; see the module header. */
  const handleEscape = (event: KeyboardEvent): void => {
    // An open overlay owns its own Escape; entering the mode underneath it
    // would leave the user pressing Escape twice for one dismissal.
    if (hasOpenOverlay(doc)) return;
    if (!mode.on()) {
      // Swallowed on purpose: one press means "leave the text field", not
      // "leave fullscreen".
      event.preventDefault();
      mode.set(true);
      return;
    }
    mode.set(false);
    // The second press is the one that means fullscreen. Performed rather
    // than merely allowed, because under Keyboard Lock the browser never acts
    // on Escape itself.
    if (doc.fullscreenElement) void doc.exitFullscreen?.().catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Something closer to the key already claimed it (a component's own
    // handler, an overlay's Escape).
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      handleEscape(event);
      return;
    }
    if (!mode.on()) return;
    // A chord in keyboard mode belongs to the browser or the OS (⌘C, Ctrl+R).
    // Shift passes through, for `?`.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Focus can still land in a text field while the mode is on (a surface
    // that autofocuses, a click `focusin` has not processed yet). This is the
    // belt to that suspenders.
    if (isTypingTarget(deepTarget(event))) return;

    const digit = digitFor(event);
    if (digit !== null) {
      const key = unitKeyForDigit(deps.switcher.scoops, digit);
      if (key === null) return;
      event.preventDefault();
      deps.switcher.select(key);
      return;
    }

    const command = COMMAND_FOR_KEY.get(event.key);
    // An unbound key is not an exit: the mode is sticky, like vim's.
    if (!command) return;
    event.preventDefault();
    // Dropped BEFORE the command runs, so a surface that takes focus is not
    // immediately fighting a mode that is still on.
    if (!command.holdsMode) mode.set(false);
    command.run(ctx);
  };

  /**
   * Focus reaching a text field ends the mode. Without this, clicking into
   * the composer while the mode is on would leave every keystroke being read
   * as a command instead of as text.
   */
  const onFocusIn = (event: FocusEvent): void => {
    if (mode.on() && isTypingTarget(deepTarget(event))) mode.set(false);
  };
  const onFullscreenChange = (): void => syncKeyboardLock(doc);

  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  syncKeyboardLock(doc);

  return {
    dispose: () => {
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      mode.set(false);
      help.hide();
    },
    showHelp: help.show,
    hideHelp: help.hide,
    helpOverlay: help.element,
    active: mode.on,
    setActive: mode.set,
    setAction: (name, fn) => {
      actions[name] = fn;
    },
  };
}
