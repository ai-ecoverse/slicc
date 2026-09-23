/**
 * Best-effort `vm` for the realm. A worker cannot create a fresh JS realm
 * synchronously, so a "context" is the contextified object itself, and code
 * runs through a `with (Proxy)` scope over it: `var` initializers and bare
 * assignments land on the object, reads fall back to the realm's globals.
 * That covers the common use, evaluating config or library files against a
 * settings object (emscripten's JS compiler does exactly this).
 *
 * Not isolated: builtins (`Map`, `Object`, …) are the realm's own, not fresh
 * copies. Top-level function, `let`, `const` and `class` declarations reach
 * the context after the run (as properties, with their values at the end of
 * the run), so later runs see them; an unknown name reads as `undefined`
 * rather than throwing.
 */

type VmOptions = string | { filename?: string } | undefined;
type Runner = (scope: object, code: string, fns: string[], out: RunOutput) => void;
interface RunOutput {
  value: unknown;
  fns: Map<string, unknown>;
  /** Set by the capture trailer: the code's top-level lexical bindings. */
  lex?: () => { [name: string]: unknown };
}

/** Contextified object -> its scope proxy. */
const scopes = new WeakMap<object, object>();
/** Function names the running code declares (they must resolve to the runner scope). */
let declaredFns: ReadonlySet<string> = new Set();
let runner: Runner | null = null;

const FUNCTION_DECL = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
const LEXICAL_DECL = /\b(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g;
const RESERVED = new Set(
  (
    'arguments await break case catch class const continue debugger default delete do else enum ' +
    'eval export extends false finally for function if implements import in instanceof interface ' +
    'let new null package private protected public return static super switch this throw true ' +
    'try typeof var void while with yield'
  ).split(' ')
);

/** Candidate names matched by `re` (over-inclusive: a text scan, not a parse). */
function declaredNames(source: string, re: RegExp): string[] {
  return [...new Set([...source.matchAll(re)].map((m) => m[1]))].filter((n) => !RESERVED.has(n));
}

/**
 * Trailer that hands the code's top-level lexical bindings to the runner (a
 * direct eval keeps them in its own scope). A declaration has an empty
 * completion, so the script's completion value is unchanged, and it works in
 * strict code. A candidate that is not top-level resolves to the context or a
 * realm global instead and is filtered out afterwards.
 */
function lexicalCapture(names: string[]): string {
  return names.length === 0
    ? ''
    : `\n;let __vm_lexcap = (__vm_out.lex = () => ({ ${names.join(', ')} }));`;
}

function getRunner(): Runner {
  // Sloppy on purpose (`with`), and built with `new Function` so the only
  // outer scope is global. Direct `eval` puts the code's var and function
  // declarations in this function; `with` routes its name lookups and
  // assignments through the scope proxy. `__vm_*` and `eval` bypass it.
  runner ??= new Function(
    '__vm_scope',
    '__vm_code',
    '__vm_fns',
    '__vm_out',
    `with (__vm_scope) { __vm_out.value = eval(__vm_code); }
for (var __vm_i = 0; __vm_i < __vm_fns.length; __vm_i++) {
  try { __vm_out.fns.set(__vm_fns[__vm_i], eval(__vm_fns[__vm_i])); } catch (e) {}
}`
  ) as Runner;
  return runner;
}

function scopeFor(target: object): object {
  const bound = new Map<string | symbol, unknown>();
  const proxy: object = new Proxy(target, {
    has(_t, key) {
      if (typeof key === 'symbol' || key === 'eval' || key.startsWith('__vm_')) return false;
      // A name this code declares as a function resolves to that declaration
      // (in the runner scope), even over an older value on the context.
      return !declaredFns.has(key);
    },
    get(t, key, receiver) {
      if (key === Symbol.unscopables) return undefined;
      if (key in t) return Reflect.get(t, key, receiver);
      if (key === 'globalThis') return proxy;
      const value = Reflect.get(globalThis, key);
      // A call resolved through `with` gets the scope as `this`; a WebIDL
      // operation (`setTimeout`, `fetch`) would throw Illegal invocation.
      // Constructors keep their identity (they carry a `prototype`).
      if (typeof value !== 'function' || 'prototype' in value) return value;
      if (!bound.has(key)) bound.set(key, value.bind(globalThis));
      return bound.get(key);
    },
    set(t, key, value) {
      return Reflect.set(t, key, value);
    },
  });
  return proxy;
}

function filenameOf(options: VmOptions): string | undefined {
  return typeof options === 'string' ? options : options?.filename;
}

function withSourceUrl(code: string, options: VmOptions): string {
  const filename = filenameOf(options);
  return filename ? `${code}\n//# sourceURL=${filename}` : code;
}

function createContext<T extends object>(contextObject?: T): T {
  const target = (contextObject ?? {}) as T;
  if (!scopes.has(target)) scopes.set(target, scopeFor(target));
  return target;
}

function isContext(value: unknown): boolean {
  return typeof value === 'object' && value !== null && scopes.has(value);
}

function runInContext(code: string, contextObject: object, options?: VmOptions): unknown {
  const scope = scopes.get(contextObject);
  if (!scope) {
    throw new TypeError('The "contextifiedObject" argument must be an vm.Context');
  }
  const source = String(code);
  const fns = declaredNames(source, FUNCTION_DECL);
  const lexical = declaredNames(source, LEXICAL_DECL);
  const out: RunOutput = { value: undefined, fns: new Map() };
  const outer = declaredFns;
  declaredFns = new Set(fns);
  try {
    const program = withSourceUrl(source + lexicalCapture(lexical), options);
    getRunner().call(scope, scope, program, fns, out);
  } finally {
    declaredFns = outer;
  }
  // Declared here, not a same-named realm global the lookup fell back to.
  const own = (name: string, value: unknown): boolean =>
    value !== undefined && value !== Reflect.get(globalThis, name);
  for (const [name, value] of out.fns) {
    if (typeof value === 'function' && own(name, value)) Reflect.set(contextObject, name, value);
  }
  for (const [name, value] of Object.entries(out.lex?.() ?? {})) {
    if (own(name, value)) Reflect.set(contextObject, name, value);
  }
  return out.value;
}

function runInNewContext(code: string, contextObject?: object, options?: VmOptions): unknown {
  return runInContext(code, createContext(contextObject), options);
}

function runInThisContext(code: string, options?: VmOptions): unknown {
  // An indirect eval runs in global scope, which is what runInThisContext means.
  // biome-ignore lint/security/noGlobalEval: runInThisContext is a global eval by definition
  const globalEval = globalThis.eval;
  return globalEval(withSourceUrl(String(code), options));
}

class Script {
  readonly #code: string;
  readonly #options: VmOptions;

  constructor(code: string, options?: VmOptions) {
    this.#code = String(code);
    this.#options = options;
  }

  runInContext(contextObject: object): unknown {
    return runInContext(this.#code, contextObject, this.#options);
  }

  runInNewContext(contextObject?: object): unknown {
    return runInNewContext(this.#code, contextObject, this.#options);
  }

  runInThisContext(): unknown {
    return runInThisContext(this.#code, this.#options);
  }
}

function compileFunction(code: string, params: string[] = []): (...args: unknown[]) => unknown {
  return new Function(...params, String(code)) as (...args: unknown[]) => unknown;
}

export const nodeVm = {
  Script,
  createContext,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext,
  compileFunction,
};

export type NodeVm = typeof nodeVm;
