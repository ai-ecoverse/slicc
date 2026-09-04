/**
 * What this user actually does, this session — the data that turns the help
 * sheet from a reference into a cheat sheet.
 *
 * ## Why it counts CLICKS, not keystrokes
 *
 * A list of the shortcuts you already use is worthless: you know those. The
 * useful sheet is the one that says *you opened Files eleven times today —
 * press `f`*, and that means counting what the user does with the MOUSE, on
 * the surfaces they have never once reached from the keyboard.
 *
 * Keyboard mode's own doctrine makes this cheap. Every command reaches its
 * surface through the event a click on that surface produces, so the click and
 * the key are literally the same event — listen for it once and both are
 * counted, with no per-command wiring and no way for the two paths to drift.
 * A rail item opened by pointer and one opened by `f` are indistinguishable
 * here, which is exactly right: they are the same action.
 *
 * ## One action, one count — which is the whole subtlety
 *
 * That same doctrine is also the trap. A KEYED command is recorded once by the
 * dispatcher and then reaches its surface through the very event this module
 * listens for, so the naive version counts a keystroke twice and ranks keyed
 * panel opens 2:1 against clicked ones — precisely the bias the feature exists
 * to remove.
 *
 * So a keyed record OWNS the rest of its synchronous turn: any surface event
 * the command goes on to dispatch is the same action arriving by its other
 * name, and is ignored. That rule needs no list of which commands route
 * through a heard event, so it cannot drift as commands are added — and it
 * also fixes the attribution, which a suppression list would not have: `r`
 * forces the left rail open to show archived chats, firing `freezer-toggle`,
 * and the key is what the user actually pressed, so `sessions` is what gets
 * the count rather than `leftRail`.
 *
 * It rests on one fact worth stating: a command dispatches its surface event
 * SYNCHRONOUSLY from `run()` (`slicc-dock.selectItem` and the freezer's
 * toggle both call `dispatchEvent` directly), so the turn is still open when
 * the event lands.
 *
 * ## Session-scoped, and deliberately not persisted
 *
 * "Since you started" is the honest window for "what have you been doing", and
 * it needs no storage, no migration and no privacy question — a record of
 * every panel a user opens is not something to write to disk for a cheat
 * sheet. It also self-corrects: the counts describe the work in front of you
 * rather than an average of every session you have ever had.
 */

import { type CommandId, commandForSurfaceId, isCommandId } from './wc-shortcuts.js';

/** One command's usage this session. */
export interface UsageEntry {
  id: CommandId;
  count: number;
}

export interface ShortcutUsage {
  /**
   * Count one use, from the KEYBOARD — and claim the rest of this synchronous
   * turn, so the surface event the command is about to dispatch is not counted
   * as a second use of the same action.
   */
  record(id: CommandId): void;
  /** Has this been used at all this session? */
  used(id: CommandId): boolean;
  /**
   * Every command used at least once, most-used first, ties broken by most
   * recent — so a run of one-offs is ordered by what you did last rather than
   * by an arbitrary insertion order.
   */
  ranked(): UsageEntry[];
  dispose(): void;
}

/**
 * The surface events that mean "the user did this thing", whichever way they
 * did it. Each is the event the command itself dispatches, so a shortcut and a
 * click land here identically.
 */
const DOCK_SELECT = 'slicc-dock-select';
const FREEZER_TOGGLE = 'freezer-toggle';

/** `detail.id` off a dock select, whatever shape the float sends. */
function selectedSurfaceId(event: Event): string | null {
  const detail = (event as CustomEvent<{ id?: unknown }>).detail;
  return typeof detail?.id === 'string' ? detail.id : null;
}

/**
 * Start counting.
 *
 * Listens in the CAPTURE phase on the document: the rails live in different
 * parts of the tree depending on the layout (`panelizeShell` re-parents them),
 * and a listener that had to find them first would miss everything until they
 * mounted.
 */
export function createShortcutUsage(doc: Document): ShortcutUsage {
  const counts = new Map<CommandId, number>();
  /** Insertion clock, not a wall clock: only the ORDER is ever compared. */
  const lastAt = new Map<CommandId, number>();
  let tick = 0;

  const count = (id: CommandId): void => {
    if (!isCommandId(id)) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    tick += 1;
    lastAt.set(id, tick);
  };

  /**
   * Set while a keyed command is still running, so the surface event it is
   * about to dispatch is recognised as the same action rather than a second
   * one. Cleared on the microtask after the keystroke's synchronous work.
   */
  let keyedTurn = false;

  const record = (id: CommandId): void => {
    count(id);
    if (keyedTurn) return;
    keyedTurn = true;
    queueMicrotask(() => {
      keyedTurn = false;
    });
  };

  /** A use observed at the surface — ignored when a key already claimed it. */
  const fromSurface = (id: CommandId): void => {
    if (keyedTurn) return;
    count(id);
  };

  const onDockSelect = (event: Event): void => {
    const surfaceId = selectedSurfaceId(event);
    if (surfaceId === null) return;
    const id = commandForSurfaceId(surfaceId);
    // A sprinkle launcher has no fixed surface id of its own, and `sprinkles`
    // is the command that opens the first one — so any launcher that is not a
    // named tool counts as a use of it.
    fromSurface(id ?? 'sprinkles');
  };
  const onFreezerToggle = (): void => fromSurface('leftRail');

  doc.addEventListener(DOCK_SELECT, onDockSelect, true);
  doc.addEventListener(FREEZER_TOGGLE, onFreezerToggle, true);

  return {
    record,
    used: (id) => counts.has(id),
    ranked: () =>
      [...counts.entries()]
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count || (lastAt.get(b.id) ?? 0) - (lastAt.get(a.id) ?? 0)),
    dispose: () => {
      doc.removeEventListener(DOCK_SELECT, onDockSelect, true);
      doc.removeEventListener(FREEZER_TOGGLE, onFreezerToggle, true);
      counts.clear();
      lastAt.clear();
    },
  };
}
