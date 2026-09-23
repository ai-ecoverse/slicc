import { nodeUrl } from './helpers/node-url.js';

function invalidPathArg(name: string, value: unknown): TypeError {
  return Object.assign(
    new TypeError(
      `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${value === null ? 'null' : typeof value}`
    ),
    { code: 'ERR_INVALID_ARG_TYPE' }
  );
}

function isUrlLike(value: unknown): value is { href: string; protocol: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { href?: unknown }).href === 'string' &&
    typeof (value as { protocol?: unknown }).protocol === 'string'
  );
}

export function toFsPath(value: unknown, name = 'path'): string {
  if (typeof value === 'string') return value;
  if (isUrlLike(value)) {
    if (value.protocol !== 'file:') {
      throw Object.assign(new TypeError('The URL must be of scheme file'), {
        code: 'ERR_INVALID_URL_SCHEME',
      });
    }
    return nodeUrl.fileURLToPath(value.href);
  }
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw invalidPathArg(name, value);
}

export type PathArgLayout = 'path' | 'fd' | 'pair' | 'second';

type AnyMethod = (...args: unknown[]) => unknown;

function coerceArgs(layout: PathArgLayout, args: unknown[]): unknown[] {
  const out = [...args];
  switch (layout) {
    case 'path':
      out[0] = toFsPath(out[0]);
      break;
    case 'fd':
      if (typeof out[0] !== 'number') out[0] = toFsPath(out[0]);
      break;
    case 'pair':
      out[0] = toFsPath(out[0], 'src');
      out[1] = toFsPath(out[1], 'dest');
      break;
    case 'second':
      out[1] = toFsPath(out[1]);
      break;
  }
  return out;
}

export function acceptPathLikeArgs<T extends object>(
  target: T,
  layouts: { [K in keyof T]?: PathArgLayout },
  opts: { promises?: boolean } = {}
): void {
  const methods = target as unknown as { [K in keyof T]: AnyMethod };
  for (const key of Object.keys(layouts) as Array<keyof T>) {
    const layout = layouts[key];
    const original = methods[key];
    if (!layout || typeof original !== 'function') continue;
    methods[key] = ((...args: unknown[]) => {
      let coerced: unknown[];
      try {
        coerced = coerceArgs(layout, args);
      } catch (err) {
        if (opts.promises) return Promise.reject(err);
        throw err;
      }
      return original.apply(target, coerced);
    }) as T[keyof T] & AnyMethod;
  }
}
