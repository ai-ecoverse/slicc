/**
 * Hard per-run ceilings for a prompt run (#1972).
 *
 * Owns: the turn counter, the wall-clock timer, and the note that records
 * which ceiling tripped — plus the decision of when a run has to stop.
 *
 * Changes when a new kind of bound is added (a token ceiling, a cost ceiling)
 * or when the enforcement point moves. That is cost policy; it has nothing to
 * say about retries or recovery, and it used to own three mutable fields on a
 * class where nothing else read them.
 */

import type { ScoopConfig } from '../types.js';

export interface RunBoundsDeps {
  /** The unit's config, read live so a mid-run edit is picked up. */
  getConfig: () => ScoopConfig | undefined;
  isDisposed: () => boolean;
  /**
   * Terminate the run. Called once per run at most, after the note is
   * recorded — the caller flips the unit to `error` and stops the agent so
   * the lifecycle manager never sees a `ready` transition and announces the
   * partial output as a completed scoop (agentic memory sets
   * `notifyOnComplete`). The run is a failure, surfaced through `onError` in
   * cleanup and exit 1.
   */
  onTripped: () => void;
}

export class RunBounds {
  private turnCount = 0;
  private exceededNote: string | null = null;
  private wallClockTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RunBoundsDeps) {}

  /**
   * #1972: arm the hard per-run ceilings from `ScoopConfig`. A spawned
   * agent with no bound once billed $53.81 across 163 turns after its
   * caller had already timed out — the "timeout" only stopped the
   * waiting, never the run. `stop()` ends the run for real; the note
   * makes `cleanupPromptState` surface a bounded failure to observers
   * (the agent bridge maps it to a non-zero exit).
   */
  arm(): void {
    this.turnCount = 0;
    this.exceededNote = null;
    const ms = this.deps.getConfig()?.maxWallClockMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      this.wallClockTimer = setTimeout(() => {
        this.wallClockTimer = null;
        this.trip(`wall-clock bound (${ms} ms) exceeded`);
      }, ms);
    }
  }

  /**
   * Count a COMPLETED turn (`turn_end`). Overflow-recovery turns are
   * counted too: `maxTurns` is a cost cap and every model round-trip
   * bills, so an overflow turn is not "free" — see the enforcement on
   * `turn_start`, which is what actually stops a run.
   */
  recordCompletedTurn(): void {
    this.turnCount += 1;
  }

  /**
   * #1972 turn ceiling, enforced on `turn_start`. A run that finishes on
   * exactly `maxTurns` emits its final `turn_end` (counted above) then
   * `agent_end` and completes NORMALLY — the ceiling only trips when the
   * agent tries to BEGIN a turn beyond the limit, so a legitimate
   * single-turn answer under `maxTurns: 1` is never marked a failure.
   */
  enforceOnTurnStart(): void {
    const maxTurns = this.deps.getConfig()?.maxTurns;
    if (typeof maxTurns === 'number' && maxTurns > 0 && this.turnCount >= maxTurns) {
      this.trip(`turn bound (${maxTurns}) exceeded`);
    }
  }

  /**
   * Clear the armed wall-clock timer. Called symmetrically from turn cleanup
   * and from `dispose()`: a dispose mid-bounded-run (shutdown, `drop_scoop`)
   * bypasses cleanup, and the armed timer would otherwise hold a reference to
   * the disposed context until it fires.
   */
  disarm(): void {
    if (this.wallClockTimer !== null) {
      clearTimeout(this.wallClockTimer);
      this.wallClockTimer = null;
    }
  }

  /**
   * The bound note for this run, consumed once. A bound-terminated run must
   * not read as a clean completion: the caller surfaces the ceiling through
   * `onError` so observers (the agent bridge) report a non-zero exit instead
   * of a truncated-but-"successful" result (#1972).
   */
  takeExceededNote(): string | null {
    const note = this.exceededNote;
    this.exceededNote = null;
    return note;
  }

  /** Terminate a run for exceeding a bound (#1972). First trip wins. */
  private trip(note: string): void {
    if (this.exceededNote !== null || this.deps.isDisposed()) return;
    this.exceededNote = note;
    this.deps.onTripped();
  }
}
