/**
 * Rolling sample buffer behind the monitor's sparklines.
 *
 * The monitor is a "live" panel with no time axis anywhere in its data: every
 * source it reads (`getSessionStats`, the scoop list, `/proc/table`) answers
 * "right now" and nothing records what "a minute ago" looked like. A
 * sparkline needs a series, so something has to keep one.
 *
 * This is deliberately the smallest thing that can: an in-memory buffer fed by
 * the panel's own 5s refresh, bounded by a fixed TIME window rather than by a
 * sample count. The window is what makes two glances a minute apart
 * comparable — samples are placed on the x axis by timestamp, so a pause in
 * the cadence (panel closed, tab backgrounded and its timers throttled) shows
 * as a gap instead of being drawn as if it never happened, and a buffer that
 * only covers forty seconds draws forty seconds' worth of trace rather than
 * stretching it across the whole tile.
 *
 * Consequences, stated rather than hidden:
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

import type { MonitorSeries } from '@slicc/webcomponents';

/**
 * How far back the sparklines reach. One hour: long enough that the panel can
 * say "the burn rate has been climbing since I opened it" and mean something,
 * short enough that a 5s cadence fits in ~720 samples.
 */
export const MONITOR_HISTORY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Hard cap on retained samples, as a memory bound rather than a policy.
 *
 * Eviction is by AGE — this only stops a pathologically fast feeder (a
 * caller ticking far below the panel's 5s cadence) from growing the buffer
 * without limit. At the panel's cadence the window fills at ~720 samples, so
 * this never binds in normal use.
 */
export const MONITOR_HISTORY_CAPACITY = 2_000;

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
 * A time-bounded, append-only series of monitor samples.
 *
 * Not a class with a persisted identity — the workbench owns one instance for
 * as long as the panel wiring lives, and tests make their own.
 */
export class MonitorHistory {
  readonly #samples: MonitorSample[] = [];
  readonly #windowMs: number;
  readonly #capacity: number;

  constructor(
    windowMs: number = MONITOR_HISTORY_WINDOW_MS,
    capacity: number = MONITOR_HISTORY_CAPACITY
  ) {
    // A zero/negative window would evict every sample the moment it lands and
    // leave every series empty, which reads as "the metric is broken" rather
    // than "the buffer is misconfigured". Refuse it instead.
    this.#windowMs = Math.max(1, Math.floor(windowMs));
    // Likewise a capacity below 2 can never satisfy `series()`.
    this.#capacity = Math.max(2, Math.floor(capacity));
  }

  /** The span the sparklines plot into, in ms. */
  get windowMs(): number {
    return this.#windowMs;
  }

  /**
   * Append a sample, dropping everything that has fallen out of the window.
   *
   * Age is measured against the NEWEST sample rather than `Date.now()` so the
   * buffer stays a pure function of what was pushed into it: a test can push
   * a synthetic timeline, and a reader that stops for an hour and resumes
   * doesn't have its whole history vanish between two ticks of the same
   * refresh.
   */
  push(sample: MonitorSample): void {
    this.#samples.push(sample);
    const cutoff = sample.at - this.#windowMs;
    while (this.#samples.length > 0 && this.#samples[0].at < cutoff) this.#samples.shift();
    while (this.#samples.length > this.#capacity) this.#samples.shift();
  }

  /** How many samples are held. */
  get size(): number {
    return this.#samples.length;
  }

  /**
   * One metric as a plottable series — values WITH their timestamps, plus the
   * window they are drawn in, which is what lets the component place them by
   * elapsed time instead of by index.
   *
   * Returns `undefined` below two points, which is exactly the input a
   * sparkline can't plot — so callers can hand the result straight to
   * `MonitorVital.series`.
   */
  series(key: SeriesKey): MonitorSeries | undefined {
    if (this.#samples.length < 2) return undefined;
    return {
      points: this.#samples.map((sample) => ({ at: sample.at, value: sample[key] })),
      windowMs: this.#windowMs,
    };
  }

  /** The largest value of one metric, or `null` when there are no samples. */
  peak(key: SeriesKey): number | null {
    if (this.#samples.length === 0) return null;
    return this.#samples.reduce((max, s) => Math.max(max, s[key]), Number.NEGATIVE_INFINITY);
  }

  /**
   * How far back the buffer actually reaches, as display copy — `last 45s`,
   * `last 4m`, `last 2h`. `null` below two samples, matching {@link series}.
   *
   * This reports the real span rather than the nominal window on purpose:
   * a panel opened twenty seconds ago has twenty seconds of history, and
   * labelling that "last hour" would be a lie told by a chart. The plot agrees
   * with it — a short history draws a short trace.
   */
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
