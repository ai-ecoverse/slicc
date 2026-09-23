/**
 * `fs-path-arg.ts` — Node `PathLike` coercion for the realm's `fs` shim.
 *
 * Node's fs APIs accept `string | Buffer | URL` for every path argument
 * (`fs.readFileSync(new URL('./data.json', import.meta.url))` is idiomatic
 * ESM). The shim's internals are string-only, so each path-taking method is
 * wrapped once at the module boundary to normalize its path args before the
 * stdio overlays and path resolution see them.
 */
import { nodeUrl } from './helpers/node-url.js';

function invalidPathArg(name: string, value: unknown): TypeError {
  return Object.assign(
    new TypeError(
      `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${value === null ? 'null' : typeof value}`
    ),
    { code: 'ERR_INVALID_ARG_TYPE' }
  );
}

/** URL-like check that survives cross-realm `URL` instances (no `instanceof`). */
function isUrlLike(value: unknown): value is { href: string; protocol: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { href?: unknown }).href === 'string' &&
    typeof (value as { protocol?: unknown }).protocol === 'string'
  );
}

/**
 * Coerce a Node `PathLike` (`string | Buffer | Uint8Array | URL`) to a string
 * path. `file:` URLs go through `fileURLToPath` (percent-decoded pathname),
 * any other scheme throws `ERR_INVALID_URL_SCHEME`, and anything else throws
 * `ERR_INVALID_ARG_TYPE` — the same contract Node enforces.
 */
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

/**
 * Per-method path-arg layout: `path` (one leading path), `fd` (one leading
 * path-or-fd), `pair` (two leading paths, e.g. src/dest), or `second` (the
 * path is the second arg, as in `fetchToFile(url, path)`).
 */
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

/**
 * Wrap each listed method of `target` IN PLACE so its path args accept any
 * Node `PathLike`. Must run after the stdio overlays so a
 * `new URL('file:///dev/stdin')` reaches them as the plain device path.
 * With `promises: true` an invalid path rejects instead of throwing
 * synchronously, matching `fs.promises`.
 */
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
