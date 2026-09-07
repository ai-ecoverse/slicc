/**
 * "This unit said something while you were looking elsewhere" — the one
 * implementation, for both floats.
 *
 * Multiple cones made the strip a place you leave things running, so a tab has
 * to be able to say it has news. The signal is derived from the ROSTER rather
 * than from a message stream, which is what lets a leader and a follower share
 * it: a leader could count `turn_end` per unit, but a follower subscribes only
 * to the transcript of the unit it is showing and would have nothing to count.
 * Both sides do see every unit's presentation state, so a turn ending is a
 * `working` unit that stops working — which is exactly one increment.
 *
 * Selection is the read receipt: the selected unit is always at zero, so the
 * count clears the moment the user looks. Nothing here persists — unread is
 * per-page-session by design, the way an unseen streamed reply is.
 */

import type { WorkUnitId, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

/** What the ledger needs of a unit: who it is and what it is doing. */
type LedgerUnit = Pick<WorkUnitSummary, 'id' | 'state'>;

export class UnreadLedger {
  readonly #counts = new Map<WorkUnitId, number>();
  readonly #lastState = new Map<WorkUnitId, WorkUnitPresentationState>();

  /**
   * Fold a roster and the current selection into unread counts, and return
   * them for the strip.
   *
   * Called from the strip publisher, so it runs on every roster push, every
   * status change and every selection change — the three events that can move
   * a count. It is idempotent for an unchanged roster: an increment needs a
   * state TRANSITION out of `working`, not merely a unit that is idle now.
   */
  sync(units: readonly LedgerUnit[], selectedId?: WorkUnitId | null): ReadonlyMap<string, number> {
    const present = new Set<WorkUnitId>();
    for (const unit of units) {
      present.add(unit.id);
      const previous = this.#lastState.get(unit.id);
      this.#lastState.set(unit.id, unit.state);
      // A unit still working has not finished saying anything, and a unit we
      // have never seen before is not news the user missed — a first roster
      // must not open with every tab dotted.
      if (previous === 'working' && unit.state !== 'working' && unit.id !== selectedId) {
        this.#counts.set(unit.id, (this.#counts.get(unit.id) ?? 0) + 1);
      }
    }
    // Selection is the read receipt, applied after the increments: a turn that
    // ends on the unit the user is watching is already read.
    if (selectedId) this.#counts.delete(selectedId);
    // A unit the roster dropped is gone for good (a dropped cone, a scoop that
    // finished); keeping its count would leak the map across a long session and
    // resurrect a stale dot if the id ever came back.
    for (const id of [...this.#counts.keys()]) if (!present.has(id)) this.#counts.delete(id);
    for (const id of [...this.#lastState.keys()]) if (!present.has(id)) this.#lastState.delete(id);
    return this.counts();
  }

  /** The counts as the strip reads them. Units at zero are absent. */
  counts(): ReadonlyMap<string, number> {
    return new Map(this.#counts);
  }
}
