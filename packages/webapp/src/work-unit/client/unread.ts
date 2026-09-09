/**
 * "This unit said something while you were looking elsewhere" — the one
 * implementation, for both floats.
 *
 * Multiple cones made the strip a place you leave things running, so a tab has
 * to be able to say it has news. The signal is derived from the ROSTER rather
 * than from a message stream, which is what lets a leader and a follower share
 * it: a leader could count `turn_end` per unit, but a follower subscribes only
 * to the transcript of the unit it is showing and would have nothing to count.
 *
 * A turn ending is a unit that was working and is not any more, and the roster
 * answers that two ways. `turns` is a COUNTER the producing page increments on
 * the kernel event itself, so it is preferred wherever it is present: the
 * leader coalesces roster pushes for 50ms and only the selected unit sends
 * direct status frames, so an off-screen turn that starts and finishes inside
 * one window reaches a follower in its final `idle` state alone — sampled
 * state shows nothing, while a counter that went up by one still does (#2948).
 * Where the counter is absent (a leader too old to send it) the ledger falls
 * back to the transition it can see, which is what it did before the field
 * existed.
 *
 * Selection is the read receipt: the selected unit is always at zero, so the
 * count clears the moment the user looks. Nothing here persists — unread is
 * per-page-session by design, the way an unseen streamed reply is.
 *
 * **Only cones are counted.** A scoop's turns are the cone's own work, not news
 * addressed to the user: a single ask can fan out to a dozen scoops that each
 * finish several turns, which dotted most of the strip for something nobody
 * asked to read — and users never talk to a scoop, so there is no reply waiting
 * behind that dot. The cone that owns the work still reports when its turn ends.
 */

import { isRootSummary } from './presentation.js';
import type { WorkUnitId, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

/** What the ledger needs of a unit: who it is, what it is, what it finished. */
type LedgerUnit = Pick<WorkUnitSummary, 'id' | 'role' | 'state' | 'turns'>;

export class UnreadLedger {
  readonly #counts = new Map<WorkUnitId, number>();
  readonly #lastState = new Map<WorkUnitId, WorkUnitPresentationState>();
  readonly #lastTurns = new Map<WorkUnitId, number>();

  /**
   * Fold a roster and the current selection into unread counts for its CONES,
   * and return them for the strip.
   *
   * Called from the strip publisher, so it runs on every roster push, every
   * status change and every selection change — the three events that can move
   * a count. It is idempotent for an unchanged roster: an increment needs a
   * turn to have FINISHED since the last look, not merely a unit that is idle
   * now.
   */
  sync(units: readonly LedgerUnit[], selectedId?: WorkUnitId | null): ReadonlyMap<string, number> {
    const present = new Set<WorkUnitId>();
    for (const unit of units) {
      // A scoop is never news (see the header): skipping it before the baseline
      // is recorded also keeps its transitions out of the maps entirely.
      if (!isRootSummary(unit)) continue;
      present.add(unit.id);
      const finished = this.#turnsFinished(unit);
      if (finished > 0 && unit.id !== selectedId) {
        this.#counts.set(unit.id, (this.#counts.get(unit.id) ?? 0) + finished);
      }
    }
    // Selection is the read receipt, applied after the increments: a turn that
    // ends on the unit the user is watching is already read.
    if (selectedId) this.#counts.delete(selectedId);
    // A cone the roster dropped is gone for good; keeping its count would leak
    // the map across a long session and resurrect a stale dot if the id ever
    // came back.
    for (const id of [...this.#counts.keys()]) if (!present.has(id)) this.#counts.delete(id);
    for (const id of [...this.#lastState.keys()]) if (!present.has(id)) this.#lastState.delete(id);
    for (const id of [...this.#lastTurns.keys()]) if (!present.has(id)) this.#lastTurns.delete(id);
    return this.counts();
  }

  /**
   * How many turns this unit has finished since the last look — the counter's
   * delta where the producer sends one, the state transition otherwise.
   *
   * Both branches record their baseline for next time, and neither counts a
   * unit's FIRST sighting: a roster arriving with `turns: 7` is a page joining
   * a session already in progress, not seven messages the user missed, and a
   * first roster must not open with every tab dotted. A unit we HAVE been
   * watching baselines at zero instead, because the counter only reaches the
   * wire once the unit finishes its first turn — and that turn is news.
   *
   * A counter that went DOWN is a leader that reloaded and restarted at zero,
   * so it re-baselines rather than counting a negative delta as news.
   */
  #turnsFinished(unit: LedgerUnit): number {
    const previousState = this.#lastState.get(unit.id);
    const seen = this.#lastState.has(unit.id);
    this.#lastState.set(unit.id, unit.state);
    if (typeof unit.turns === 'number' && Number.isFinite(unit.turns)) {
      const previousTurns = this.#lastTurns.get(unit.id) ?? (seen ? 0 : undefined);
      this.#lastTurns.set(unit.id, unit.turns);
      if (previousTurns === undefined) return 0;
      return unit.turns > previousTurns ? Math.floor(unit.turns - previousTurns) : 0;
    }
    // The counter can appear mid-session (the unit's first turn is what makes
    // the leader send it); dropping the stale baseline keeps that arrival from
    // reading as a jump from an older, unrelated value.
    this.#lastTurns.delete(unit.id);
    return seen && previousState === 'working' && unit.state !== 'working' ? 1 : 0;
  }

  /** The counts as the strip reads them. Units at zero are absent. */
  counts(): ReadonlyMap<string, number> {
    return new Map(this.#counts);
  }
}
