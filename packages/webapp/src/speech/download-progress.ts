export interface DownloadSnapshot {
  loaded: number;

  total: number;

  etaSeconds: number | null;
}

export interface DownloadTracker {
  update(file: string, loaded: number, total: number): void;

  complete(file: string): void;

  snapshot(): DownloadSnapshot;
}

const MIN_RATE_WINDOW_MS = 1000;

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
