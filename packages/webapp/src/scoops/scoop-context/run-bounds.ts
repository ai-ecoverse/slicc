import type { ScoopConfig } from '../types.js';

export interface RunBoundsDeps {
  getConfig: () => ScoopConfig | undefined;
  isDisposed: () => boolean;

  onTripped: () => void;
}

export class RunBounds {
  private turnCount = 0;
  private exceededNote: string | null = null;
  private wallClockTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RunBoundsDeps) {}

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

  recordCompletedTurn(): void {
    this.turnCount += 1;
  }

  enforceOnTurnStart(): void {
    const maxTurns = this.deps.getConfig()?.maxTurns;
    if (typeof maxTurns === 'number' && maxTurns > 0 && this.turnCount >= maxTurns) {
      this.trip(`turn bound (${maxTurns}) exceeded`);
    }
  }

  disarm(): void {
    if (this.wallClockTimer !== null) {
      clearTimeout(this.wallClockTimer);
      this.wallClockTimer = null;
    }
  }

  takeExceededNote(): string | null {
    const note = this.exceededNote;
    this.exceededNote = null;
    return note;
  }

  private trip(note: string): void {
    if (this.exceededNote !== null || this.deps.isDisposed()) return;
    this.exceededNote = note;
    this.deps.onTripped();
  }
}
