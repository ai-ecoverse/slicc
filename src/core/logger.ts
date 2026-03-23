/**
 * Lightweight logging system with level filtering, namespaces,
 * and deduplication of repetitive messages.
 * Uses console methods directly for browser dev tools integration.
 */

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

let currentLevel: LogLevel = __DEV__ ? LogLevel.INFO : LogLevel.ERROR;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export interface Logger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

// No-op function — assigned once, shared across all prod loggers.
const noop = () => {};

// ---------------------------------------------------------------------------
// Log deduplication
// ---------------------------------------------------------------------------

/** How many recent fingerprints to track per logger. */
const DEDUP_BUFFER_SIZE = 10;

/** Suppress window: messages with the same fingerprint within this window are suppressed. */
const DEDUP_WINDOW_MS = 60_000; // 1 minute

interface DedupEntry {
  fingerprint: string;
  count: number;
  firstSeen: number;
  level: LogLevel;
  consoleFn: (...args: unknown[]) => void;
  prefix: string;
  message: string;
}

/**
 * Normalize a log message + data into a fingerprint for dedup comparison.
 * Replaces numbers, UUIDs, hex strings, and timestamps with placeholders
 * so that messages differing only in IDs/counts are considered duplicates.
 */
export function fingerprint(message: string, data: unknown[]): string {
  let raw = message;
  if (data.length > 0) {
    try {
      raw += ' ' + JSON.stringify(data);
    } catch {
      raw += ' [unserializable]';
    }
  }
  return (
    raw
      // UUIDs: 8-4-4-4-12 hex pattern
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      // Hex strings (8+ chars)
      .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
      // Timestamps (10+ digit numbers)
      .replace(/\b\d{10,}\b/g, '<ts>')
      // Remaining numbers (integers and floats)
      .replace(/\b\d+(\.\d+)?\b/g, '<n>')
  );
}

class DedupBuffer {
  private entries: DedupEntry[] = [];

  /**
   * Check if a message should be logged or suppressed.
   * Returns true if the message should be logged, false if suppressed.
   * When a suppressed entry expires (new different message comes in or window elapses),
   * a summary line is flushed.
   */
  log(
    consoleFn: (...args: unknown[]) => void,
    prefix: string,
    level: LogLevel,
    message: string,
    data: unknown[]
  ): boolean {
    const fp = fingerprint(message, data);
    const now = Date.now();

    // Evict stale entries and flush their counts
    this.evict(now);

    // Check for an existing matching entry
    const existing = this.entries.find((e) => e.fingerprint === fp && e.level === level);
    if (existing) {
      existing.count++;
      return false; // suppress
    }

    // New message — add to buffer
    if (this.entries.length >= DEDUP_BUFFER_SIZE) {
      // Evict oldest, flushing its count
      const evicted = this.entries.shift()!;
      this.flushEntry(evicted);
    }
    this.entries.push({
      fingerprint: fp,
      count: 0,
      firstSeen: now,
      level,
      consoleFn,
      prefix,
      message,
    });
    return true; // allow
  }

  /** Flush all pending suppression counts (e.g., on shutdown). */
  flush(): void {
    for (const entry of this.entries) {
      this.flushEntry(entry);
    }
    this.entries = [];
  }

  private evict(now: number): void {
    while (this.entries.length > 0 && now - this.entries[0].firstSeen > DEDUP_WINDOW_MS) {
      const evicted = this.entries.shift()!;
      this.flushEntry(evicted);
    }
  }

  private flushEntry(entry: DedupEntry): void {
    if (entry.count > 0 && currentLevel <= entry.level) {
      entry.consoleFn(entry.prefix, `(suppressed ${entry.count} similar: "${entry.message}")`);
    }
  }
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  const dedup = new DedupBuffer();

  function makeMethod(level: LogLevel) {
    return (message: string, ...data: unknown[]) => {
      if (currentLevel > level) return;
      const consoleFn =
        level === LogLevel.DEBUG
          ? console.debug
          : level === LogLevel.INFO
            ? console.info
            : level === LogLevel.WARN
              ? console.warn
              : console.error;

      if (dedup.log(consoleFn, prefix, level, message, data)) {
        consoleFn(prefix, message, ...data);
      }
    };
  }

  return {
    debug: makeMethod(LogLevel.DEBUG),
    info: makeMethod(LogLevel.INFO),
    warn: makeMethod(LogLevel.WARN),
    error: makeMethod(LogLevel.ERROR),
  };
}
