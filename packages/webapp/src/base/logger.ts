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

const _noop = () => {};

const DEDUP_BUFFER_SIZE = 10;

const DEDUP_WINDOW_MS = 60_000;

interface DedupEntry {
  fingerprint: string;
  count: number;
  firstSeen: number;
  level: LogLevel;
  consoleFn: (...args: unknown[]) => void;
  prefix: string;
  message: string;
}

export function fingerprint(message: string, data: unknown[]): string {
  let raw = message;
  if (data.length > 0) {
    try {
      raw += ' ' + JSON.stringify(data);
    } catch {
      raw += ' [unserializable]';
    }
  }
  return raw

    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')

    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')

    .replace(/\b\d{10,}\b/g, '<ts>')

    .replace(/\b\d+(\.\d+)?\b/g, '<n>');
}

class DedupBuffer {
  private entries: DedupEntry[] = [];

  log(
    consoleFn: (...args: unknown[]) => void,
    prefix: string,
    level: LogLevel,
    message: string,
    data: unknown[]
  ): boolean {
    const fp = fingerprint(message, data);
    const now = Date.now();

    this.evict(now);

    const existing = this.entries.find((e) => e.fingerprint === fp && e.level === level);
    if (existing) {
      existing.count++;
      return false;
    }

    if (this.entries.length >= DEDUP_BUFFER_SIZE) {
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
    return true;
  }

  flush(): void {
    for (const entry of this.entries) {
      this.flushEntry(entry);
    }
    this.entries = [];
  }

  clear(): void {
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

const allDedupBuffers = new Set<DedupBuffer>();

export function resetLoggerDedupForTests(): void {
  for (const buf of allDedupBuffers) {
    buf.clear();
  }
}

export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  const dedup = new DedupBuffer();
  allDedupBuffers.add(dedup);

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
