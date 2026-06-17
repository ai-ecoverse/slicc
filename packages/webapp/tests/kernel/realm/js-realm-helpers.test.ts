/**
 * Tests for the pure-JS runtime helpers (`parseFlags`, `cli`, `c`,
 * `time`, `fmt`, `pool`) exposed inside the `.jsh` realm.
 *
 * The helpers are kernel-side; we exercise them directly without
 * booting a worker. A separate parity check ensures the sandbox.html
 * mirror surfaces stay in lockstep with this canonical TS module.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  attachArgvParseFlags,
  createCli,
  createColor,
  fmt,
  parseFlags,
  pool,
  time,
} from '../../../src/kernel/realm/js-realm-helpers.js';

describe('parseFlags', () => {
  it('splits positional / flags from argv (skipping argv[0..1])', () => {
    const out = parseFlags(['node', 'script.jsh', 'pos1', '--flag=val', 'pos2']);
    expect(out.positional).toEqual(['pos1', 'pos2']);
    expect(out.flags).toEqual({ flag: 'val' });
    expect(out.passthrough).toEqual([]);
  });

  it('handles `--flag value` (space-separated) and `--flag` (boolean)', () => {
    const out = parseFlags(['node', 's', '--name', 'alice', '--verbose']);
    expect(out.flags).toEqual({ name: 'alice', verbose: true });
  });

  it('promotes repeated flags to an array, preserving order', () => {
    const out = parseFlags(['node', 's', '--tag', 'a', '--tag=b', '--tag', 'c']);
    expect(out.flags.tag).toEqual(['a', 'b', 'c']);
  });

  it('routes args after `--` to passthrough verbatim', () => {
    const out = parseFlags(['node', 's', '--mode', 'fast', '--', '--not-a-flag', 'raw']);
    expect(out.flags).toEqual({ mode: 'fast' });
    expect(out.passthrough).toEqual(['--not-a-flag', 'raw']);
  });

  it('treats short flags as booleans, splitting `-abc` into a/b/c', () => {
    const out = parseFlags(['node', 's', '-abc']);
    expect(out.flags).toEqual({ a: true, b: true, c: true });
  });

  it('extracts subcommand from leading positional when it looks like a word', () => {
    expect(parseFlags(['node', 's', 'list', '--json']).subcommand).toBe('list');
    expect(parseFlags(['node', 's', '--json']).subcommand).toBeNull();
    expect(parseFlags(['node', 's', '/abs/path']).subcommand).toBeNull();
  });
});

describe('attachArgvParseFlags', () => {
  it('exposes a non-enumerable parseFlags method on a fresh copy', () => {
    const original = ['node', 'foo.jsh', 'pos', '--x=1'];
    const attached = attachArgvParseFlags(original) as string[] & { parseFlags: () => unknown };
    expect(attached).not.toBe(original);
    expect([...attached]).toEqual(original);
    expect(Object.keys(attached)).toEqual(['0', '1', '2', '3']);
    expect(JSON.stringify(attached)).toBe(JSON.stringify(original));
    const parsed = attached.parseFlags() as {
      positional: string[];
      flags: Record<string, unknown>;
    };
    expect(parsed.positional).toEqual(['pos']);
    expect(parsed.flags).toEqual({ x: '1' });
  });
});

describe('createColor', () => {
  it('emits ANSI when isTTY=true and NO_COLOR is unset', () => {
    const c = createColor({ isTTY: true, noColor: false });
    expect(c.enabled).toBe(true);
    expect(c.red('x')).toBe('\u001b[31mx\u001b[0m');
    expect(c.green('y')).toBe('\u001b[32my\u001b[0m');
  });

  it('passes strings through unchanged when disabled', () => {
    const c = createColor({ isTTY: false, noColor: false });
    expect(c.enabled).toBe(false);
    expect(c.red('x')).toBe('x');
    const c2 = createColor({ isTTY: true, noColor: true });
    expect(c2.red('x')).toBe('x');
  });
});

describe('createCli', () => {
  function makeCli(opts: { isTTY?: boolean } = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit_${code}`);
    });
    const cli = createCli({
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      exit: exit as unknown as (code: number) => never,
      color: createColor({ isTTY: opts.isTTY ?? false, noColor: false }),
    });
    return { cli, stdout, stderr, exit };
  }

  it('die() writes Error: prefix to stderr and calls exit(1) by default', () => {
    const { cli, stdout, stderr, exit } = makeCli();
    expect(() => cli.die('boom')).toThrow('__exit_1');
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Error:');
    expect(stderr.join('')).toContain('boom');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('die() honors a custom exit code and unwraps Error messages', () => {
    const { cli, exit } = makeCli();
    expect(() => cli.die(new Error('nope'), 42)).toThrow('__exit_42');
    expect(exit).toHaveBeenCalledWith(42);
  });

  it('die({ prefix }) replaces the default Error: label', () => {
    const { cli, stderr } = makeCli();
    expect(() => cli.die('boom', { prefix: 'FATAL' })).toThrow('__exit_1');
    expect(stderr.join('')).toContain('FATAL:');
    expect(stderr.join('')).not.toContain('Error:');
  });

  it('die({ prefix: "" }) suppresses the label entirely', () => {
    const { cli, stderr } = makeCli();
    expect(() => cli.die('plain', { prefix: '' })).toThrow('__exit_1');
    expect(stderr.join('')).not.toContain(':');
    expect(stderr.join('')).toContain('plain');
  });

  it('die({ exitCode, prefix }) uses both', () => {
    const { cli, exit } = makeCli();
    expect(() => cli.die('x', { exitCode: 7, prefix: 'FATAL' })).toThrow('__exit_7');
    expect(exit).toHaveBeenCalledWith(7);
  });

  it('warn({ prefix }) replaces the default Warning: label', () => {
    const { cli, stderr } = makeCli();
    cli.warn('careful', { prefix: 'NOTICE' });
    expect(stderr.join('')).toContain('NOTICE:');
    expect(stderr.join('')).not.toContain('Warning:');
  });

  it('warn({ prefix: "" }) suppresses the label entirely', () => {
    const { cli, stderr } = makeCli();
    cli.warn('plain', { prefix: '' });
    expect(stderr.join('')).not.toContain(':');
    expect(stderr.join('')).toContain('plain');
  });

  it('out(string) ensures a trailing newline; out(object) pretty-prints JSON', () => {
    const { cli, stdout } = makeCli();
    cli.out('hi');
    cli.out('hi\n');
    cli.out({ a: 1 });
    expect(stdout).toEqual(['hi\n', 'hi\n', '{\n  "a": 1\n}\n']);
  });

  it('warn() writes Warning: prefix to stderr without exiting', () => {
    const { cli, stderr } = makeCli();
    cli.warn('careful');
    expect(stderr.join('')).toContain('Warning:');
    expect(stderr.join('')).toContain('careful');
  });

  it('help() writes text to stdout then exit(0)', () => {
    const { cli, stdout, exit } = makeCli();
    expect(() => cli.help('Usage: foo')).toThrow('__exit_0');
    expect(stdout.join('')).toBe('Usage: foo\n');
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('time', () => {
  it('parseDuration recognizes ms|s|m|h|d|w|M|y and bare numbers', () => {
    expect(time.parseDuration('1ms')).toBe(1);
    expect(time.parseDuration('1s')).toBe(1000);
    expect(time.parseDuration('2m')).toBe(120_000);
    expect(time.parseDuration('1h')).toBe(3_600_000);
    expect(time.parseDuration('7d')).toBe(604_800_000);
    expect(time.parseDuration('2w')).toBe(1_209_600_000);
    expect(time.parseDuration('1M')).toBe(2_629_800_000);
    expect(time.parseDuration('1y')).toBe(31_557_600_000);
    expect(time.parseDuration('500')).toBe(500);
    expect(time.parseDuration(1234)).toBe(1234);
  });

  it('parseDuration throws on garbage', () => {
    expect(() => time.parseDuration('seven days')).toThrow(/unrecognized/);
    expect(() => time.parseDuration({} as unknown as string)).toThrow(TypeError);
  });

  it('ago / range / future are anchored to the `from` argument', () => {
    const from = new Date('2026-05-28T12:00:00.000Z');
    expect(time.ago('1h', from).toISOString()).toBe('2026-05-28T11:00:00.000Z');
    const r = time.range('1h', from);
    expect(r.start.toISOString()).toBe('2026-05-28T11:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-05-28T12:00:00.000Z');
    const f = time.future('1h', from);
    expect(f.start.toISOString()).toBe('2026-05-28T12:00:00.000Z');
    expect(f.end.toISOString()).toBe('2026-05-28T13:00:00.000Z');
  });

  it('gmailDate formats YYYY/MM/DD relative to `from`', () => {
    const from = new Date('2026-05-28T12:00:00.000Z');
    // Pick a UTC-stable duration so the test is timezone-agnostic-ish.
    const out = time.gmailDate('0ms', from);
    expect(out).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });
});

describe('fmt', () => {
  it('trunc shortens with an ellipsis when over budget', () => {
    expect(fmt.trunc('hello', 10)).toBe('hello');
    expect(fmt.trunc('hello world', 8)).toBe('hello w…');
    expect(fmt.trunc('hello', 0)).toBe('');
  });

  it('col pads or truncates to width, ANSI-aware', () => {
    expect(fmt.col('hi', 5)).toBe('hi   ');
    expect(fmt.col('hello world', 5)).toBe('hell…');
    const colored = '\u001b[31mhi\u001b[0m';
    expect(fmt.col(colored, 5)).toBe(colored + '   ');
  });

  it('table auto-sizes columns by visible width', () => {
    const out = fmt.table([
      ['a', 'longer'],
      ['cc', 'b'],
    ]);
    expect(out).toBe('a   longer\ncc  b');
  });

  it('date renders short / iso / human styles', () => {
    const d = new Date('2026-05-28T12:34:56.000Z');
    expect(fmt.date(d, 'iso')).toBe('2026-05-28T12:34:56.000Z');
    expect(fmt.date(d, 'short')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 'human' is relative-to-now; just assert it stays a string.
    expect(typeof fmt.date(d, 'human')).toBe('string');
  });

  it("date('locale') uses Intl.DateTimeFormat medium style", () => {
    const d = new Date('2026-05-28T12:34:56.000Z');
    const out = fmt.date(d, 'locale');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // Should match what Intl would have produced for the same input.
    expect(out).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d));
  });
});

describe('pool', () => {
  it('runs functions concurrently, capped to n, preserving input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool(3, [10, 20, 30, 40, 50, 60], async (item) => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return item * 2;
    });
    expect(out).toEqual([20, 40, 60, 80, 100, 120]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it('coerces n<1 to 1', async () => {
    const out = await pool(0, [1, 2, 3], async (x) => x);
    expect(out).toEqual([1, 2, 3]);
  });

  it('returns [] for empty input', async () => {
    const out = await pool(4, [], async (x) => x);
    expect(out).toEqual([]);
  });
});

describe('sandbox.html mirror parity', () => {
  // Single source of truth for the sandbox bootstrap. The TS surface
  // is the canonical implementation; this test pins that the sandbox
  // bootstrap script keeps a matching surface area (parity with
  // js-realm-helpers.ts) so the extension float doesn't silently
  // diverge from the worker float.
  it('inlines every helper surface that the TS module exports', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const sandbox = readFileSync(
      resolve(repoRoot, 'packages/chrome-extension/sandbox.html'),
      'utf-8'
    );
    // Capability bridges are now wired into the `sliccy:` registry
    // (not the AsyncFunction param list). Each name MUST appear as a
    // quoted key on `sliccyModules` so `require('sliccy:<name>')`
    // resolves in lockstep with the worker realm.
    for (const id of [
      'exec',
      'skill',
      'http',
      'browser',
      'usb',
      'serial',
      'hid',
      'cli',
      'color',
      'time',
      'fmt',
      'pool',
    ]) {
      expect(sandbox).toContain(`sliccyModules['${id}']`);
    }
    // The `sliccy:` scheme + a scheme-specific error path are present.
    expect(sandbox).toContain("startsWith('sliccy:')");
    expect(sandbox).toContain('empty sliccy: module name');
    expect(sandbox).toContain('unknown sliccy: module');
    // The bespoke globals are NOT in the AsyncFunction param list.
    // Capture the param list (between AsyncFunction(' and the `"use
    // strict"`) and assert each removed name is absent. Keeping the
    // grep here pins that the hard-cut isn't silently reverted in
    // the iframe mirror while the worker float gets it right.
    const paramList = sandbox.match(/new AsyncFunction\(([\s\S]*?)'"use strict";\\n'/);
    expect(paramList, 'expected AsyncFunction(...) param list block').not.toBeNull();
    const params = paramList![1];
    for (const removed of [
      "'fs'",
      "'exec'",
      "'skill'",
      "'http'",
      "'browser'",
      "'usb'",
      "'serial'",
      "'hid'",
      "'cli'",
      "'c'",
      "'time'",
      "'fmt'",
      "'pool'",
    ]) {
      expect(params).not.toContain(removed);
    }
    // CJS scope vars + Node-standard surface stay bare.
    for (const kept of [
      "'process'",
      "'console'",
      "'require'",
      "'module'",
      "'exports'",
      "'fetch'",
      "'__dirname'",
      "'__filename'",
    ]) {
      expect(params).toContain(kept);
    }
    // Symbols whose presence we want pinned so a refactor removing
    // them in one file but not the other fails noisily.
    for (const needle of [
      'parseFlags',
      'attachArgvParseFlagsImpl',
      'gmailDate',
      'parseDuration',
      'NO_COLOR',
      // usb / serial / hid device-bridge surfaces (parity with the
      // createUsbBridge / createSerialBridge / createHidBridge factories).
      'makeUsbDevice',
      'makeSerialPort',
      'makeHidDevice',
      'transferIn',
      'controlTransferOut',
      'sendReport',
      'receiveFeatureReport',
      'getSignals',
      'bytesToDataView',
      'asFilterArray',
    ]) {
      expect(sandbox).toContain(needle);
    }
  });

  it('has no AsyncFunction("fs" / bare-fs injection anywhere and no top-level fs global', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const sandbox = readFileSync(
      resolve(repoRoot, 'packages/chrome-extension/sandbox.html'),
      'utf-8'
    );
    // No AsyncFunction constructor call injects 'fs' as a parameter
    // anywhere in the file (catches both the main runRealm path and any
    // legacy one-off exec handler).
    expect(sandbox).not.toMatch(/AsyncFunction\s*\(\s*['"]`?fs['"]`?/);
    // No top-level const/var/let `fs` object exposes a bare fs global
    // to user code (the VFS bridge must be reachable ONLY via
    // require('fs') / require('node:fs') through the realm-port fsBridge).
    expect(sandbox).not.toMatch(/\b(?:const|let|var)\s+fs\s*=/);
  });

  it('ships the buffer polyfill so the iframe float matches worker Buffer availability', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const sandbox = readFileSync(
      resolve(repoRoot, 'packages/chrome-extension/sandbox.html'),
      'utf-8'
    );
    const shared = readFileSync(
      resolve(repoRoot, 'packages/webapp/src/kernel/realm/js-realm-shared.ts'),
      'utf-8'
    );
    // The standalone worker float pulls in the polyfill at module load
    // so `globalThis.Buffer` is populated before user code runs.
    expect(shared).toMatch(/import\s+['"][^'"]*buffer-polyfill[^'"]*['"]/);
    // The extension float ships the compiled polyfill as a bundled
    // <script> asset loaded BEFORE the realm bootstrap inline <script>
    // (so the iframe's globalThis.Buffer is set before runRealm runs).
    expect(sandbox).toMatch(/<script\s+src=["']buffer-polyfill\.js["']\s*>\s*<\/script>/);
    const polyfillIdx = sandbox.search(
      /<script\s+src=["']buffer-polyfill\.js["']\s*>\s*<\/script>/
    );
    const realmInlineIdx = sandbox.indexOf('function bootstrapRealmPort');
    expect(polyfillIdx).toBeGreaterThanOrEqual(0);
    expect(realmInlineIdx).toBeGreaterThan(polyfillIdx);
    // require('buffer') / require('node:buffer') in both floats reads
    // through globalThis.Buffer — pin that the resolver did not get
    // replaced with the legacy `Buffer: undefined` placeholder.
    expect(shared).toMatch(/bareId\s*===\s*'buffer'[\s\S]*?globalThis[\s\S]*?Buffer/);
    expect(sandbox).toMatch(/bareId\s*===\s*'buffer'[\s\S]*?globalThis\.Buffer/);
  });

  it('mirrors the Web Crypto-backed nodeCrypto bridge surface in both floats', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const sandbox = readFileSync(
      resolve(repoRoot, 'packages/chrome-extension/sandbox.html'),
      'utf-8'
    );
    const helpers = readFileSync(
      resolve(repoRoot, 'packages/webapp/src/kernel/realm/js-realm-helpers.ts'),
      'utf-8'
    );
    const shared = readFileSync(
      resolve(repoRoot, 'packages/webapp/src/kernel/realm/js-realm-shared.ts'),
      'utf-8'
    );
    // The crypto bridge surface must be present in BOTH the canonical TS helper
    // and the inline sandbox mirror so the iframe float matches the worker
    // float's `require('crypto')` capabilities.
    for (const needle of [
      'randomFillSync',
      'randomBytes',
      'randomUUID',
      'getRandomValues',
      'webcrypto',
      'subtle',
    ]) {
      expect(helpers, `js-realm-helpers.ts missing ${needle}`).toContain(needle);
      expect(sandbox, `sandbox.html missing ${needle}`).toContain(needle);
    }
    // Both floats route `crypto` / `node:crypto` (bareId strips the node:
    // prefix) to the bridge BEFORE the unavailable-builtin throw.
    expect(shared).toMatch(/bareId\s*===\s*'crypto'[\s\S]*?nodeCrypto/);
    expect(sandbox).toMatch(/bareId\s*===\s*'crypto'[\s\S]*?nodeCrypto/);
    // `crypto` is listed AVAILABLE in the sandbox inline mirror so its derived
    // NODE_BUILTINS_UNAVAILABLE no longer contains it.
    expect(sandbox).toMatch(/NODE_BUILTIN_AVAILABLE\s*=\s*new Set\(\[[^\]]*'crypto'/);
  });
});
