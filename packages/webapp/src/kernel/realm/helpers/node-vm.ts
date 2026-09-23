type VmOptions = string | { filename?: string } | undefined;
type Runner = (scope: object, code: string, fns: string[], out: RunOutput) => void;
interface RunOutput {
  value: unknown;
  fns: Map<string, unknown>;

  lex?: () => { [name: string]: unknown };
}

const scopes = new WeakMap<object, object>();

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

function declaredNames(source: string, re: RegExp): string[] {
  return [...new Set([...source.matchAll(re)].map((m) => m[1]))].filter((n) => !RESERVED.has(n));
}

function lexicalCapture(names: string[]): string {
  return names.length === 0
    ? ''
    : `\n;let __vm_lexcap = (__vm_out.lex = () => ({ ${names.join(', ')} }));`;
}

function getRunner(): Runner {
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

      return !declaredFns.has(key);
    },
    get(t, key, receiver) {
      if (key === Symbol.unscopables) return undefined;
      if (key in t) return Reflect.get(t, key, receiver);
      if (key === 'globalThis') return proxy;
      const value = Reflect.get(globalThis, key);

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
