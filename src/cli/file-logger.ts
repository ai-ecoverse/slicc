import { mkdirSync, openSync, writeSync, closeSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LogLevel } from './runtime-flags.js';

// ---------------------------------------------------------------------------
// ANSI stripping
// ---------------------------------------------------------------------------

// Matches all ANSI escape sequences (CSI sequences, OSC, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[^[].?/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// Log level helpers
// ---------------------------------------------------------------------------

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(messageLevel: LogLevel, currentLevel: LogLevel): boolean {
  return LEVEL_PRIORITY[messageLevel] >= LEVEL_PRIORITY[currentLevel];
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString();
}

/** Generates a filename-safe ISO timestamp + PID string. */
export function generateLogFilename(): string {
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
  return `${ts}_${process.pid}.log`;
}

// ---------------------------------------------------------------------------
// Log cleanup — 7-day retention
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deletes log files older than `maxAgeMs` from the given directory.
 * Errors are logged to stderr but never thrown.
 */
export function cleanupOldLogs(logDir: string, maxAgeMs: number = SEVEN_DAYS_MS): void {
  try {
    const now = Date.now();
    const entries = readdirSync(logDir);
    for (const entry of entries) {
      if (!entry.endsWith('.log')) continue;
      try {
        const filePath = join(logDir, entry);
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch (err) {
        // Per-file errors are non-fatal
        console.error(`[file-logger] Failed to remove old log ${entry}:`, err);
      }
    }
  } catch (err) {
    // Directory read error is non-fatal
    console.error('[file-logger] Failed to scan logs directory for cleanup:', err);
  }
}

// ---------------------------------------------------------------------------
// FileLogger
// ---------------------------------------------------------------------------

export interface FileLoggerOptions {
  /** The directory for log files. Defaults to `~/.slicc/logs/`. */
  logDir?: string;
  /** Minimum level for log entries. Defaults to `'info'`. */
  logLevel?: LogLevel;
  /** When true, monkey-patches console to tee all output. */
  devMode?: boolean;
  /** Run 7-day cleanup on init. Defaults to true. */
  cleanup?: boolean;
}

export class FileLogger {
  readonly logDir: string;
  readonly logFile: string;
  private fd: number | null;
  private logLevel: LogLevel;
  private devMode: boolean;
  private origConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  } | null = null;

  constructor(options: FileLoggerOptions = {}) {
    this.logDir = options.logDir ?? join(homedir(), '.slicc', 'logs');
    this.logLevel = options.logLevel ?? 'info';
    this.devMode = options.devMode ?? false;

    // Ensure log directory exists
    mkdirSync(this.logDir, { recursive: true });

    // Run cleanup before creating the new log file
    if (options.cleanup !== false) {
      cleanupOldLogs(this.logDir);
    }

    // Open log file synchronously
    const filename = generateLogFilename();
    this.logFile = join(this.logDir, filename);
    this.fd = openSync(this.logFile, 'a');

    // Write header
    this.writeLine(`--- SLICC CLI log started at ${timestamp()} (PID ${process.pid}) ---`);

    // In dev mode, monkey-patch console to tee all output
    if (this.devMode) {
      this.installConsoleTee();
    }

    // Register shutdown handlers
    this.registerShutdownHandlers();
  }

  // -------------------------------------------------------------------------
  // Public API — structured logging for production mode
  // -------------------------------------------------------------------------

  /** Write a structured log entry. Respects log level filtering. */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level, this.logLevel)) return;
    const entry = data
      ? `${timestamp()} [${level.toUpperCase()}] ${message} ${JSON.stringify(data)}`
      : `${timestamp()} [${level.toUpperCase()}] ${message}`;
    this.writeLine(entry);
  }

  /** Flush and close the log file. Safe to call multiple times. */
  close(): void {
    this.deregisterShutdownHandlers();
    if (this.fd === null) return;
    this.writeLine(`--- SLICC CLI log ended at ${timestamp()} ---`);
    try { closeSync(this.fd); } catch { /* already closed */ }
    this.fd = null;
    this.restoreConsole();
  }

  // -------------------------------------------------------------------------
  // Dev mode — console tee
  // -------------------------------------------------------------------------

  private installConsoleTee(): void {
    this.origConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };

    const self = this;

    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = this.origConsole[method];
      const level = method === 'log' ? 'info' : method;

      console[method] = function (...args: unknown[]) {
        // Always call original — no change to stdout/stderr behavior
        original.apply(console, args);
        // Tee to file if level passes
        if (shouldLog(level as LogLevel, self.logLevel)) {
          const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
          self.writeLine(`${timestamp()} [${level.toUpperCase()}] ${stripAnsi(text)}`);
        }
      };
    }
  }

  private restoreConsole(): void {
    if (!this.origConsole) return;
    console.log = this.origConsole.log;
    console.info = this.origConsole.info;
    console.warn = this.origConsole.warn;
    console.error = this.origConsole.error;
    console.debug = this.origConsole.debug;
    this.origConsole = null;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private writeLine(line: string): void {
    if (this.fd === null) return;
    try { writeSync(this.fd, stripAnsi(line) + '\n'); } catch { /* fd may be invalid */ }
  }

  private onExit = () => { this.close(); };

  private registerShutdownHandlers(): void {
    process.once('SIGINT', this.onExit);
    process.once('SIGTERM', this.onExit);
    process.once('exit', this.onExit);
  }

  private deregisterShutdownHandlers(): void {
    process.removeListener('SIGINT', this.onExit);
    process.removeListener('SIGTERM', this.onExit);
    process.removeListener('exit', this.onExit);
  }
}
