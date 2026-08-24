/**
 * Rolling sample buffer behind the monitor's sparklines.
 *
 * The monitor is a "live" panel with no time axis anywhere in its data: every
 * source it reads (`getSessionStats`, the scoop list, `/proc/table`) answers
 * "right now" and nothing records what "a minute ago" looked like. A
 * sparkline needs a series, so something has to keep one.
 *
 * This is deliberately the smallest thing that can: an in-memory ring buffer
 * fed by the panel's own 5s refresh. Consequences, stated rather than hidden:
 *
 *   - History starts when the panel opens and stops when it closes, because
 *     that is when the refresh runs (`wc-workbench.ts`). It is not a
 *     session-wide recorder and must not pretend to be — {@link windowLabel}
 *     reports the span the samples ACTUALLY cover, so a 40-second-old buffer
 *     says "last 40s" rather than claiming an hour.
 *   - Nothing is persisted. A reload starts over. Persisting it would mean
 *     writing to storage on a 5s timer for a decoration.
 *   - A series with fewer than two points renders no sparkline at all
 *     (the component's rule), so the first tick is simply plotless.
 */

/** How many samples to keep. At the panel's 5s cadence this is ~5 minutes. */
export const MONITOR_HISTORY_CAPACITY = 60;

/** One reading of the metrics the vitals tiles plot. */
export interface MonitorSample {
  /** `Date.now()` when the sample was taken. */
  at: number;
  /** Blended spend rate in USD/hour. */
  burnRate: number;
  /** How many work units were mid-turn. */
  workingUnits: number;
  /** How many kernel processes were live. */
  liveProcesses: number;
}

type SeriesKey = 'burnRate' | 'workingUnits' | 'liveProcesses';

/**
 * A bounded, append-only series of monitor samples.
 *
 * Not a class with a persisted identity — the workbench owns one instance for
 * as long as the panel wiring lives, and tests make their own.
 */
export class MonitorHistory {
  readonly #samples: MonitorSample[] = [];
  readonly #capacity: number;

  constructor(capacity: number = MONITOR_HISTORY_CAPACITY) {
    // A zero/negative capacity would make `push` a no-op and every series
    // empty, which reads as "the metric is broken" rather than "the buffer
    // is misconfigured". Refuse it instead.
    this.#capacity = Math.max(2, Math.floor(capacity));
  }

  /** Append a sample, evicting the oldest once the buffer is full. */
  push(sample: MonitorSample): void {
    this.#samples.push(sample);
    while (this.#samples.length > this.#capacity) this.#samples.shift();
  }

  /** How many samples are held. */
  get size(): number {
    return this.#samples.length;
  }

  /**
   * The values of one metric, oldest first. Returns `undefined` below two
   * points, which is exactly the input a sparkline can't plot — so callers
   * can hand the result straight to `MonitorVital.series`.
   */
  series(key: SeriesKey): number[] | undefined {
    if (this.#samples.length < 2) return undefined;
    return this.#samples.map((sample) => sample[key]);
  }

  /** The largest value of one metric, or `null` when there are no samples. */
  peak(key: SeriesKey): number | null {
    if (this.#samples.length === 0) return null;
    return this.#samples.reduce((max, s) => Math.max(max, s[key]), Number.NEGATIVE_INFINITY);
  }

  /**
   * How far back the buffer actually reaches, as display copy — `last 45s`,
   * `last 4m`. `null` below two samples, matching {@link series}.
   *
   * This reports the real span rather than the nominal capacity on purpose:
   * a panel opened twenty seconds ago has twenty seconds of history, and
   * labelling that "last 5 minutes" would be a lie told by a chart.
   */
  windowLabel(): string | null {
    if (this.#samples.length < 2) return null;
    const spanMs = this.#samples[this.#samples.length - 1].at - this.#samples[0].at;
    const seconds = Math.max(1, Math.round(spanMs / 1000));
    if (seconds < 90) return `last ${seconds}s`;
    return `last ${Math.round(seconds / 60)}m`;
  }
}
