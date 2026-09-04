/**
 * The floating key caps: a `<slicc-keycap>` on every control keyboard mode can
 * reach, up with the mode and down with it.
 *
 * ## Why this exists as well as the HUD and the help sheet
 *
 * The HUD answers "did that keystroke go anywhere?" after the fact. The help
 * sheet answers "what is there?" in a list you have to open, and remember.
 * Neither answers the question the mode actually leaves you with, which is
 * *what can I press at the thing I am looking at* — and that is the question
 * that decides whether the mode is ever discovered at all. `f` opening the
 * file rail is unguessable from a folder icon; a cap on the folder icon makes
 * it obvious and then makes the sheet unnecessary.
 *
 * ## Why the caps float in a layer instead of living inside the controls
 *
 * A `<slicc-keycap>` normally pins to its parent — put it inside a positioned
 * control and it is done, no wiring. That is exactly what the shell CANNOT do
 * here. Every control worth capping is a shadow component, and a child
 * appended to one lands in its light DOM, where `<slicc-icon-button>` treats
 * it as a replacement for the glyph and `<slicc-dock>` throws it away on its
 * next `replaceChildren`. Wrapping is worse: the composer's toolbar controls
 * are SLOTTED, so moving one into a wrapper unassigns it from its slot and it
 * stops rendering at all.
 *
 * So the caps live in one fixed, click-through layer over the document, each
 * one positioned on a measured ghost of its control. Nobody's DOM is touched,
 * a component may re-render as often as it likes, and the cap's own placement
 * geometry still works because the ghost really is a box of the right size in
 * the right place. `keycap.anchor` then points the hover press back at the
 * REAL control, so hovering the folder icon still presses its `f`.
 *
 * ## Which controls get one, and which cannot yet
 *
 * The persistent chrome, which is where the unguessable letters are: the rail
 * launchers, the composer band, the switcher, and the caret's way home.
 *
 * Deliberately NOT the transcript (the copy row, approval cards) — that is the
 * one part of the shell that mutates on every streamed token, and keeping a
 * cap glued to a moving row would put an observer on the hot path for two of
 * the most guessable bindings in the map.
 *
 * Not the tab strip's DIGITS either, though the strip itself is capped: the
 * digits would be the precise answer and cannot be drawn, because
 * `<slicc-agent-tabs>` clips its own track (that is how overflowing tabs hide
 * behind the "more" button) and a cap overhanging a segment is cut in half.
 * The arrows beside the track say the same thing better anyway — once for the
 * strip instead of nine times, and the digits are the one binding a user
 * already expects. Drawing the digits properly would mean the component
 * rendering them itself, which is a change to `<slicc-agent-tabs>`.
 *
 * Not the model and thinking pills, for a plainer reason: they are inside
 * `<slicc-composer-meta>`'s shadow root, where the shell cannot put anything
 * and `::part` can style a part but cannot add a child to one.
 */

import type { ShortcutCaps } from './wc-shortcuts.js';
import { type CommandId, commandKeyLabel, commandSurfaceId } from './wc-shortcuts.js';

/**
 * Under `<slicc-dialog>` (100), over the rails. A cap is chrome, not an
 * overlay: it must never sit on top of a modal that has taken the keyboard.
 */
const LAYER_Z = 40;

/**
 * How far a cap sticks out past its control's corner, near enough — the
 * element's own `placement` insets plus its width, in the 11px base it draws
 * at, taken from the FURTHEST of them (the side placements, which clear the
 * control entirely rather than overhanging a corner).
 *
 * Only ever used to ask "would this one fall off the screen?", so an estimate
 * is the right shape of answer, and erring high is the right direction: a cap
 * that flips a few pixels early is invisible, one that never flips is cut in
 * half by the window edge.
 */
const OVERHANG_PX = 56;

const LAYER_CLASS = 'wcsc-caps';
const GHOST_CLASS = 'wcsc-caps__ghost';
const STYLE_ID = 'wcsc-caps-style';

/**
 * `fixed`, so a measured `getBoundingClientRect()` is usable as-is: viewport
 * coordinates in, viewport coordinates out, with no offset-parent arithmetic
 * to get wrong when the shell is inside a transformed panel.
 */
const LAYER_CSS = `
.${LAYER_CLASS}{position:fixed;inset:0;z-index:${LAYER_Z};pointer-events:none;}
.${GHOST_CLASS}{position:absolute;pointer-events:none;}
`;

/** What the caps need from the shell: the roots its controls live under. */
export interface ShortcutCapDeps {
  /** The composer's input card — the add menu and the send button are in it. */
  inputCard: HTMLElement;
  /**
   * The tab strip, for its COUNT. `←` / `→` walk a cycle, and a cycle of one
   * is a key that does nothing — so with a single unit the arrows earn no cap.
   */
  switcher: { readonly scoops: ReadonlyArray<unknown> };
  /**
   * A node in the live document. Used only to reach `ownerDocument`: the rail
   * is looked up document-wide because a float has exactly one of it, and
   * because `panelizeShell` moves it out from under any frame we could hold.
   */
  root: HTMLElement;
}

/**
 * One capped control: the command whose key it names, and how to find it.
 *
 * The KEY is not in here — it is read from the live keymap through
 * {@link commandKeyLabel} at show time, so a cap can never name a binding a
 * user's `keys.json` has moved or unbound.
 */
interface CapSpec {
  /**
   * The command(s) whose keys this cap names. More than one where the control
   * has more than one key and they are ONE affordance — the tab strip's two
   * arrows, which sit adjacent on a real keyboard and are drawn adjacent here
   * for exactly that reason. Commands nothing is bound to drop out, so a cap
   * with a rebound half still names the half that works.
   */
  commands: readonly CommandId[];
  find(deps: ShortcutCapDeps): HTMLElement | null;
  placement?: string;
}

/** The legend for a spec: every bound key it names, or `null` for none. */
function labelFor(spec: CapSpec, keymap: Readonly<Record<string, CommandId>>): string | null {
  const keys = spec.commands
    .map((command) => commandKeyLabel(keymap, command))
    .filter((key) => key !== null);
  return keys.length === 0 ? null : keys.join(' ');
}

/** The rail item a dock command opens, by the id the command itself declares. */
function railItem(command: CommandId): CapSpec {
  return {
    commands: [command],
    find: (deps) => {
      const id = commandSurfaceId(command);
      return id
        ? deps.root.ownerDocument.querySelector<HTMLElement>(
            `slicc-dock-item[item-id="${escapeAttr(id)}"]`
          )
        : null;
    },
  };
}

/** `CSS.escape`, with a fallback for realms that predate it. */
function escapeAttr(value: string): string {
  return typeof globalThis.CSS?.escape === 'function'
    ? globalThis.CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

/**
 * The capped controls, in sweep order — the order the entry stagger runs in,
 * so the caps land top-to-bottom down the rail and then along the band rather
 * than in whatever order a query happened to return them.
 */
const SPECS: readonly CapSpec[] = [
  {
    /*
     * The switcher, named on the strip as a whole rather than per segment.
     *
     * The digits (1-9) would be the precise answer and they cannot be drawn:
     * `<slicc-agent-tabs>` clips its own track — that is how overflowing tabs
     * hide behind the "more" button — so a cap overhanging a segment is cut in
     * half. The arrows are the better answer anyway: they say "this strip
     * moves" once, instead of nine times, and the digits are the one binding
     * a user already expects.
     *
     * Anchored to the TRACK, not to the host: the host is mostly empty space
     * (it stretches to fill the nav bar), so a cap on its edge would float
     * unattached to anything. And anchored from OUTSIDE, which is why the
     * track's clip does not apply — the cap is in the layer, not in the track.
     */
    commands: ['prevAgent', 'nextAgent'],
    find: (deps) =>
      // With one unit the arrows cycle back to where they started, so there is
      // nothing to say — and saying it anyway would put a dead key on the
      // busiest chrome in the shell, since one cone and no scoops is the
      // COMMON case, not an edge one.
      deps.switcher.scoops.length > 1
        ? deps.root.ownerDocument.querySelector<HTMLElement>(
            'slicc-agent-tabs [part="track-frame"]'
          )
        : null,
    placement: 'end',
  },
  railItem('tabs'),
  railItem('files'),
  railItem('terminal'),
  railItem('memory'),
  railItem('monitor'),
  {
    // `e` opens the FIRST sprinkle, so the first launcher is the honest place
    // to say so — there is no fixed id for it, the rail's sprinkles are
    // whatever the agent has installed.
    commands: ['sprinkles'],
    find: (deps) =>
      deps.root.ownerDocument.querySelector<HTMLElement>('slicc-dock-item[kind="sprinkle"]'),
  },
  {
    /*
     * The left rail's collapse toggle — the control `[` drives, and the one
     * piece of chrome in the shell that had no hint at all.
     *
     * `]` has no cap on purpose: it toggles the RIGHT panel, whose rail items
     * already carry their own letters, and it means "close whatever is open"
     * rather than naming any one control. A cap on the rail as a whole next to
     * five that name individual panels would read as a sixth panel.
     */
    commands: ['leftRail'],
    find: (deps) =>
      deps.root.ownerDocument.querySelector<HTMLElement>('slicc-freezer [part="toggle"]'),
  },
  {
    commands: ['attach'],
    find: (deps) => deps.inputCard.querySelector<HTMLElement>('slicc-add-menu'),
    // The add menu sits at the band's left edge; a cap on its right corner
    // would reach into the textarea.
    placement: 'top-start',
  },
  {
    // The send button IS the stop button while a turn runs, which is the only
    // time `s` does anything — the same control, so the same cap.
    commands: ['stop'],
    find: (deps) => deps.inputCard.querySelector<HTMLElement>('slicc-send-button'),
  },
  {
    /*
     * The way back to typing, on the thing you would type into.
     *
     * The most important key in the mode and the one the HUD already spends
     * words on ("[i] or [⏎] to type"), because the mode is the RESTING state:
     * "how do I type again?" is the question it has to answer, and answering
     * it at the caret's own corner beats answering it in a strip at the
     * bottom of the column.
     *
     * On the textarea rather than the card, so it lands at the corner of the
     * text rather than out on the card's padding — and reachable without
     * touching a shadow root, because `<slicc-input-card>` keeps its textarea
     * in the light DOM.
     */
    commands: ['composer'],
    find: (deps) => deps.inputCard.querySelector<HTMLElement>('textarea'),
    placement: 'top-start',
  },
];

/**
 * Keep a cap on screen: a control against the right edge of the window gets
 * its cap on the left corner instead, and vice versa. Only the horizontal
 * axis flips — the vertical overhang is a few pixels and the chrome it hangs
 * off is never flush with the top of the window.
 */
function flip(placement: string, rect: DOMRect, width = globalThis.innerWidth): string {
  // Suffix rather than equality, so the bare side placements (`start` / `end`,
  // which clear the control) flip on the same rule as the corner ones.
  if (placement.endsWith('end') && rect.right + OVERHANG_PX > width) {
    return placement.replace(/end$/, 'start');
  }
  if (placement.endsWith('start') && rect.left - OVERHANG_PX < 0) {
    return placement.replace(/start$/, 'end');
  }
  return placement;
}

/** A `<slicc-keycap>`, as far as this module needs it. */
type KeycapElement = HTMLElement & { anchor?: HTMLElement | null };

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = LAYER_CSS;
  (doc.head ?? doc.documentElement)?.append(style);
}

/**
 * Install the floating key caps over a mounted shell.
 *
 * Returns the handle {@link ShortcutCaps} the mode drives: `show` on entering
 * the mode, `hide` on leaving, `destroy` when the wiring goes away.
 */
export function createShortcutCaps(deps: ShortcutCapDeps): ShortcutCaps {
  const doc = deps.root.ownerDocument;
  const view = doc.defaultView;

  let layer: HTMLElement | null = null;
  let keymap: Readonly<Record<string, CommandId>> = {};
  /** The live cap per spec index, so `sync` updates rather than rebuilds. */
  const mounted = new Map<number, { ghost: HTMLElement; cap: KeycapElement }>();

  let frame = 0;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;

  /** Coalesce every trigger into one measured pass per frame. */
  const schedule = (): void => {
    if (!layer || frame !== 0 || !view) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (layer) sync();
    });
  };

  const drop = (index: number): void => {
    const live = mounted.get(index);
    if (!live) return;
    // Cut the anchor first: the cap holds listeners on a control that is
    // outliving it, and a removed node's `disconnectedCallback` is the only
    // thing that would otherwise release them.
    live.cap.anchor = null;
    live.ghost.remove();
    mounted.delete(index);
  };

  /**
   * Re-measure, and re-resolve while we are at it: the rail rebuilds its
   * items wholesale (`<slicc-dock>` calls `replaceChildren`), so a target
   * held from last time may be a detached node by now.
   */
  function sync(): void {
    if (!layer) return;
    SPECS.forEach((spec, index) => {
      const label = labelFor(spec, keymap);
      const target = label === null ? null : spec.find(deps);
      const rect = target?.getBoundingClientRect();
      // A control with no box is one the float does not have: a follower
      // hides rail items it has no feature for, and a collapsed rail has no
      // launchers at all. No box, no cap — the HUD still names the key.
      if (label === null || !target || !rect || rect.width === 0 || rect.height === 0) {
        drop(index);
        return;
      }

      let live = mounted.get(index);
      if (!live) {
        const ghost = doc.createElement('div');
        ghost.className = GHOST_CLASS;
        const cap = doc.createElement('slicc-keycap') as KeycapElement;
        cap.setAttribute('stagger', String(index));
        ghost.append(cap);
        layer?.append(ghost);
        live = { ghost, cap };
        mounted.set(index, live);
      }

      /*
       * Which corner it hangs off, decided against the viewport rather than
       * written down. The dock rail is flush with the right edge of the
       * window, so its caps would hang off the SCREEN — and which edge the
       * rail is on is a layout choice (`panelizeShell` can put the rail in
       * any zone), so a hard-coded corner would only be right for today's
       * default. Measured, it is right for every layout and every window.
       */
      const placement = flip(spec.placement ?? 'top-end', rect);
      if (live.cap.getAttribute('placement') !== placement) {
        live.cap.setAttribute('placement', placement);
      }

      // Only ever written when it CHANGES: `cap` re-renders on every write,
      // and this runs on a resize drag.
      if (live.cap.getAttribute('cap') !== label) live.cap.setAttribute('cap', label);
      // Points the hover press at the real control rather than at the ghost,
      // which is `pointer-events: none` and could never be hovered.
      if (live.cap.anchor !== target) live.cap.anchor = target;

      const style = live.ghost.style;
      style.left = `${rect.left}px`;
      style.top = `${rect.top}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;

      resizeObserver?.observe(target);
    });
  }

  const show = (next: Readonly<Record<string, CommandId>>): void => {
    keymap = next;
    if (layer) {
      sync();
      return;
    }
    ensureStyle(doc);
    layer = doc.createElement('div');
    layer.className = LAYER_CLASS;
    // The same marker the HUD carries, so everything keyboard mode puts in
    // the document answers one query when you are looking for it.
    layer.dataset.wcShortcuts = 'caps';
    doc.body.append(layer);

    if (view?.ResizeObserver) resizeObserver = new view.ResizeObserver(schedule);
    // The rail rebuilds its items; the band swaps its send button for a stop
    // button. Both are small, static subtrees — and neither is the transcript,
    // which is the whole reason the transcript has no caps.
    if (view?.MutationObserver) {
      mutationObserver = new view.MutationObserver(schedule);
      mutationObserver.observe(deps.inputCard, { childList: true, subtree: true });
      const dock = doc.querySelector('slicc-dock');
      if (dock) mutationObserver.observe(dock, { childList: true, subtree: true });
    }
    // A panel opening reflows the rail without mutating it, and a scrolled
    // page moves every fixed-layer coordinate at once.
    view?.addEventListener('resize', schedule);
    doc.addEventListener('scroll', schedule, { capture: true, passive: true });
    resizeObserver?.observe(doc.documentElement);

    sync();
  };

  const hide = (): void => {
    if (!layer) return;
    if (frame !== 0) {
      view?.cancelAnimationFrame(frame);
      frame = 0;
    }
    for (const index of [...mounted.keys()]) drop(index);
    resizeObserver?.disconnect();
    resizeObserver = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    view?.removeEventListener('resize', schedule);
    doc.removeEventListener('scroll', schedule, { capture: true });
    layer.remove();
    layer = null;
  };

  return { show, hide, destroy: hide };
}
