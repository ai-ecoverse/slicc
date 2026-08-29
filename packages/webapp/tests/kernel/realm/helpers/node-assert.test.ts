/**
 * Direct unit tests for the Node-faithful `assert` shim used by realm CJS
 * builtins. Pins deep-equality and throws-shape matching after the
 * `Record<string, unknown>` boy-scout cleanup.
 */

import { describe, expect, it } from 'vitest';
import {
  NodeAssertionError,
  nodeAssert,
  nodeAssertStrict,
} from '../../../../src/kernel/realm/helpers/node-assert.js';

describe('nodeAssert', () => {
  it('deepEqual compares nested objects and arrays loosely', () => {
    expect(() => nodeAssert.deepEqual({ a: 1, b: [2] }, { a: 1, b: [2] })).not.toThrow();
    expect(() => nodeAssert.deepEqual({ a: 1 }, { a: '1' })).not.toThrow();
    expect(() => nodeAssert.deepEqual({ a: 1 }, { a: 2 })).toThrow(NodeAssertionError);
  });

  it('deepStrictEqual rejects loose number/string equality', () => {
    expect(() => nodeAssert.deepStrictEqual({ a: 1 }, { a: 1 })).not.toThrow();
    expect(() => nodeAssert.deepStrictEqual({ a: 1 }, { a: '1' })).toThrow(NodeAssertionError);
  });

  it('deepEqual detects cyclic structures that match', () => {
    const a: { self?: unknown } = {};
    a.self = a;
    const b: { self?: unknown } = {};
    b.self = b;
    expect(() => nodeAssert.deepEqual(a, b)).not.toThrow();
  });

  it('throws matches an expected-error property bag and RegExp fields', () => {
    expect(() =>
      nodeAssert.throws(
        () => {
          throw new TypeError('boom');
        },
        { name: 'TypeError', message: /^boom$/ }
      )
    ).not.toThrow();

    expect(() =>
      nodeAssert.throws(
        () => {
          throw new TypeError('boom');
        },
        { name: 'RangeError' }
      )
    ).toThrow(NodeAssertionError);
  });

  it('strict.equal is strictEqual and strict.deepEqual is deepStrictEqual', () => {
    expect(() => nodeAssertStrict.equal(1, '1')).toThrow(NodeAssertionError);
    expect(() => nodeAssertStrict.deepEqual({ a: 1 }, { a: '1' })).toThrow(NodeAssertionError);
    expect(nodeAssertStrict.strict).toBe(nodeAssertStrict);
  });
});
