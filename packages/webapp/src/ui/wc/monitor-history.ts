import type { MonitorSeries } from '@slicc/webcomponents';

export const MONITOR_HISTORY_WINDOW_MS = 60 * 60 * 1000;

export const MONITOR_HISTORY_CAPACITY = 2_000;

export interface MonitorSample {
  at: number;

  burnRate: number;

  workingUnits: number;

  liveProcesses: number;
}

type SeriesKey = 'burnRate' | 'workingUnits' | 'liveProcesses';

export class MonitorHistory {
  readonly #samples: MonitorSample[] = [];
  readonly #windowMs: number;
  readonly #capacity: number;

  constructor(
    windowMs: number = MONITOR_HISTORY_WINDOW_MS,
    capacity: number = MONITOR_HISTORY_CAPACITY
  ) {
    this.#windowMs = Math.max(1, Math.floor(windowMs));

    this.#capacity = Math.max(2, Math.floor(capacity));
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  push(sample: MonitorSample): void {
    this.#samples.push(sample);
    const cutoff = sample.at - this.#windowMs;
    while (this.#samples.length > 0 && this.#samples[0].at < cutoff) this.#samples.shift();
    while (this.#samples.length > this.#capacity) this.#samples.shift();
  }

  get size(): number {
    return this.#samples.length;
  }

  series(key: SeriesKey): MonitorSeries | undefined {
    if (this.#samples.length < 2) return undefined;
    return {
      points: this.#samples.map((sample) => ({ at: sample.at, value: sample[key] })),
      windowMs: this.#windowMs,
    };
  }

  peak(key: SeriesKey): number | null {
    if (this.#samples.length === 0) return null;
    return this.#samples.reduce((max, s) => Math.max(max, s[key]), Number.NEGATIVE_INFINITY);
  }

  windowLabel(): string | null {
    if (this.#samples.length < 2) return null;
    const spanMs = this.#samples[this.#samples.length - 1].at - this.#samples[0].at;
    const seconds = Math.max(1, Math.round(spanMs / 1000));
    if (seconds < 90) return `last ${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `last ${minutes}m`;
    return `last ${Math.round(minutes / 60)}h`;
  }
}
