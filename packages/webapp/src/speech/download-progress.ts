/**
 * Pure aggregation of a multi-file model download into one progress + ETA
 * snapshot. transformers.js reports per-file `progress` events (encoder,
 * decoder, tokenizer, …) with independent `loaded`/`total` counters; the
 * composer's status line wants a single "ready in ~ETA" number. Kept free of
 * I/O and clocks (injectable `now`) so the math is unit-testable.
 */

export interface DownloadSnapshot {
  /** Bytes fetched so far across all files seen. */
  loaded: number;
  /** Bytes expected across all files seen (grows as files announce). */
  total: number;
  /** Estimated seconds until done, or null while the rate is unknown. */
  etaSeconds: number | null;
}

export interface DownloadTracker {
  /** Record a per-file progress sample. */
  update(file: string, loaded: number, total: number): void;
  /** Mark a file finished (its `loaded` snaps to its `total`). */
  complete(file: string): void;
  /** The aggregated snapshot for the UI. */
  snapshot(): DownloadSnapshot;
}

/** Don't trust a rate computed from less than this much wall time. */
const MIN_RATE_WINDOW_MS = 1000;

/**
 * Create a tracker. The ETA uses the overall average rate since the first
 * sample — coarse but stable, and self-correcting as the download proceeds.
 */
export function createDownloadTracker(now: () => number = () => Date.now()): DownloadTracker {
  const files = new Map<string, { loaded: number; total: number }>();
  let startedAt: number | null = null;
  let startedLoaded = 0;

  const totals = () => {
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { loaded, total };
  };

  return {
    update(file, loaded, total) {
      files.set(file, {
        loaded: Math.max(0, loaded),
        // Some events omit/lag `total` — keep the largest figure seen.
        total: Math.max(files.get(file)?.total ?? 0, total, loaded),
      });
      if (startedAt === null) {
        startedAt = now();
        startedLoaded = totals().loaded;
      }
    },

    complete(file) {
      const entry = files.get(file);
      if (entry) entry.loaded = entry.total;
    },

    snapshot() {
      const { loaded, total } = totals();
      let etaSeconds: number | null = null;
      if (startedAt !== null && total > 0 && loaded < total) {
        const elapsedMs = now() - startedAt;
        const gained = loaded - startedLoaded;
        if (elapsedMs >= MIN_RATE_WINDOW_MS && gained > 0) {
          const bytesPerMs = gained / elapsedMs;
          etaSeconds = (total - loaded) / bytesPerMs / 1000;
        }
      }
      if (total > 0 && loaded >= total) etaSeconds = 0;
      return { loaded, total, etaSeconds };
    },
  };
}
