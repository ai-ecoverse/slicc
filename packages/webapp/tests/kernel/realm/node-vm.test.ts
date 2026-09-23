import { describe, expect, it } from 'vitest';
import { nodeVm as vm } from '../../../src/kernel/realm/helpers/node-vm.js';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('vm contexts', () => {
  it('runInNewContext collects var declarations onto the sandbox', () => {
    const settings: Record<string, unknown> = {};
    vm.runInNewContext('var ASSERTIONS = 1;\nvar EXPORTED = ["_main"];\nvar UNSET;', settings);
    expect(settings.ASSERTIONS).toBe(1);
    expect(settings.EXPORTED).toEqual(['_main']);
  });

  it('runInContext reads context values and returns the completion value', () => {
    const ctx = vm.createContext({ ASSERTIONS: 1, MINIMAL_RUNTIME: 0 });
    expect(vm.runInContext('ASSERTIONS && !MINIMAL_RUNTIME', ctx)).toBe(true);
    expect(vm.runInContext('[Map, Set]', ctx)).toEqual([Map, Set]);
    expect(vm.runInContext('typeof NOT_DEFINED', ctx)).toBe('undefined');
  });

  it('keeps top-level functions on the context for later runs', () => {
    const ctx = vm.createContext({});
    vm.runInContext('function helper(x) { return x * 2; }\nvar viaHelper = helper(21);', ctx);
    expect((ctx as { viaHelper?: number }).viaHelper).toBe(42);
    expect(vm.runInContext('helper(5)', ctx)).toBe(10);

    expect(vm.runInContext('function helper() { return "new"; }\nhelper()', ctx)).toBe('new');
  });

  it('keeps top-level const/let/class for later runs (emscripten macro blocks)', () => {
    const ctx = vm.createContext({});

    expect(vm.runInContext('const POOL = 2*9*16 // = 288\nlet n = 1; class K {}', ctx)).toBe(
      undefined
    );
    expect(vm.runInContext('POOL / 2', ctx)).toBe(144);
    expect(vm.runInContext('typeof K + n', ctx)).toBe('function1');

    expect(vm.runInContext('const A = 1; A + 41', ctx)).toBe(42);
    expect(vm.runInContext('"use strict"; const S = 7; S * 6', ctx)).toBe(42);
    expect(vm.runInContext('S', ctx)).toBe(7);
  });

  it('does not leak names that only look declared (comments, nested scopes)', () => {
    const ctx = vm.createContext({});
    vm.runInContext('// let me explain\nfunction f() { const inner = 1; return inner; }', ctx);
    expect(Object.keys(ctx)).toEqual(['f']);
  });

  it('assignments and globalThis stay on the context, not the realm', () => {
    const ctx = vm.createContext({});
    vm.runInContext('leaked = 1; globalThis.viaGlobal = 2; this.viaThis = 3;', ctx);
    expect(ctx).toMatchObject({ leaked: 1, viaGlobal: 2, viaThis: 3 });
    expect('leaked' in globalThis).toBe(false);
  });

  it('calls realm functions resolved through the scope with a valid this', () => {
    const ctx = vm.createContext({});
    expect(vm.runInContext('parseInt("42") + queueMicrotask.length', ctx)).toBe(43);
  });

  it('rejects an object that was never contextified', () => {
    expect(() => vm.runInContext('1', {})).toThrow(TypeError);
    expect(vm.isContext(vm.createContext({}))).toBe(true);
  });

  it('Script runs in several contexts and in this context', () => {
    const script = new vm.Script('var out = typeof value === "number" ? value + 1 : -1; out');
    const a = vm.createContext({ value: 1 });
    expect(script.runInContext(a)).toBe(2);
    expect(script.runInNewContext({ value: 10 })).toBe(11);
    expect(new vm.Script('1 + 2').runInThisContext()).toBe(3);
  });

  it('names the file in stack traces', () => {
    const ctx = vm.createContext({});
    try {
      vm.runInContext('throw new Error("boom")', ctx, { filename: '/lib/libfoo.js' });
    } catch (e) {
      expect(String((e as Error).stack)).toContain('/lib/libfoo.js');
      return;
    }
    throw new Error('expected a throw');
  });
});

describe("require('node:vm') in the realm", () => {
  it('is served instead of the unavailable-builtin error', async () => {
    const r = await runCode(
      "const vm = require('node:vm'); const s = {}; vm.runInNewContext('var X = 6 * 7', s); console.log(s.X);",
      makeCtx()
    );
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('42');
  });
});
