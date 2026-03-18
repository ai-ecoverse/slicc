import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { stripAnsi, generateLogFilename, cleanupOldLogs, FileLogger } from './file-logger.js';

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe('stripAnsi', () => {
  it('removes basic color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('removes multi-param sequences', () => {
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
  });

  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('strips mixed ANSI in a realistic log line', () => {
    const input = '\x1b[32m200\x1b[0m GET /api/test 12ms';
    expect(stripAnsi(input)).toBe('200 GET /api/test 12ms');
  });
});

// ---------------------------------------------------------------------------
// generateLogFilename
// ---------------------------------------------------------------------------

describe('generateLogFilename', () => {
  it('contains PID and .log extension', () => {
    const name = generateLogFilename();
    expect(name).toContain(`_${process.pid}.log`);
  });

  it('does not contain colons (filename-safe)', () => {
    const name = generateLogFilename();
    expect(name).not.toContain(':');
  });

  it('ends with .log', () => {
    expect(generateLogFilename()).toMatch(/\.log$/);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldLogs
// ---------------------------------------------------------------------------

describe('cleanupOldLogs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `slicc-test-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes log files older than maxAgeMs', () => {
    const oldFile = join(tmpDir, 'old.log');
    writeFileSync(oldFile, 'old log content');
    // Set mtime to 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    const recentFile = join(tmpDir, 'recent.log');
    writeFileSync(recentFile, 'recent log content');

    cleanupOldLogs(tmpDir);

    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(true);
  });

  it('ignores non-.log files', () => {
    const txtFile = join(tmpDir, 'notes.txt');
    writeFileSync(txtFile, 'keep me');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(txtFile, eightDaysAgo, eightDaysAgo);

    cleanupOldLogs(tmpDir);

    expect(existsSync(txtFile)).toBe(true);
  });

  it('does not crash on a non-existent directory', () => {
    expect(() => cleanupOldLogs(join(tmpDir, 'does-not-exist'))).not.toThrow();
  });

  it('respects custom maxAgeMs', () => {
    const file = join(tmpDir, 'custom.log');
    writeFileSync(file, 'content');
    // Set mtime to 2 seconds ago
    const twoSecondsAgo = new Date(Date.now() - 2000);
    utimesSync(file, twoSecondsAgo, twoSecondsAgo);

    cleanupOldLogs(tmpDir, 1000); // 1s retention
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FileLogger
// ---------------------------------------------------------------------------

describe('FileLogger', () => {
  let tmpDir: string;
  let logger: FileLogger | null = null;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `slicc-test-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    logger?.close();
    logger = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the log directory and file', () => {
    logger = new FileLogger({ logDir: tmpDir, cleanup: false });
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(logger.logFile)).toBe(true);
  });

  it('writes a header line on creation', () => {
    logger = new FileLogger({ logDir: tmpDir, cleanup: false });
    logger.close();
    const content = readFileSync(logger.logFile, 'utf-8');
    expect(content).toContain('SLICC CLI log started');
    expect(content).toContain(`PID ${process.pid}`);
  });

  it('writes structured log entries via log()', () => {
    logger = new FileLogger({ logDir: tmpDir, logLevel: 'debug', cleanup: false });
    logger.log('info', 'server started', { port: 3000 });
    logger.log('error', 'something broke');
    logger.close();

    const content = readFileSync(logger.logFile, 'utf-8');
    expect(content).toContain('[INFO] server started');
    expect(content).toContain('"port":3000');
    expect(content).toContain('[ERROR] something broke');
  });

  it('filters by log level', () => {
    logger = new FileLogger({ logDir: tmpDir, logLevel: 'warn', cleanup: false });
    logger.log('debug', 'should not appear');
    logger.log('info', 'should not appear either');
    logger.log('warn', 'this should appear');
    logger.log('error', 'this too');
    logger.close();

    const content = readFileSync(logger.logFile, 'utf-8');
    expect(content).not.toContain('should not appear');
    expect(content).toContain('[WARN] this should appear');
    expect(content).toContain('[ERROR] this too');
  });

  it('strips ANSI codes from log entries', () => {
    logger = new FileLogger({ logDir: tmpDir, logLevel: 'debug', cleanup: false });
    logger.log('info', '\x1b[32m200\x1b[0m GET /test');
    logger.close();

    const content = readFileSync(logger.logFile, 'utf-8');
    expect(content).toContain('200 GET /test');
    expect(content).not.toContain('\x1b[');
  });

  it('writes a footer on close', () => {
    logger = new FileLogger({ logDir: tmpDir, cleanup: false });
    logger.close();
    const content = readFileSync(logger.logFile, 'utf-8');
    expect(content).toContain('SLICC CLI log ended');
  });

  it('close() is safe to call multiple times', () => {
    logger = new FileLogger({ logDir: tmpDir, cleanup: false });
    logger.close();
    expect(() => logger!.close()).not.toThrow();
  });

  it('runs cleanup on init by default', () => {
    mkdirSync(tmpDir, { recursive: true });
    const oldFile = join(tmpDir, 'old-session.log');
    writeFileSync(oldFile, 'old');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    logger = new FileLogger({ logDir: tmpDir });
    // Old file should have been cleaned up
    expect(existsSync(oldFile)).toBe(false);
    // New log file should exist
    expect(readdirSync(tmpDir).some((f) => f.endsWith('.log'))).toBe(true);
  });

  describe('dev mode (console tee)', () => {
    it('tees console.log to the log file', () => {
      // Save original before monkey-patching to verify it's restored later
      const origLog = console.log;
      logger = new FileLogger({ logDir: tmpDir, devMode: true, logLevel: 'debug', cleanup: false });

      expect(console.log).not.toBe(origLog); // Should be monkey-patched

      console.log('test message for tee');
      logger.close();

      // Console should be restored
      expect(console.log).toBe(origLog);

      const content = readFileSync(logger.logFile, 'utf-8');
      expect(content).toContain('test message for tee');
    });

    it('tees console.error to the log file', () => {
      logger = new FileLogger({ logDir: tmpDir, devMode: true, logLevel: 'debug', cleanup: false });
      console.error('error tee test');
      logger.close();

      const content = readFileSync(logger.logFile, 'utf-8');
      expect(content).toContain('error tee test');
      expect(content).toContain('[ERROR]');
    });

    it('strips ANSI from tee output', () => {
      logger = new FileLogger({ logDir: tmpDir, devMode: true, logLevel: 'debug', cleanup: false });
      console.log('\x1b[31mred text\x1b[0m');
      logger.close();

      const content = readFileSync(logger.logFile, 'utf-8');
      expect(content).toContain('red text');
      expect(content).not.toContain('\x1b[');
    });

    it('restores console methods on close', () => {
      const origLog = console.log;
      const origError = console.error;
      const origWarn = console.warn;
      const origInfo = console.info;
      const origDebug = console.debug;

      logger = new FileLogger({ logDir: tmpDir, devMode: true, cleanup: false });
      logger.close();

      expect(console.log).toBe(origLog);
      expect(console.error).toBe(origError);
      expect(console.warn).toBe(origWarn);
      expect(console.info).toBe(origInfo);
      expect(console.debug).toBe(origDebug);
    });
  });
});
