/**
 * Lightweight logging system with level filtering and namespaces.
 * Uses console methods directly for browser dev tools integration.
 */

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

let currentLevel: LogLevel = __DEV__ ? LogLevel.DEBUG : LogLevel.ERROR;

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

export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;

  return {
    get debug() {
      return currentLevel <= LogLevel.DEBUG
        ? console.debug.bind(console, prefix)
        : noop;
    },
    get info() {
      return currentLevel <= LogLevel.INFO
        ? console.info.bind(console, prefix)
        : noop;
    },
    get warn() {
      return currentLevel <= LogLevel.WARN
        ? console.warn.bind(console, prefix)
        : noop;
    },
    get error() {
      return currentLevel <= LogLevel.ERROR
        ? console.error.bind(console, prefix)
        : noop;
    },
  };
}
