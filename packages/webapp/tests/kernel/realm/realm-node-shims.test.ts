/**
 * Direct tests for the realm `console` shim. The issue probe (#2981) is that
 * 15 of the 19 standard methods were missing, so `console.debug` /
 * `console.assert` threw TypeError instead of logging.
 */

import { describe, expect, it } from 'vitest';
import { createNodeConsole } from '../../../src/kernel/realm/realm-node-shims.js';

const STANDARD_CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'assert',
  'dir',
  'table',
  'group',
  'groupEnd',
  'groupCollapsed',
  'time',
  'timeEnd',
  'timeLog',
  'count',
  'countReset',
  'clear',
  'dirxml',
] as const;

function makeConsole() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const con = createNodeConsole(
    (value) => stdout.push(String(value)),
    (value) => stderr.push(String(value))
  );
  return {
    con,
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

describe('createNodeConsole', () => {
  it('exposes all 19 standard methods as functions (#2981)', () => {
    const { con } = makeConsole();
    const bag = con as unknown as Record<string, unknown>;
    const missing = STANDARD_CONSOLE_METHODS.filter((name) => typeof bag[name] !== 'function');
    expect(missing).toEqual([]);
  });

  it('debug writes to stdout and does not throw', () => {
    const { con, out, err } = makeConsole();
    expect(() => con.debug('x')).not.toThrow();
    expect(out()).toBe('x\n');
    expect(err()).toBe('');
  });

  it('assert(true) is a no-op; assert(false, "x") writes stderr and does not throw', () => {
    const { con, out, err } = makeConsole();
    expect(() => con.assert(true)).not.toThrow();
    expect(() => con.assert(true, 'ignored')).not.toThrow();
    expect(out()).toBe('');
    expect(err()).toBe('');

    expect(() => con.assert(false, 'x')).not.toThrow();
    expect(out()).toBe('');
    expect(err()).toBe('Assertion failed: x\n');
  });

  it('assert(false) with no args writes "Assertion failed" to stderr', () => {
    const { con, err } = makeConsole();
    expect(() => con.assert(false)).not.toThrow();
    expect(err()).toBe('Assertion failed\n');
  });

  it('dirxml and table alias log; dir inspects the object; clear is a no-op', () => {
    const { con, out, err } = makeConsole();
    con.dirxml('x');
    con.table({ a: 1 });
    con.dir({ b: 2 });
    con.clear();
    expect(out()).toBe('x\n{"a":1}\n{"b":2}\n');
    expect(err()).toBe('');
  });

  it('trace writes Trace: plus a stack to stderr', () => {
    const { con, out, err } = makeConsole();
    expect(() => con.trace('here')).not.toThrow();
    expect(out()).toBe('');
    const stderr = err();
    expect(stderr).toMatch(/^Trace: here\n/);
    const firstFrame = stderr.split('\n')[1] ?? '';
    expect(firstFrame).toContain('at ');
    expect(firstFrame).not.toMatch(/consoleTrace|createNodeConsole/);
    expect(firstFrame).not.toMatch(/src\/kernel\/realm\/realm-node-shims/);
  });

  it('group / groupCollapsed indent subsequent lines until groupEnd', () => {
    const { con, out } = makeConsole();
    con.group('g');
    con.log('inner');
    con.groupCollapsed('c');
    con.log('nested');
    con.groupEnd();
    con.groupEnd();
    con.groupEnd();
    con.log('after');
    expect(out()).toBe('g\n  inner\n  c\n    nested\nafter\n');
  });

  it('time / timeEnd / timeLog track labels; missing labels warn on stderr', () => {
    const { con, out, err } = makeConsole();
    con.time('t');
    con.time('t');
    expect(err()).toContain("Label 't' already exists for console.time()");
    con.timeLog('t', 'checkpoint');
    expect(out()).toMatch(/^t: \d+\.\d{3}ms checkpoint\n$/);
    con.timeEnd('t');
    expect(out()).toMatch(/^t: \d+\.\d{3}ms checkpoint\nt: \d+\.\d{3}ms\n$/);
    con.timeEnd('nope');
    con.timeLog('nope');
    expect(err()).toContain("No such label 'nope' for console.timeEnd()");
    expect(err()).toContain("No such label 'nope' for console.timeLog()");
  });

  it('count / countReset track labels; unknown reset warns on stderr', () => {
    const { con, out, err } = makeConsole();
    con.count();
    con.count();
    con.count('x');
    expect(out()).toBe('default: 1\ndefault: 2\nx: 1\n');
    con.countReset('x');
    con.count('x');
    expect(out()).toBe('default: 1\ndefault: 2\nx: 1\nx: 1\n');
    con.countReset('nope');
    expect(err()).toContain("Count for 'nope' does not exist");
  });
});
