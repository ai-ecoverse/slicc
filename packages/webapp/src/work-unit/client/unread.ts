import { isRootSummary } from './presentation.js';
import type { WorkUnitId, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

type LedgerUnit = Pick<WorkUnitSummary, 'id' | 'role' | 'state' | 'turns'>;

export class UnreadLedger {
  readonly #counts = new Map<WorkUnitId, number>();
  readonly #lastState = new Map<WorkUnitId, WorkUnitPresentationState>();
  readonly #lastTurns = new Map<WorkUnitId, number>();

  sync(units: readonly LedgerUnit[], selectedId?: WorkUnitId | null): ReadonlyMap<string, number> {
    const present = new Set<WorkUnitId>();
    for (const unit of units) {
      if (!isRootSummary(unit)) continue;
      present.add(unit.id);
      const finished = this.#turnsFinished(unit);
      if (finished > 0 && unit.id !== selectedId) {
        this.#counts.set(unit.id, (this.#counts.get(unit.id) ?? 0) + finished);
      }
    }

    if (selectedId) this.#counts.delete(selectedId);

    for (const id of [...this.#counts.keys()]) if (!present.has(id)) this.#counts.delete(id);
    for (const id of [...this.#lastState.keys()]) if (!present.has(id)) this.#lastState.delete(id);
    for (const id of [...this.#lastTurns.keys()]) if (!present.has(id)) this.#lastTurns.delete(id);
    return this.counts();
  }

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

    this.#lastTurns.delete(unit.id);
    return seen && previousState === 'working' && unit.state !== 'working' ? 1 : 0;
  }

  counts(): ReadonlyMap<string, number> {
    return new Map(this.#counts);
  }
}
