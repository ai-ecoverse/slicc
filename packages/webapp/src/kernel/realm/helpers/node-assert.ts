export class NodeAssertionError extends Error {
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string;
  readonly generatedMessage: boolean;
  readonly code: 'ERR_ASSERTION';
  constructor(
    opts: {
      message?: string;
      actual?: unknown;
      expected?: unknown;
      operator?: string;
    } = {}
  ) {
    const generated = !opts.message;
    super(
      opts.message ||
        `${stringifyOperand(opts.actual)} ${opts.operator || '!='} ${stringifyOperand(opts.expected)}`
    );
    this.name = 'AssertionError';
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.operator = opts.operator || '';
    this.generatedMessage = generated;
    this.code = 'ERR_ASSERTION';
  }
}

function stringifyOperand(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toAssertError(
  message: string | Error | undefined,
  fallback: () => NodeAssertionError
): Error {
  if (message instanceof Error) return message;
  if (typeof message === 'string') return new NodeAssertionError({ message });
  return fallback();
}

function deepEqArray(a: unknown[], b: unknown[], strict: boolean, seen: WeakMap<object, object>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i], strict, seen)) return false;
  return true;
}

function deepEqObject(ao: object, bo: object, strict: boolean, seen: WeakMap<object, object>) {
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    const av = Reflect.get(ao, k);
    const bv = Reflect.get(bo, k);
    if (!deepEq(av, bv, strict, seen)) return false;
  }
  return true;
}

function deepEq(a: unknown, b: unknown, strict: boolean, seen: WeakMap<object, object>): boolean {
  if (strict ? Object.is(a, b) : a === b) return true;
  // biome-ignore lint/suspicious/noDoubleEquals: assert.deepEqual is Node-faithful loose compare.
  if (!strict && a == b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ao = a as object;
  const bo = b as object;
  if (strict && Object.getPrototypeOf(ao) !== Object.getPrototypeOf(bo)) return false;
  if (seen.get(ao) === bo) return true;
  seen.set(ao, bo);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return deepEqArray(a, b, strict, seen);
  return deepEqObject(ao, bo, strict, seen);
}

function matchThrownFunction(err: unknown, expected: (e: unknown) => unknown): boolean {
  try {
    if (err instanceof (expected as unknown as new (...a: unknown[]) => unknown)) return true;
  } catch {
    // expected is not a class — fall through to predicate
  }
  try {
    return Boolean(expected(err));
  } catch {
    return false;
  }
}

/**
 * Node `assert.throws` expected-error property bag: each own key is compared
 * against the thrown value (`===`), except RegExp values which match string fields.
 */
type ThrownErrorExpectation = { [key: string]: unknown };

function matchThrownShape(err: object, expected: ThrownErrorExpectation): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const ev = Reflect.get(err, k);
    if (v instanceof RegExp) {
      if (typeof ev !== 'string' || !v.test(ev)) return false;
    } else if (ev !== v) {
      return false;
    }
  }
  return true;
}

function matchThrown(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) {
    const msg = err instanceof Error ? err.message : String(err);
    return expected.test(msg);
  }
  if (typeof expected === 'function')
    return matchThrownFunction(err, expected as (e: unknown) => unknown);
  if (expected && typeof expected === 'object') {
    if (!err || typeof err !== 'object') return false;
    return matchThrownShape(err, expected as ThrownErrorExpectation);
  }
  return false;
}

export interface NodeAssert {
  (value: unknown, message?: string | Error): void;
  ok(value: unknown, message?: string | Error): void;
  equal(actual: unknown, expected: unknown, message?: string | Error): void;
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  notDeepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  throws(block: () => unknown, error?: unknown, message?: string | Error): void;
  doesNotThrow(block: () => unknown, message?: string | Error): void;
  fail(message?: string | Error): never;
  AssertionError: typeof NodeAssertionError;
  strict: NodeAssert;
}

function buildAssert(strictMode: boolean): NodeAssert {
  const ok = (value: unknown, message?: string | Error): void => {
    if (value) return;
    throw toAssertError(
      message,
      () =>
        new NodeAssertionError({
          message: 'The expression evaluated to a falsy value',
          actual: value,
          expected: true,
          operator: '==',
        })
    );
  };
  const callable = ((value: unknown, message?: string | Error): void =>
    ok(value, message)) as NodeAssert;
  const strictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (Object.is(actual, expected)) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'strictEqual' })
    );
  };
  const equal = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      strictEqual(actual, expected, message);
      return;
    }
    // biome-ignore lint/suspicious/noDoubleEquals: assert.equal is Node-faithful loose compare.
    if (actual == expected) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: '==' })
    );
  };
  const notStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (!Object.is(actual, expected)) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'notStrictEqual' })
    );
  };
  const notEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      notStrictEqual(actual, expected, message);
      return;
    }
    // biome-ignore lint/suspicious/noDoubleEquals: assert.notEqual is Node-faithful loose compare.
    if (actual != expected) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: '!=' })
    );
  };
  const deepStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (deepEq(actual, expected, true, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'deepStrictEqual' })
    );
  };
  const deepEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      deepStrictEqual(actual, expected, message);
      return;
    }
    if (deepEq(actual, expected, false, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'deepEqual' })
    );
  };
  const notDeepStrictEqual = (
    actual: unknown,
    expected: unknown,
    message?: string | Error
  ): void => {
    if (!deepEq(actual, expected, true, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'notDeepStrictEqual' })
    );
  };
  const notDeepEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
    if (strictMode) {
      notDeepStrictEqual(actual, expected, message);
      return;
    }
    if (!deepEq(actual, expected, false, new WeakMap())) return;
    throw toAssertError(
      message,
      () => new NodeAssertionError({ actual, expected, operator: 'notDeepEqual' })
    );
  };
  const throws = (block: () => unknown, errorOrMsg?: unknown, message?: string | Error): void => {
    let thrown: unknown;
    let didThrow = false;
    try {
      block();
    } catch (e) {
      thrown = e;
      didThrow = true;
    }
    if (!didThrow) {
      throw toAssertError(
        typeof errorOrMsg === 'string' ? errorOrMsg : message,
        () => new NodeAssertionError({ message: 'Missing expected exception', operator: 'throws' })
      );
    }
    const isMsgOnly = typeof errorOrMsg === 'string' || errorOrMsg instanceof Error;
    if (!isMsgOnly && !matchThrown(thrown, errorOrMsg)) {
      throw toAssertError(
        message,
        () =>
          new NodeAssertionError({
            message: 'Got unwanted exception',
            actual: thrown,
            operator: 'throws',
          })
      );
    }
  };
  const doesNotThrow = (block: () => unknown, message?: string | Error): void => {
    try {
      block();
    } catch (e) {
      throw toAssertError(
        message,
        () =>
          new NodeAssertionError({
            message: 'Got unwanted exception',
            actual: e,
            operator: 'doesNotThrow',
          })
      );
    }
  };
  const fail = (message?: string | Error): never => {
    throw toAssertError(
      message,
      () => new NodeAssertionError({ message: 'Failed', operator: 'fail' })
    );
  };
  callable.ok = ok;
  callable.equal = equal;
  callable.notEqual = notEqual;
  callable.strictEqual = strictEqual;
  callable.notStrictEqual = notStrictEqual;
  callable.deepEqual = deepEqual;
  callable.deepStrictEqual = deepStrictEqual;
  callable.notDeepEqual = notDeepEqual;
  callable.notDeepStrictEqual = notDeepStrictEqual;
  callable.throws = throws;
  callable.doesNotThrow = doesNotThrow;
  callable.fail = fail;
  callable.AssertionError = NodeAssertionError;
  return callable;
}

export const nodeAssertStrict: NodeAssert = buildAssert(true);
nodeAssertStrict.strict = nodeAssertStrict;
export const nodeAssert: NodeAssert = buildAssert(false);
nodeAssert.strict = nodeAssertStrict;
