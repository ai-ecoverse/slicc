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
 * ## The mode is the resting state
 *
 * Keyboard mode is not a place you visit, it is where you are whenever you
 * are not typing: {@link settle} turns it on the moment no text field holds
 * the focus, and off the moment one does. Escape is therefore a shortcut for
 * "leave the field", not a toggle, and `i` / Enter — which put the caret back
 * in the composer — are the only way out. That is vim's grammar rather than a
 * pair of modes with a switch between them, and it means the answer to "will
 * this letter type or command?" is always visible: the caret is in the
 * composer, or the badge is up.
 *
 * ## The Escape contract
 *
 * The first press leaves the composer and is swallowed — one press means
 * "leave the text field", not "leave fullscreen". A press made INSIDE the
 * mode has no mode left to leave, so it is spent on fullscreen instead, and
 * spent explicitly: under Keyboard Lock (which this module requests while the
 * document is fullscreen — the only mechanism that can hold Escape there) the
 * browser never sees an Escape at all, so the exit has to be performed rather
 * than merely permitted.
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
 * ## Chords
 *
 * Every surface that owns an ORDERED list — the file tree, the memory panel,
 * the archived chats, the sprinkle launchers — extends the digits onto it:
 * `f` opens the files panel and `f 3` opens its third row, on the same
 * "9 is always the last one" rule the tab strip already uses
 * ({@link itemForDigit}). The prefix runs EAGERLY, so the single-key path
 * pays nothing for the chord's existence, and the lookahead is one key wide,
 * so a digit is never ambiguous: armed, it addresses the list; otherwise the
 * strip. A chord belongs to the {@link Command}, not to the key that ran it —
 * rebinding `files` to `q` in `keys.json` moves `q 1-9` with it.
 *
 * ## Leaving the mode
 *
 * Navigation keys (digits, the two cycles, the rails, `z`, `s`, help) keep
 * the mode: you are still driving from the keyboard. Anything that hands
 * focus to a surface (`i`, Enter, `n`, `f`, `t`, `m`, `u`) drops it BEFORE running, so a surface
 * that autofocuses is not immediately undone by the mode — but the drop only
 * sticks if something typable actually took the focus, because `settle` runs
 * after and asks the DOM rather than the command table. Focus entering a text
 * field by ANY route leaves the mode too, otherwise it would silently eat
 * what the user types into the field they just clicked.
 *
 * ## Switching units carries the mode with you
 *
 * The mode you were in when you left a unit is the mode you land back in
 * ({@link ShortcutHandles} tracks it as an INTENT, updated only while a
 * composer is actually available). A cone→cone switch is the easy half: the
 * caret returns to the composer, or the badge stays up. The hard half is the
 * detour through a scoop, whose transcript is read-only and has no composer
 * at all (#2312): the forced keyboard mode there is not a choice the user
 * made, so it must not overwrite the intent — otherwise cone → scoop → cone
 * would swallow the caret the user left behind.
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
  /** Close the active item's panel — what clicking the ACTIVE item does. */
  collapse(): void;
}

/** The bit of `<slicc-composer-meta>` the mode drives. */
export interface ShortcutComposerMeta {
  /** Empty exactly when no account is connected — the pill's "Add AI" state. */
  readonly models: readonly unknown[];
  /** Open the model dropdown, as clicking the pill does. */
  openMenu(): void;
}

/** The bit of `<slicc-freezer>` the mode drives. */
export interface ShortcutFreezer extends EventTarget {
  /** Expand/collapse the left rail; emits `freezer-toggle`. */
  toggle(force?: boolean): void;
}

/**
 * An ordered, addressable list a chord's digit indexes into — the file tree's
 * rows, the freezer's archived chats, the memory panel's entries.
 *
 * Read at the moment the digit lands, never awaited: a panel that is still
 * mounting reports an empty list, the press shows dimmed on the HUD, and
 * nothing happens. A chord that waited would be a chord that sometimes fires
 * half a second after the user gave up on it.
 */
export interface ShortcutList {
  /** How many items the surface is showing right now. */
  size(): number;
  /** Activate the nth (0-based) — the same event a click on that row fires. */
  selectAt(index: number): void;
}

/** The lists a `<surface> <digit>` chord can address. See {@link ShortcutList}. */
export interface ShortcutLists {
  files?: ShortcutList;
  memory?: ShortcutList;
  sessions?: ShortcutList;
}

export interface ShortcutDeps {
  switcher: ShortcutSwitcher;
  /** The right-hand dock rail (files / terminal / memory / browser / sprinkles). */
  dock?: ShortcutDock;
  /** The left rail, toggled by `[` and the target of the new-conversation event. */
  freezer?: ShortcutFreezer;
  /** The model pill; `openMenu()` is its own programmatic click. */
  composerMeta?: ShortcutComposerMeta;
  /** Put the caret in the composer (`i` / Enter). */
  focusComposer?: () => void;
  /**
   * Stop the running turn (`s`) — the send button's own `stop` event, so the
   * guard that ignores it when nothing is running stays in one place.
   */
  stopTurn?: () => void;
  /** Focus the oldest unanswered approval in the transcript (`a`); again = next. */
  focusApproval?: () => void;
  /** Open the composer's add menu (`u`) — the `+` button's own `open()`. */
  openAttachMenu?: () => void;
  /** The copy row's two gestures (`y` / `Y`): last reply, whole chat. */
  copyReply?: () => void;
  copyChat?: () => void;
  /** Fullscreen the active workbench surface (`z`) — the dock's long-press. */
  zoomSurface?: () => void;
  /**
   * Open the tab switcher with PEEK armed (`p`), so the digit that follows
   * shows a tab and comes back instead of switching to it for good.
   */
  peekTabs?: () => void;
  /**
   * Start / stop-and-send a hands-free dictation turn (`v`) — the composer's
   * own push-to-talk lifecycle, which otherwise only a held pointer can reach.
   */
  toggleVoice?: () => void;
  /** Scroll the transcript to the next (`+1`) or previous (`-1`) message. */
  scrollMessage?: (delta: 1 | -1) => void;
  /** Ordered lists the digit chords address; each one is optional. */
  lists?: ShortcutLists;
  /**
   * Can the selected unit be typed at? False for a scoop, whose composer band
   * is hidden (#2312), and for a disconnected follower, whose input card is
   * disabled. The mode reads it for two decisions: whether a unit switch may
   * hand the caret back, and whether the mode it finds itself in was the
   * user's choice or merely the absence of anywhere to type. Defaults to
   * "wherever a composer can be focused at all".
   */
  composerAvailable?: () => boolean;
  /** Injected for tests; defaults to the switcher's own document. */
  doc?: Document;
}

/** Actions the shell cannot reach on its own, registered by later wiring. */
export interface ShortcutActions {
  /** Open account settings (`,`) — wired by `wc-nav.ts`, leader-only. */
  accounts?: () => void;
}

export interface ShortcutHandles {
  /** Remove every listener, leave the mode, drop any open overlay. */
  dispose(): void;
  /** Open the help overlay (what `?` does). */
  showHelp(): void;
  /** Close it, if open. */
  hideHelp(): void;
  /** The mounted overlay element, or `null` when closed (for tests). */
  helpOverlay(): HTMLElement | null;
  /** Whether keyboard mode is on. */
  active(): boolean;
  /**
   * The mode the next unit switch restores — the last one chosen where a
   * composer was actually available. Exposed for tests; nothing wires it.
   */
  intent(): ModeIntent;
  /** Enter / leave keyboard mode programmatically. */
  setActive(on: boolean): void;
  /** Late-bind an action the shell itself cannot reach (see {@link ShortcutActions}). */
  setAction<K extends keyof ShortcutActions>(name: K, fn: ShortcutActions[K]): void;
  /**
   * Replace the key → command mapping (what `/etc/slicc/keys.json` does).
   * Applied whole, not merged: the config loader owns merging over
   * {@link DEFAULT_KEYMAP}, so what arrives here is the final answer.
   */
  setKeymap(keymap: Readonly<Record<string, CommandId>>): void;
  /** The mapping in force, for the help sheet and for tests. */
  keymap(): Readonly<Record<string, CommandId>>;
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
.wcsc-badge__hint[hidden]{display:none;}
.wcsc-badge__keys{display:none;align-items:center;gap:5px;}
.wcsc-badge__keys:not(:empty){display:flex;}
.wcsc-badge__press{display:flex;align-items:center;gap:2px;}
.wcsc-badge__cap{min-width:20px;padding:3px 6px;border-radius:5px;text-align:center;font:600 12px/1 var(--mono,ui-monospace,monospace);color:var(--ink);background:var(--ghost);border:1px solid var(--line);border-bottom-width:2px;}
.wcsc-badge__press[data-bound='false'] .wcsc-badge__cap{color:var(--txt-3);opacity:.55;border-bottom-width:1px;}
.wcsc-badge__press[data-age='stale'] .wcsc-badge__cap{opacity:.4;}
.wcsc-badge__press[data-age='stale'][data-bound='false'] .wcsc-badge__cap{opacity:.25;}
@media (prefers-reduced-motion:no-preference){.wcsc-badge__press{animation:wcsc-press-in .12s ease-out;}}
@keyframes wcsc-press-in{from{opacity:0;transform:translateY(2px) scale(.94);}to{opacity:1;transform:none;}}
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
 * What actually has the focus, piercing shadow roots — `doc.activeElement`
 * stops at the host of a shadow tree, so the composer's `<textarea>` would
 * otherwise read as `<slicc-input-card>` and, being a custom element rather
 * than a field, as "nobody is typing".
 */
export function deepActiveElement(doc: Document): Element | null {
  let element: Element | null = doc.activeElement;
  // A shadow root reports its own active element; a nested one reports its
  // own again, so this is a walk rather than a single hop.
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/**
 * Is the focus on something a bare key ACTIVATES rather than types into?
 *
 * Only Enter (and Space, for a keymap that binds it) is at stake, and only
 * because the mode is now the resting state: a tabbed-to button would
 * otherwise never fire, because `composer` would swallow the Enter meant for
 * it. Duck-typed for the same cross-realm reason as {@link isTypingTarget}.
 */
export function isActivationTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as Partial<Element> & { tagName?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'OPTION') return true;
  if (tag === 'A' && el.hasAttribute?.('href') === true) return true;
  const role = el.getAttribute?.('role') ?? '';
  return [
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'tab',
    'switch',
    'checkbox',
    'radio',
  ].includes(role);
}

/**
 * Is a modal surface open that owns Escape? Only `<slicc-quick-look>` really
 * needs asking — the other overlays either stop propagation before this
 * module's listener (`<slicc-dialog>`, `<slicc-tab-overlay>`) or mark the
 * event handled (`<slicc-permissions>`) — but the check is written over all of
 * them so a future overlay that forgets to do either is still respected.
 *
 * Every selector here MUST test open-ness, not mere presence: the shell mounts
 * `<slicc-permissions>` and `<slicc-tab-overlay>` once at boot and leaves them
 * in the DOM for the session, so a bare tag selector matches forever and eats
 * every Escape. Quick Look is the exception that has no open state to test —
 * it is created when it opens and removed when it closes.
 */
export function hasOpenOverlay(doc: Document): boolean {
  return !!doc.querySelector(
    'slicc-quick-look, slicc-dialog[open], slicc-tab-overlay[open], .slicc-permissions__prompt[data-open]'
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
 * The item a digit selects: `1`–`8` index the list, `9` is always the LAST
 * one (the browser-tab convention). `null` when the list is shorter.
 *
 * One rule for every list in the UI — the tab strip, the file tree, the
 * archived chats — so `9` never has to be re-learned per surface.
 */
export function indexForDigit(size: number, digit: number): number | null {
  if (size <= 0) return null;
  const index = digit === 9 ? size - 1 : digit - 1;
  return index < size ? index : null;
}

/** {@link indexForDigit}, resolved against a list of keys. */
export function itemForDigit(keys: readonly string[], digit: number): string | null {
  const index = indexForDigit(keys.length, digit);
  return index === null ? null : (keys[index] ?? null);
}

/** {@link itemForDigit} over the tab strip's descriptors. */
export function unitKeyForDigit(
  scoops: ReadonlyArray<{ key: string }>,
  digit: number
): string | null {
  return itemForDigit(
    scoops.map((s) => s.key),
    digit
  );
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

/**
 * The entry BEFORE `current`, wrapping — and the last entry when `current` is
 * unknown, so the two cycle keys are mirror images: pressing one and then the
 * other always lands back where it started, including from "nothing selected".
 */
export function prevInCycle(keys: readonly string[], current: string | null): string | null {
  if (keys.length === 0) return null;
  const found = current === null ? -1 : keys.indexOf(current);
  // An unknown selection reads as "before the first", so stepping back from it
  // lands on the last — the mirror of {@link nextInCycle} landing on the first.
  const index = found === -1 ? 0 : found;
  return keys[(index - 1 + keys.length) % keys.length] ?? null;
}

/** Sprinkle launchers in the dock rail, in rail order. */
export function sprinkleIds(dock: ShortcutDock): string[] {
  return dock.items.filter((i) => i.kind === 'sprinkle').map((i) => i.id);
}

/** What a command needs to do its work. */
interface CommandContext {
  deps: ShortcutDeps;
  actions: ShortcutActions;
  state: ModeState;
  toggleHelp(): void;
  /**
   * The chord armed when this key landed, if any — what makes the step keys
   * dual-purpose. Passed in rather than read live, because the handler has
   * already disarmed by the time a command runs: a chord survives a key only
   * by being re-armed, and only the keys that used it do that.
   */
  armed: ArmedChord | null;
}

/** A live chord: the list it addresses, and where in it the user is standing. */
export interface ArmedChord {
  list: ChordListId;
  /** The index last activated, or `null` before anything has been. */
  index: number | null;
}

/**
 * The mode the user last CHOSE — restored on the other side of a unit switch.
 *
 * Recorded only while a composer was available, which is the whole subtlety:
 * a scoop has no composer (#2312), so the keyboard mode its transcript forces
 * is not a choice and must not overwrite what the cone the user came from
 * left behind.
 */
export type ModeIntent = 'composer' | 'keyboard';

/** Mutable per-wiring state a command may read or advance. */
interface ModeState {
  /** The dock surface `rightRail` reopens after it has closed one. */
  lastDockSurface: string;
}

/**
 * One binding. `holdsMode` is the whole modal grammar in a boolean: a command
 * that navigates — or that toggles chrome, like the two rails — keeps keyboard
 * mode; a command that hands focus to a surface gives it up (the mode is
 * dropped BEFORE the command runs, so a surface that autofocuses is not
 * immediately undone by it).
 */
interface Command {
  holdsMode: boolean;
  description: string;
  /**
   * The list a digit pressed straight after this command addresses. Declared
   * on the COMMAND rather than on the key, so a user who rebinds `files` to
   * `q` gets `q 1-9` for free and a config can never fall out of step with
   * the chords.
   */
  list?: ChordListId;
  /**
   * Runs the command, and MAY report the index it activated in its list — the
   * seed the step keys page on from, so `p` (which opens the first sprinkle)
   * is followed by `j` for the second rather than for the first again.
   */
  run(ctx: CommandContext): number | void;
}

/** The lists a `<command> <digit>` chord can index. */
export type ChordListId = 'files' | 'memory' | 'sessions' | 'sprinkles';

/**
 * Resolve a chord list against the wiring. Sprinkles come from the dock rail
 * (the launchers ARE the list); the rest are supplied by the shell, because
 * this module has no business knowing what a file row or a frozen chat is.
 */
export function chordList(id: ChordListId, deps: ShortcutDeps): ShortcutList | null {
  if (id !== 'sprinkles') return deps.lists?.[id] ?? null;
  const dock = deps.dock;
  if (!dock) return null;
  return {
    size: () => sprinkleIds(dock).length,
    // Re-read the rail rather than closing over the ids: a sprinkle can
    // install (or a follower's feature gate can hide one) between the two
    // halves of a chord.
    selectAt: (index) => {
      const id = sprinkleIds(dock)[index];
      if (id) dock.selectItem(id);
    },
  };
}

/**
 * What a command IS, independent of the key that runs it. The keymap maps keys
 * onto these ids, which is what makes `/etc/slicc/keys.json` possible: a user
 * rebinds `t` to `terminal` without knowing anything about the code, and a
 * default key can change without invalidating a config.
 */
export type CommandId =
  | 'nextAgent'
  | 'prevAgent'
  | 'composer'
  | 'newConversation'
  | 'newConversationErase'
  | 'newCone'
  | 'dropCone'
  | 'sessions'
  | 'stop'
  | 'approvals'
  | 'attach'
  | 'copyReply'
  | 'copyChat'
  | 'voice'
  | 'nextItem'
  | 'prevItem'
  | 'leftRail'
  | 'rightRail'
  | 'files'
  | 'tabs'
  | 'peek'
  | 'terminal'
  | 'memory'
  | 'monitor'
  | 'sprinkles'
  | 'zoom'
  | 'model'
  | 'accounts'
  | 'help';

/**
 * Go to a dock surface — the same event the rail item's click emits.
 *
 * A surface that owns a list KEEPS the mode, and not as a nicety: the digit
 * that completes its chord has to find the mode still on. Dropping it would
 * mean the second half of `f 3` was only heard once the deferred `settle` had
 * put the mode back — that is, one macrotask later, or never if the user was
 * quick. The prediction the flag encodes is wrong for these two anyway: the
 * files and memory panels focus nothing at all.
 */
function surfaceCommand(id: string, description: string, list?: ChordListId): Command {
  return {
    holdsMode: !!list,
    description,
    ...(list ? { list } : {}),
    run: ({ deps, state }) => {
      state.lastDockSurface = id;
      deps.dock?.selectItem(id);
    },
  };
}

/**
 * Fire one of the freezer rail's own action events — what the action row's
 * buttons (and, collapsed, the badge's press gestures) dispatch. The rail is
 * the listener for all of them, so a shortcut and a click are the same call.
 */
function freezerCommand(type: string, description: string): Command {
  return {
    holdsMode: false,
    description,
    run: ({ deps }) => {
      deps.freezer?.dispatchEvent(new CustomEvent(type, { bubbles: true }));
    },
  };
}

/**
 * The keyboard-mode command table. Insertion order is help order.
 *
 * Every entry reaches its surface through the surface's OWN event — the
 * strip's `select`, the dock's `selectItem`/`collapse`, the rail's `toggle`,
 * the action row's `new-chat-save`, the model pill's `openMenu` — so a
 * shortcut is indistinguishable from a click and cannot drift from one.
 */
const COMMANDS: Readonly<Record<CommandId, Command>> = {
  nextAgent: {
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
  prevAgent: {
    holdsMode: true,
    description: 'Previous agent, looping',
    run: ({ deps }) => {
      const prev = prevInCycle(
        deps.switcher.scoops.map((s) => s.key),
        deps.switcher.active
      );
      if (prev) deps.switcher.select(prev);
    },
  },
  composer: {
    holdsMode: false,
    description: 'Back to the composer',
    run: ({ deps }) => deps.focusComposer?.(),
  },
  stop: {
    // Stopping keeps you where you are: the turn ends, the keyboard stays.
    holdsMode: true,
    description: 'Stop the running turn',
    run: ({ deps }) => deps.stopTurn?.(),
  },
  approvals: {
    /**
     * Focus, never answer. A key that said yes could say it to a prompt that
     * scrolled into view a frame earlier — so this only puts the caret on the
     * request's own button, where Enter means what it says (a focused button
     * keeps its Enter; see {@link isActivationTarget}).
     */
    holdsMode: true,
    description: 'Go to the pending approval',
    run: ({ deps }) => deps.focusApproval?.(),
  },
  attach: {
    // The menu opens with its search field ready, so the mode is leaving.
    holdsMode: false,
    description: 'Attach a file or skill',
    run: ({ deps }) => deps.openAttachMenu?.(),
  },
  copyReply: {
    holdsMode: true,
    description: 'Copy the last reply',
    run: ({ deps }) => deps.copyReply?.(),
  },
  copyChat: {
    holdsMode: true,
    description: 'Copy the whole chat',
    run: ({ deps }) => deps.copyChat?.(),
  },
  voice: {
    /**
     * Tap to start, tap again to send. The composer's push-to-talk is a
     * press-and-HOLD gesture, which a keyboard cannot express at all — so
     * this is the one command whose surface had to grow an entry point
     * (`toggleHandsFree`) rather than being handed one it already had.
     *
     * Holds the mode, because the key that ends the turn is this same key.
     */
    holdsMode: true,
    description: 'Dictate — again to send',
    run: ({ deps }) => deps.toggleVoice?.(),
  },
  nextItem: {
    holdsMode: true,
    description: 'Next message — or, after a list key, the next entry',
    run: (ctx) => stepList(ctx, 1),
  },
  prevItem: {
    holdsMode: true,
    description: 'Previous message — or the previous entry',
    run: (ctx) => stepList(ctx, -1),
  },
  newConversation: {
    holdsMode: false,
    description: 'New conversation',
    // The event the rail's action row fires on a single click: save the
    // chat, extract memories, start a new one.
    run: ({ deps }) => {
      deps.freezer?.dispatchEvent(new CustomEvent('new-chat-save', { bubbles: true }));
    },
  },
  newConversationErase: freezerCommand('new-chat-erase', 'New conversation, erasing this one'),
  newCone: freezerCommand('new-cone', 'New cone'),
  dropCone: freezerCommand('drop-cone', 'Drop this cone'),
  sessions: {
    holdsMode: true,
    description: 'Archived chats (with 1-9 / j / k: restore that one)',
    list: 'sessions',
    // Force the rail OPEN rather than toggling it: this is the one key whose
    // point is to look at the list, and a toggle would hide it half the time.
    run: ({ deps }) => deps.freezer?.toggle(true),
  },
  leftRail: {
    holdsMode: true,
    description: 'Toggle the left rail',
    run: ({ deps }) => deps.freezer?.toggle(),
  },
  rightRail: {
    holdsMode: true,
    description: 'Toggle the right panel',
    /**
     * The dock's own toggle: clicking the ACTIVE rail item collapses its
     * panel, and clicking it again reopens it. So this closes whatever is
     * open — remembering it — and otherwise reopens the last one, falling
     * back to Files on a shell that has never opened anything.
     */
    run: ({ deps, state }) => {
      const dock = deps.dock;
      if (!dock) return;
      if (dock.active) {
        state.lastDockSurface = dock.active;
        dock.collapse();
        return;
      }
      dock.selectItem(state.lastDockSurface);
    },
  },
  files: surfaceCommand('files', 'File browser (with 1-9 / j / k: open that row)', 'files'),
  tabs: surfaceCommand('browser', 'Browser tabs (then 1-9 to switch)'),
  peek: {
    /**
     * The switcher, with peek armed: the digit that follows shows that tab and
     * brings you back.
     *
     * `p` means the same thing here as it does inside the switcher, which is
     * the whole reason it moved: a key that meant peek in a modal and
     * something else outside it was a wart, and typing `p 1` without first
     * opening the switcher is the thing people actually want to do.
     *
     * The digit is not a chord — it never reaches this module. Opening the
     * switcher makes it modal, which suspends every shell command, and the
     * overlay's own keyboard takes the digit from there (holding it until its
     * asynchronous tab list lands). So `p 1` works as one gesture without the
     * shell knowing anything about tabs.
     */
    holdsMode: true,
    description: 'Peek a tab (then 1-9: show it and come back)',
    run: ({ deps }) => deps.peekTabs?.(),
  },
  terminal: surfaceCommand('term', 'Terminal'),
  memory: surfaceCommand('memory', 'Memory (with 1-9 / j / k: open that entry)', 'memory'),
  monitor: surfaceCommand('monitor', 'Monitor'),
  sprinkles: {
    /**
     * The FIRST sprinkle, not the next one. A chord prefix has to be
     * idempotent — `p 3` must open the third whatever came before it — and
     * cycling is now what the step keys are for: `p` then `j` walks the rest,
     * which is why there is no separate loop key any more.
     *
     * Holds the mode for the same reason every list command does: the key
     * that completes the chord has to arrive with the keyboard still live.
     */
    holdsMode: true,
    description: 'Sprinkles (with 1-9 / j / k: open that one)',
    list: 'sprinkles',
    run: ({ deps, state }) => {
      const dock = deps.dock;
      if (!dock) return;
      const ids = sprinkleIds(dock);
      // With no sprinkles installed there is nothing to open — sprinkles are
      // authored by the agent, not launched from an empty rail affordance.
      if (ids.length === 0) return;
      state.lastDockSurface = ids[0];
      dock.selectItem(ids[0]);
      // Seeded at the first, so the next step key goes to the SECOND.
      return 0;
    },
  },
  zoom: {
    holdsMode: true,
    description: 'Full screen the open panel',
    /**
     * Runs synchronously inside the keydown on purpose: `requestFullscreen()`
     * needs transient user activation, and the keystroke IS the activation
     * only for as long as the handler is on the stack.
     */
    run: ({ deps }) => deps.zoomSurface?.(),
  },
  model: {
    holdsMode: false,
    description: 'Model picker',
    /**
     * `openMenu()` is the pill's own programmatic click — and, exactly like a
     * click, it has nothing to offer with no accounts connected (the pill
     * reads "Add AI" and emits `add-ai` instead). Route that case to accounts,
     * which is where the click would have taken the user too.
     */
    run: ({ deps, actions }) => {
      const meta = deps.composerMeta;
      if (!meta) return;
      if (meta.models.length === 0) {
        actions.accounts?.();
        return;
      }
      meta.openMenu();
    },
  },
  accounts: {
    holdsMode: false,
    description: 'Accounts',
    run: ({ actions }) => actions.accounts?.(),
  },
  help: {
    holdsMode: true,
    description: 'This help',
    run: (ctx) => ctx.toggleHelp(),
  },
};

/** Every command id, for validating a user keymap. */
export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

/** Is `value` a command a keymap may point at? */
export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && Object.hasOwn(COMMANDS, value);
}

/**
 * Keys the keymap may not touch, because they are the mode itself rather than
 * a command: Escape enters and leaves it, and the digits address the tab strip
 * positionally (`9` is "the last one", not "the ninth command").
 */
export const RESERVED_KEYS: readonly string[] = [
  'Escape',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
];

/**
 * The shipped key → command mapping, which `/etc/slicc/keys.json` overrides.
 *
 * ## How the keys were chosen
 *
 * - **Prime keys go to urgency, not to nouns.** Stopping a runaway turn and
 *   answering an approval are time-critical; opening account settings is not,
 *   which is why `a` answers and settings moved to `,`.
 * - **Positional beats mnemonic wherever a list exists.** The digits already
 *   address the tab strip; a command with a {@link Command.list} extends that
 *   to its own rows rather than growing a verb.
 * - **The same key closes what it opened**, because clicking the active dock
 *   item collapses it and a shortcut must not need its own vocabulary.
 * - **Shift is the heavier twin of the same letter** (`n`/`N`, `c`/`C`,
 *   `y`/`Y`, `p`/`P`), so a destructive variant is never a key of its own.
 *
 * Deliberately left free: `e h j k o q v w x . ; [] pairs aside` and, above
 * all, `/` — the obvious key for a command palette, and not worth spending on
 * a third synonym for `?`.
 */
export const DEFAULT_KEYMAP: Readonly<Record<string, CommandId>> = {
  // Anchors
  i: 'composer',
  Enter: 'composer',
  '?': 'help',
  // Units
  ArrowRight: 'nextAgent',
  ArrowLeft: 'prevAgent',
  n: 'newConversation',
  N: 'newConversationErase',
  c: 'newCone',
  C: 'dropCone',
  r: 'sessions',
  // The turn
  s: 'stop',
  a: 'approvals',
  u: 'attach',
  y: 'copyReply',
  Y: 'copyChat',
  v: 'voice',
  j: 'nextItem',
  k: 'prevItem',
  // Panels
  f: 'files',
  t: 'terminal',
  b: 'tabs',
  m: 'memory',
  g: 'monitor',
  e: 'sprinkles',
  p: 'peek',
  '[': 'leftRail',
  ']': 'rightRail',
  z: 'zoom',
  // Rare
  l: 'model',
  ',': 'accounts',
};

/**
 * The v1 keymap, shipped through 6.110 and seeded verbatim into every
 * `/etc/slicc/keys.json` written before v2 — which is exactly why it is still
 * here: `wc-shortcut-config.ts` recognises a file that still holds it as one
 * nobody has edited, and only then replaces it. Every command id it names
 * still exists, so a user who pastes it back gets their v1 keyboard whole.
 */
export const V1_KEYMAP: Readonly<Record<string, CommandId>> = {
  d: 'nextAgent',
  c: 'composer',
  Enter: 'composer',
  n: 'newConversation',
  b: 'leftRail',
  x: 'rightRail',
  f: 'files',
  t: 'tabs',
  e: 'terminal',
  m: 'memory',
  s: 'sprinkles',
  l: 'model',
  a: 'accounts',
  h: 'help',
  '?': 'help',
  '/': 'help',
};

/**
 * How a key prints in the help sheet — the same caps the HUD draws
 * ({@link KEY_CAPS}), so the overlay and the pill never name one key two ways.
 */
function keyLabel(key: string): string {
  return KEY_CAPS[key] ?? key;
}

/**
 * The documented bindings for a keymap, in command order. Derived rather than
 * written out, so a rebind in `/etc/slicc/keys.json` shows up in the help
 * sheet — a printed list that disagreed with the live keymap would be worse
 * than no list. A command nobody has a key for is dropped.
 */
/**
 * The key the badge should tell a new user to press for help — the first one
 * bound to `help`, as it prints, or `null` when a config has unbound it.
 *
 * Derived rather than written out for the same reason {@link shortcutRows} is:
 * the mode's own hint must never name a key that does nothing, which is
 * exactly what it did when the shipped map moved help off `h`.
 */
export function helpKeyLabel(keymap: Readonly<Record<string, CommandId>>): string | null {
  const key = Object.keys(keymap).find((k) => keymap[k] === 'help');
  return key === undefined ? null : keyLabel(key);
}

export function shortcutRows(
  keymap: Readonly<Record<string, CommandId>> = DEFAULT_KEYMAP
): ShortcutRow[] {
  const byCommand = new Map<CommandId, string[]>();
  for (const [key, id] of Object.entries(keymap)) {
    byCommand.set(id, [...(byCommand.get(id) ?? []), keyLabel(key)]);
  }
  return [
    {
      keys: ['Esc'],
      description: 'Leave the composer for keyboard mode (again: exit full screen)',
    },
    { keys: ['1 – 9'], description: 'Switch to that agent in the tab strip (9 = last)' },
    ...COMMAND_IDS.filter((id) => byCommand.has(id)).map((id) => ({
      keys: byCommand.get(id) ?? [],
      description: COMMANDS[id].description,
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
    'Keyboard mode is on whenever nothing is focused for typing, so these keys are ' +
    'live by default. Put the caret back in the composer to type — nothing is ' +
    'intercepted there.';
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

/** How long a pressed key stays on the HUD before the strip clears. */
const HUD_LINGER_MS = 1600;

/**
 * How long a list stays addressable after the key that opened it.
 *
 * Deliberately the same number as {@link HUD_LINGER_MS}, and refreshed by the
 * same presses: a chord is live exactly while its caps are on the pill. That
 * is the whole answer to "will this digit switch agents or open a file?" — it
 * is on screen. Paging with the step keys keeps both alive, so a walk down a
 * list never expires under the user mid-walk; stopping ends both together.
 */
const CHORD_WINDOW_MS = HUD_LINGER_MS;
/** How many presses the HUD keeps before dropping the oldest. */
const HUD_DEPTH = 4;

/** How a key prints on a cap. Anything unlisted prints as itself. */
const KEY_CAPS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Enter: '⏎',
  ' ': 'Space',
  Tab: '⇥',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/**
 * A key event as the HUD prints it: the modifiers, then the key.
 *
 * Returned as an ARRAY rather than a string because a press is not always one
 * cap — `⇧` + `a` today, and a future chord (`g` then `t`) is the same shape
 * with the parts coming from two events instead of one.
 */
export function describeKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
): string[] {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('⌃');
  if (event.altKey) parts.push('⌥');
  if (event.metaKey) parts.push('⌘');
  // Shift is implicit in a printed character (`?` is already Shift+/), so it
  // is only worth a cap when the key alone does not say so.
  if (event.shiftKey && event.key.length > 1) parts.push('⇧');
  parts.push(KEY_CAPS[event.key] ?? event.key);
  return parts;
}

/**
 * The mode indicator and key HUD: one non-interactive pill above the composer.
 *
 * It has two states rather than two elements. Idle, it explains the mode
 * ("? for help · ⏎ to type" — the key comes from the live keymap, never from
 * a string here); the moment a key is pressed the hint gives
 * way to a strip of key caps, which is both the "did that register?" feedback
 * and — because presses accumulate left to right — the readout a multi-key
 * chord will need when one exists. The strip clears itself after
 * {@link HUD_LINGER_MS} of quiet and the hint comes back.
 *
 * A press that ran nothing is still shown, dimmed: "that key did nothing" is
 * exactly what someone learning the mode needs to see, and silence would read
 * as a dropped keystroke.
 */
function createBadge(
  doc: Document,
  keymap: Readonly<Record<string, CommandId>>
): {
  element: HTMLElement;
  record(parts: readonly string[], bound: boolean): void;
  destroy(): void;
} {
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
  // Not "Esc to leave": the mode IS the resting state, so the way out is to
  // start typing again. The help key is read from the keymap in force, so a
  // rebind — or the shipped map moving it — can never leave the badge
  // advertising a key that does nothing.
  const help = helpKeyLabel(keymap);
  hint.textContent = help ? `${help} for help · ⏎ to type` : '⏎ to type';
  const keys = doc.createElement('div');
  keys.className = 'wcsc-badge__keys';
  keys.dataset.wcShortcuts = 'keys';
  // The live region announces the MODE, not the typing: a cap per keystroke
  // would turn a screen reader into a telegraph.
  keys.setAttribute('aria-hidden', 'true');
  badge.append(dot, label, hint, keys);

  const view = doc.defaultView;
  const setTimer = view?.setTimeout.bind(view) ?? setTimeout;
  const clearTimer = view?.clearTimeout.bind(view) ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    keys.replaceChildren();
    hint.hidden = false;
  };

  return {
    element: badge,
    record: (parts, bound) => {
      const press = doc.createElement('span');
      press.className = 'wcsc-badge__press';
      press.dataset.bound = String(bound);
      for (const part of parts) {
        const cap = doc.createElement('kbd');
        cap.className = 'wcsc-badge__cap';
        cap.textContent = part;
        press.append(cap);
      }
      // Everything already on the strip is history the moment a new press
      // lands, so it dims — the newest cap is the one being answered.
      for (const previous of keys.children) {
        (previous as HTMLElement).dataset.age = 'stale';
      }
      keys.append(press);
      while (keys.children.length > HUD_DEPTH) keys.firstElementChild?.remove();
      hint.hidden = true;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(clear, HUD_LINGER_MS);
    },
    destroy: () => {
      if (timer !== undefined) clearTimer(timer);
      badge.remove();
    },
  };
}

/** The help overlay's lifecycle, kept apart from the mode's. */
function createHelp(
  doc: Document,
  readKeymap: () => Readonly<Record<string, CommandId>>
): {
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
    dialog.append(buildHelpBody(doc, shortcutRows(readKeymap())));
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
function createMode(
  doc: Document,
  keymap: () => Readonly<Record<string, CommandId>>
): {
  on(): boolean;
  set(next: boolean): void;
  record(parts: readonly string[], bound: boolean): void;
} {
  let modeOn = false;
  let badge: ReturnType<typeof createBadge> | null = null;
  return {
    on: () => modeOn,
    // Only while the mode is on: the badge IS the HUD, so there is nowhere to
    // draw a key otherwise (and nothing outside the mode to draw).
    record: (parts, bound) => badge?.record(parts, bound),
    set: (next: boolean) => {
      if (next === modeOn) return;
      modeOn = next;
      doc.documentElement.toggleAttribute('data-slicc-keyboard-mode', next);
      if (!next) {
        badge?.destroy();
        badge = null;
        return;
      }
      ensureStyle(doc);
      // Read at the moment the badge appears, so a keymap applied after the
      // shell wired itself (the config load is deliberately late) is the one
      // the hint names.
      badge = createBadge(doc, keymap());
      doc.body.append(badge.element);
      // The caret would otherwise keep blinking in a composer that no longer
      // receives what is typed.
      const focused = doc.activeElement as HTMLElement | null;
      if (isTypingTarget(focused)) focused?.blur();
    },
  };
}

/**
 * Keys the mode must not take even while it is on, because something closer to
 * the keyboard owns them: a chord belongs to the browser or the OS, a field
 * that still holds the focus belongs to whoever is typing in it, and an
 * activation key belongs to the control it would press — the mode being the
 * resting state means a tabbed-to button is a NORMAL place for the focus to
 * be, and a button whose Enter is eaten cannot be pressed from the keyboard at
 * all. Shift passes through, for `?`.
 */
function passesThrough(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = deepTarget(event);
  if (isTypingTarget(target)) return true;
  return (event.key === 'Enter' || event.key === ' ') && isActivationTarget(target);
}

/**
 * The mode's other half: the rule that decides where the mode SHOULD be, and
 * the intent that survives a unit switch.
 *
 * Kept apart from {@link createMode}, which owns the flag and the badge,
 * because this is the only part that reads the document's focus rather than
 * being told about it — and reading it once, in one place, is what lets every
 * surface stay ignorant of the mode.
 */
function createSettler(
  doc: Document,
  mode: ReturnType<typeof createMode>,
  deps: ShortcutDeps
): {
  /** Reconcile the mode with the focus, after the current task. */
  schedule(): void;
  /** Land on a newly selected unit in the mode the previous one was left in. */
  restore(): void;
  /** Record a deliberate choice (Escape leaving the composer). */
  choose(next: ModeIntent): void;
  intent(): ModeIntent;
  dispose(): void;
} {
  const view = doc.defaultView;
  const setTimer = view?.setTimeout.bind(view) ?? setTimeout;
  const clearTimer = view?.clearTimeout.bind(view) ?? clearTimeout;
  // A float with no composer to focus can never be in composer mode, so the
  // default answer is "there is one exactly where one can be focused".
  const composerAvailable = deps.composerAvailable ?? ((): boolean => !!deps.focusComposer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intent: ModeIntent = 'composer';

  /**
   * Bring the mode in line with where the focus actually is: on unless
   * something typable holds it. This is the whole resting-state rule, and it
   * is the only writer of the intent besides a deliberate {@link choose} —
   * asking the DOM once beats every surface remembering to tell us.
   */
  const settle = (): void => {
    // A modal owns the keyboard while it is up. The mode settles again when
    // the overlay closes and focus comes back, so this is a deferral, not a
    // skip.
    if (hasOpenOverlay(doc)) return;
    // Nobody is looking at an unfocused document — a Cherry iframe inside a
    // host page, a background tab — and a badge there advertises a mode for a
    // keyboard that is somewhere else entirely.
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return;
    const typing = isTypingTarget(deepActiveElement(doc));
    mode.set(!typing);
    if (composerAvailable()) intent = typing ? 'composer' : 'keyboard';
  };

  /**
   * Settle on a TIMER, not inline, and coalesce. A click that switches units
   * blurs the composer BEFORE it moves the selection, so an inline settle
   * would read the gap between the two as "the user left the composer" and
   * cost them the caret they were about to get back. One macrotask is late
   * enough for the switch's own restore (a MutationObserver microtask) to
   * land first.
   */
  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      settle();
    }, 0);
  };

  return {
    schedule,
    restore: () => {
      if (hasOpenOverlay(doc)) return;
      if (intent === 'composer' && composerAvailable()) {
        mode.set(false);
        deps.focusComposer?.();
      } else {
        mode.set(true);
      }
      // A composer that REFUSED the focus (a follower's disabled card) falls
      // back to keyboard mode rather than to a mode with nowhere to type.
      schedule();
    },
    choose: (next) => {
      intent = next;
    },
    intent: () => intent,
    dispose: () => {
      // A settle that outlived its wiring would re-enter a mode nothing owns.
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

/**
 * Watch which unit the strip has selected.
 *
 * `active` is what every float already writes on a selection — the strip's own
 * `select()`, the leader's `applyThreadContext`, the follower's select handler
 * — so this catches the freezer rail and the cone actions too, and no float
 * has to remember to call anything. A switcher that is not an element (a test
 * double, a headless float) simply never reports a switch.
 */
function observeSelectedUnit(
  switcher: ShortcutSwitcher,
  doc: Document,
  onChange: () => void
): () => void {
  const node =
    (switcher as unknown as Partial<Node>).nodeType === 1 ? (switcher as unknown as Element) : null;
  const ObserverCtor = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (!node || !ObserverCtor) return () => undefined;
  let last = switcher.active;
  const observer = new ObserverCtor(() => {
    const next = switcher.active;
    // Floats re-assert `active` on roster refreshes; only a real move counts.
    if (next === last) return;
    last = next;
    onChange();
  });
  observer.observe(node, { attributes: true, attributeFilter: ['active'] });
  return () => observer.disconnect();
}

/**
 * The step keys: page through the armed list, or — with no chord live — walk
 * the transcript a message at a time.
 *
 * One key doing two things is the point rather than a compromise. "Next" is
 * the same intent either way, and which list it steps through is the one the
 * user just opened and can still see on the HUD; with none open, the thing in
 * front of them is the conversation. It also retires the dedicated cycle key
 * the sprinkles used to need: `p` opens the first and `j` walks the rest.
 *
 * Returns the index it landed on, so the caller can re-arm the chord there and
 * the next press continues from where this one stopped.
 */
function stepList(ctx: CommandContext, delta: 1 | -1): number | void {
  const armed = ctx.armed;
  if (!armed) {
    ctx.deps.scrollMessage?.(delta);
    return;
  }
  const list = chordList(armed.list, ctx.deps);
  const size = list?.size() ?? 0;
  if (!list || size === 0) return;
  // From nowhere, a step forward starts at the top and a step back at the
  // bottom — so `f k` reaches the last file as directly as `f j` reaches the
  // first, and neither has to know how long the list is.
  const at =
    armed.index === null ? (delta > 0 ? 0 : size - 1) : (armed.index + delta + size) % size;
  list.selectAt(at);
  return at;
}

/**
 * Complete a chord: activate the `digit`-th item of the armed list, and say
 * whether there was one. Read at press time, never awaited — a panel still
 * mounting reports nothing and the press lands dimmed instead of firing late.
 */
function selectChordItem(deps: ShortcutDeps, id: ChordListId, digit: number): number | null {
  const list = chordList(id, deps);
  const index = list ? indexForDigit(list.size(), digit) : null;
  if (index === null || !list) return null;
  list.selectAt(index);
  return index;
}

/** Everything a bound command needs, gathered once by the wiring. */
interface Dispatch {
  deps: ShortcutDeps;
  actions: ShortcutActions;
  state: ModeState;
  mode: ReturnType<typeof createMode>;
  settler: ReturnType<typeof createSettler>;
  chord: ReturnType<typeof createChord>;
  toggleHelp(): void;
}

/**
 * Run the command a key is bound to, and leave the mode and the chord where
 * that command's grammar says they belong.
 *
 * The two `holdsMode` halves are the interesting part. The mode is dropped
 * BEFORE the run, so a surface that autofocuses is not immediately undone by
 * it, and settled AFTER, because the flag is a PREDICTION that the surface
 * will take the focus rather than a fact — `dock.selectItem()` only emits a
 * selection, and the files and memory panels focus nothing at all. Without
 * the settle the mode would be left off with nothing focused: badge gone,
 * letters dead, which is precisely the state the resting rule exists to make
 * impossible.
 */
function runCommand(
  command: Command,
  event: KeyboardEvent,
  armed: ArmedChord | null,
  ctx: Dispatch
): void {
  event.preventDefault();
  if (!command.holdsMode) ctx.mode.set(false);
  const at = command.run({
    deps: ctx.deps,
    actions: ctx.actions,
    state: ctx.state,
    toggleHelp: ctx.toggleHelp,
    armed,
  });
  // A command that owns a list arms the keys that may follow it; a STEP key
  // owns no list but re-arms the one it just walked, which is what keeps
  // `f j j j` walking instead of turning back into message scrolling. After
  // the run either way, so a command that threw leaves nothing armed for a
  // surface it failed to open.
  const opened = command.list ?? (typeof at === 'number' ? armed?.list : undefined);
  if (opened) ctx.chord.arm(opened, typeof at === 'number' ? at : null);
  if (!command.holdsMode) ctx.settler.schedule();
}

/**
 * The Escape contract; see the module header.
 *
 * Kept out of the wiring because it is a rule rather than a binding: Escape is
 * the mode itself, not a command, and it is the only key handled before the
 * modal gate.
 */
function handleEscape(
  event: KeyboardEvent,
  doc: Document,
  mode: ReturnType<typeof createMode>,
  settler: ReturnType<typeof createSettler>
): void {
  // An open overlay owns its own Escape; entering the mode underneath it
  // would leave the user pressing Escape twice for one dismissal.
  if (hasOpenOverlay(doc)) return;
  if (!mode.on()) {
    // Swallowed on purpose: one press means "leave the text field", not
    // "leave fullscreen".
    event.preventDefault();
    mode.set(true);
    // Leaving the composer by hand is a CHOICE, so it is the one place besides
    // `settle` that writes the intent: switching units afterwards must not
    // hand the caret back to a composer the user just left.
    settler.choose('keyboard');
    // The press that opened the mode is the mode's first HUD entry — the badge
    // appearing and the cap landing are one gesture's feedback.
    mode.record(describeKey(event), true);
    return;
  }
  // Already in the mode, which is the resting state: there is nothing to
  // leave, so the press is spent on fullscreen. Performed rather than merely
  // allowed, because under Keyboard Lock the browser never acts on Escape
  // itself. The cap lands dimmed when there was no fullscreen to exit — a
  // press that did nothing, shown as one.
  const fullscreen = !!doc.fullscreenElement;
  mode.record(describeKey(event), fullscreen);
  if (fullscreen) void doc.exitFullscreen?.().catch(() => undefined);
}

/**
 * Is a modal holding the keyboard?
 *
 * A dialog owns the screen, and acting behind it — focusing the composer
 * under one, switching the agent it belongs to — leaves the user typing into
 * obscured UI, so every command is suspended while one is up. The single
 * exception is closing the help overlay we opened ourselves, which is how the
 * help key stays a toggle. Escape is handled before this gate, so a modal can
 * always be dismissed.
 */
function suspendedByModal(doc: Document, command: Command | undefined, helpOpen: boolean): boolean {
  return hasOpenOverlay(doc) && !(command === COMMANDS.help && helpOpen);
}

/**
 * A digit press: the armed chord's list when there is one, otherwise the tab
 * strip, which is what digits have always addressed. Returns whether it found
 * anything — a digit past the end of either list is shown dimmed rather than
 * silently dropped, and must NOT fall through to the other one.
 */
function selectByDigit(
  deps: ShortcutDeps,
  armed: ArmedChord | null,
  digit: number
): { hit: boolean; index: number | null } {
  if (armed) {
    const index = selectChordItem(deps, armed.list, digit);
    return { hit: index !== null, index };
  }
  const key = unitKeyForDigit(deps.switcher.scoops, digit);
  if (key !== null) deps.switcher.select(key);
  // The strip is not a chord list, so there is no index to carry forward.
  return { hit: key !== null, index: null };
}

/**
 * The chord's one key of lookahead: which list a digit pressed NEXT indexes
 * into, and for how long.
 *
 * That single slot is the entire state machine. A digit either lands while a
 * list command is armed — where it addresses that command's list — or it does
 * not, and addresses the tab strip exactly as digits always have; there is no
 * third state, so no digit is ever ambiguous. The prefix has already RUN by
 * the time the digit arrives, because a prefix that waited to see whether one
 * was coming would put a delay on the common single-key path, which is the one
 * thing the mode cannot afford.
 */
function createChord(doc: Document): {
  /** Read and disarm — a chord survives a key only by being re-armed. */
  take(): ArmedChord | null;
  /** Arm (or re-arm) a list, standing at `index` — `null` before any pick. */
  arm(list: ChordListId, index: number | null): void;
  clear(): void;
} {
  const view = doc.defaultView;
  const setTimer = view?.setTimeout.bind(view) ?? setTimeout;
  const clearTimer = view?.clearTimeout.bind(view) ?? clearTimeout;
  let armed: (ArmedChord & { timer: ReturnType<typeof setTimeout> }) | null = null;
  const clear = (): void => {
    if (!armed) return;
    clearTimer(armed.timer);
    armed = null;
  };
  return {
    take: () => {
      if (!armed) return null;
      const { list, index } = armed;
      clear();
      return { list, index };
    },
    arm: (list, index) => {
      clear();
      armed = { list, index, timer: setTimer(clear, CHORD_WINDOW_MS) };
    },
    clear,
  };
}

/**
 * The live installation per document. `mountWcShell` is idempotent — a
 * remount replaces the shell in place — and the listeners here live on the
 * DOCUMENT, not on anything `root.replaceChildren()` tears down. Without this,
 * a second mount would leave the first wiring installed and running FIRST,
 * driving the detached shell (and holding it alive through the closure).
 */
const INSTALLED = new WeakMap<Document, ShortcutHandles>();

/**
 * Install the shell's modal key handling, replacing any previous installation
 * on the same document. Safe on any float: only the switcher is required, and
 * every other surface degrades to a no-op binding.
 */
export function wireKeyboardShortcuts(deps: ShortcutDeps): ShortcutHandles {
  const doc = deps.doc ?? (deps.switcher as unknown as { ownerDocument?: Document })?.ownerDocument;
  if (!doc) throw new Error('wireKeyboardShortcuts: no document');
  INSTALLED.get(doc)?.dispose();
  const actions: ShortcutActions = {};
  const help = createHelp(doc, () => keymap);
  const mode = createMode(doc, () => keymap);
  const state: ModeState = { lastDockSurface: 'files' };
  let keymap: Readonly<Record<string, CommandId>> = DEFAULT_KEYMAP;
  const commandFor = (key: string): Command | undefined => {
    const id = keymap[key];
    return id ? COMMANDS[id] : undefined;
  };
  const settler = createSettler(doc, mode, deps);
  const chord = createChord(doc);
  const dispatch: Dispatch = {
    deps,
    actions,
    state,
    mode,
    settler,
    chord,
    toggleHelp: () => help.toggle(),
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Something closer to the key already claimed it (a component's own
    // handler, an overlay's Escape).
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      chord.clear();
      handleEscape(event, doc, mode, settler);
      return;
    }
    if (!mode.on()) return;
    if (passesThrough(event)) return;

    // A chord is one key wide: whatever this key turns out to be, it is not
    // the digit the prefix was waiting for unless it is consumed below.
    const armed = chord.take();

    const command = commandFor(event.key);
    if (suspendedByModal(doc, command, !!help.element())) {
      // Suspended, not ignored: the cap lands dimmed, so a key pressed at a
      // dialog reads as "not now" rather than as a dead keyboard.
      mode.record(describeKey(event), false);
      return;
    }

    const digit = digitFor(event);
    if (digit !== null) {
      // Shown either way: a digit past the end of its list did nothing, and a
      // HUD that stays blank for it reads as a dropped keystroke.
      const { hit, index } = selectByDigit(deps, armed, digit);
      mode.record(describeKey(event), hit);
      if (!hit) return;
      event.preventDefault();
      // Stay armed where the digit landed, so the step keys walk on from it —
      // `f 3 j` is the fourth file.
      if (armed && index !== null) chord.arm(armed.list, index);
      return;
    }

    mode.record(describeKey(event), !!command);
    // An unbound key is not an exit: the mode is sticky, like vim's.
    if (command) runCommand(command, event, armed, dispatch);
  };

  /**
   * Focus reaching a text field ends the mode. Applied INLINE rather than left
   * to the deferred settle: a keystroke can arrive in the same task as the
   * click that focused the field, and it must be typed, not run.
   */
  const onFocusIn = (event: FocusEvent): void => {
    if (mode.on() && isTypingTarget(deepTarget(event))) mode.set(false);
    settler.schedule();
  };
  /**
   * Focus LEAVING is the other half, and the one that has no event of its own
   * when it lands nowhere: blurring the composer for the transcript fires a
   * `focusout` and no `focusin` at all.
   */
  const onFocusOut = (): void => settler.schedule();
  const onFullscreenChange = (): void => syncKeyboardLock(doc);
  /** A document that just got the keyboard back has a mode to show again. */
  const onWindowFocus = (): void => settler.schedule();
  /**
   * ...and one that lost it has no mode to be in. Nothing else notices: with
   * the focus already sitting on nothing there is no `focusout` to fire, so the
   * badge would go on claiming keystrokes that are now going to the host page
   * (Cherry) or to another app entirely. A suspension, not a decision — the
   * intent is untouched, and `onWindowFocus` settles it back on return.
   */
  const onWindowBlur = (): void => mode.set(false);
  const stopWatchingUnit = observeSelectedUnit(deps.switcher, doc, settler.restore);

  const view = doc.defaultView;
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  view?.addEventListener('focus', onWindowFocus);
  view?.addEventListener('blur', onWindowBlur);
  syncKeyboardLock(doc);
  // Deferred like every other settle: the shell is still being assembled at
  // wire time, and a host that focuses the composer on mount must win.
  settler.schedule();

  const handles: ShortcutHandles = {
    dispose: () => {
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      view?.removeEventListener('focus', onWindowFocus);
      view?.removeEventListener('blur', onWindowBlur);
      stopWatchingUnit();
      settler.dispose();
      // An armed chord that outlived its wiring would fire into a dead shell.
      chord.clear();
      mode.set(false);
      help.hide();
      // Only if we are still the live one: a remount disposes the old handle
      // AFTER installing itself would be wrong, so `wireKeyboardShortcuts`
      // disposes first — but a caller disposing an already-replaced handle
      // must not evict its successor.
      if (INSTALLED.get(doc) === handles) INSTALLED.delete(doc);
    },
    showHelp: help.show,
    hideHelp: help.hide,
    helpOverlay: help.element,
    active: mode.on,
    setActive: mode.set,
    intent: settler.intent,
    setAction: (name, fn) => {
      actions[name] = fn;
    },
    setKeymap: (next) => {
      keymap = { ...next };
    },
    keymap: () => keymap,
  };
  INSTALLED.set(doc, handles);
  return handles;
}
