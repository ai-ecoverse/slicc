const UTIL_INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
export const UTIL_PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

export interface NodeInspectOptions {
  depth?: number | null;
}

interface InspectCtx {
  seen: Set<unknown>;
  maxDepth: number | null;
  opts: NodeInspectOptions;
}

function inspectQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function inspectPrimitive(val: unknown): string | null {
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'string') return inspectQuote(val as string);
  if (t === 'number') return Object.is(val, -0) ? '-0' : String(val);
  if (t === 'bigint') return `${String(val)}n`;
  if (t === 'boolean' || t === 'undefined') return String(val);
  if (t === 'symbol') return (val as symbol).toString();
  if (t === 'function') {
    const name = (val as { name?: string }).name;
    return name ? `[Function: ${name}]` : '[Function (anonymous)]';
  }
  return null;
}

function inspectSpecialObject(val: object): string | null {
  if (val instanceof RegExp) return val.toString();
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString();
  }
  if (val instanceof Error) {
    return val.stack || `${val.name}: ${val.message}`;
  }
  return null;
}

function inspectContainer(
  obj: Record<PropertyKey, unknown>,
  depth: number,
  ctx: InspectCtx
): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[ ${obj.map((v) => inspectValue(v, depth + 1, ctx)).join(', ')} ]`;
  }
  if (obj instanceof Map) {
    const items = [...obj].map(
      ([k, v]) => `${inspectValue(k, depth + 1, ctx)} => ${inspectValue(v, depth + 1, ctx)}`
    );
    return `Map(${obj.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
  }
  if (obj instanceof Set) {
    const items = [...obj].map((v) => inspectValue(v, depth + 1, ctx));
    return `Set(${obj.size}) {${items.length ? ` ${items.join(', ')} ` : ''}}`;
  }
  const keys = Object.keys(obj);
  const ctorName = obj.constructor ? obj.constructor.name : '';
  const prefix = ctorName && ctorName !== 'Object' ? `${ctorName} ` : '';
  if (keys.length === 0) return `${prefix}{}`;
  const items = keys.map((k) => {
    const label = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : inspectQuote(k);
    return `${label}: ${inspectValue(obj[k], depth + 1, ctx)}`;
  });
  return `${prefix}{ ${items.join(', ')} }`;
}

function inspectValue(val: unknown, depth: number, ctx: InspectCtx): string {
  const prim = inspectPrimitive(val);
  if (prim !== null) return prim;
  const obj = val as Record<PropertyKey, unknown>;
  const special = inspectSpecialObject(obj as object);
  if (special !== null) return special;
  const custom = (obj as Record<symbol, unknown>)[UTIL_INSPECT_CUSTOM];
  if (typeof custom === 'function') {
    try {
      return String((custom as Function).call(obj, ctx.maxDepth, ctx.opts));
    } catch {
      // Fall through to structural inspection when a custom inspector throws.
    }
  }
  if (ctx.seen.has(val)) return '[Circular *1]';
  if (ctx.maxDepth !== null && depth > ctx.maxDepth) {
    return Array.isArray(val) ? '[Array]' : '[Object]';
  }
  ctx.seen.add(val);
  try {
    return inspectContainer(obj, depth, ctx);
  } finally {
    ctx.seen.delete(val);
  }
}

function nodeInspect(value: unknown, opts: NodeInspectOptions = {}): string {
  const maxDepth = opts.depth === undefined ? 2 : opts.depth;
  return inspectValue(value, 0, { seen: new Set(), maxDepth, opts });
}

function formatToken(
  token: string,
  args: unknown[],
  state: { i: number },
  opts: NodeInspectOptions
): string {
  if (token === '%%') return '%';
  if (state.i >= args.length) return token;
  const arg = args[state.i];
  switch (token) {
    case '%s':
      state.i++;
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'bigint') return `${String(arg)}n`;
      if (
        arg === null ||
        arg === undefined ||
        typeof arg === 'number' ||
        typeof arg === 'boolean'
      ) {
        return String(arg);
      }
      return nodeInspect(arg, { depth: opts.depth === undefined ? 2 : opts.depth });
    case '%d':
      state.i++;
      if (typeof arg === 'bigint') return `${String(arg)}n`;
      return Number.isNaN(Number(arg)) ? 'NaN' : String(Number(arg));
    case '%i':
      state.i++;
      if (typeof arg === 'bigint') return `${String(arg)}n`;
      return String(Number.parseInt(arg as string, 10));
    case '%f':
      state.i++;
      if (typeof arg === 'bigint') return String(arg);
      return String(Number.parseFloat(arg as string));
    case '%j':
      state.i++;
      try {
        return JSON.stringify(arg) ?? 'undefined';
      } catch {
        return '[Circular]';
      }
    case '%o':
      state.i++;
      return nodeInspect(arg, { depth: 4 });
    case '%O':
      state.i++;
      return nodeInspect(arg, { depth: null });
    case '%c':
      state.i++;
      return '';
    default:
      return token;
  }
}

function nodeFormatWithOptions(opts: NodeInspectOptions, ...args: unknown[]): string {
  const first = args[0];
  if (typeof first !== 'string') {
    return args.map((a) => (typeof a === 'string' ? a : nodeInspect(a))).join(' ');
  }
  const state = { i: 1 };
  let str = first.replace(/%[sdifjoOc%]/g, (token) => formatToken(token, args, state, opts));
  for (; state.i < args.length; state.i++) {
    const a = args[state.i];
    str += ` ${typeof a === 'string' ? a : nodeInspect(a)}`;
  }
  return str;
}

function nodeFormat(...args: unknown[]): string {
  return nodeFormatWithOptions({}, ...args);
}

function nodeInherits(ctor: Function, superCtor: Function): void {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The constructor to "inherits" must not be null or undefined');
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The super constructor to "inherits" must not be null or undefined');
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The super constructor to "inherits" must have a prototype');
  }
  (ctor as { super_?: unknown }).super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

function nodePromisify(original: Function): Function {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type function');
  }
  const custom = (original as Function & { [UTIL_PROMISIFY_CUSTOM]?: Function })[
    UTIL_PROMISIFY_CUSTOM
  ];
  if (custom) {
    if (typeof custom !== 'function') {
      throw new TypeError('The [util.promisify.custom] property must be of type function');
    }
    return custom;
  }
  function fn(this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      (original as (...a: unknown[]) => unknown).call(
        this,
        ...args,
        (err: unknown, ...values: unknown[]) => {
          if (err) {
            reject(err as Error);
            return;
          }
          resolve(values.length > 1 ? values : values[0]);
        }
      );
    });
  }
  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
  Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  return fn;
}

export interface NodeUtil {
  format(...args: unknown[]): string;
  formatWithOptions(opts: NodeInspectOptions, ...args: unknown[]): string;
  inspect: { (value: unknown, opts?: NodeInspectOptions): string; custom: symbol };
  inherits(ctor: Function, superCtor: Function): void;
  promisify: { (original: Function): Function; custom: symbol };
}

const utilInspect = nodeInspect as NodeUtil['inspect'];
utilInspect.custom = UTIL_INSPECT_CUSTOM;
const utilPromisify = nodePromisify as NodeUtil['promisify'];
utilPromisify.custom = UTIL_PROMISIFY_CUSTOM;

export const nodeUtil: NodeUtil = {
  format: nodeFormat,
  formatWithOptions: nodeFormatWithOptions,
  inspect: utilInspect,
  inherits: nodeInherits,
  promisify: utilPromisify,
};
