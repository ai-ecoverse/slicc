/**
 * Pre-fetch guard rails for `require()` resolution in JS realms.
 *
 * Two guard rails wrap every `loadModule(id)` call:
 *
 *   - `NODE_NATIVE_PACKAGES` is a hard-fail list of npm packages
 *     that ship C++ bindings via node-gyp/prebuild. Their esm.sh
 *     and jsdelivr stubs chain into a transitive `.node` loader
 *     fetch that returns 404, redirects forever, or hangs on a
 *     resource that the CDN won't serve — depending on the
 *     package. Hard-failing here keeps a stray
 *     `require('sharp')` from parking the realm for the full
 *     timeout per specifier.
 *
 *   - `withTimeout(promise, ms, label)` caps every actual
 *     `loadModule(id)` so a stuck transitive import still bounds
 *     the realm's wall time. esm.sh and jsdelivr normally resolve
 *     well under a second; anything still pending past 15s is
 *     almost certainly never going to complete.
 *
 * Mirrored verbatim in `packages/chrome-extension/sandbox.html`
 * because the sandbox iframe bootstrap runs outside the TS module
 * graph. `node-command-loadmodule.test.ts` pins the contract in
 * both locations.
 */

/**
 * Source-of-truth array. Frozen `as const` so the literal type
 * stays narrow; spread into `NODE_NATIVE_PACKAGES` for `.has()`
 * membership checks and used to derive `NativePackageName` for
 * hint-key typing.
 */
const NATIVE_PACKAGES = [
  'bcrypt',
  'better-sqlite3',
  'canvas',
  'cpu-features',
  'fsevents',
  'leveldown',
  'libxmljs',
  'libxmljs2',
  'node-gyp-build',
  'node-sass',
  'puppeteer',
  'robotjs',
  'sass-embedded',
  'sharp',
  'snappy',
  'sqlite3',
  'tree-sitter',
  'usb',
] as const;

export type NativePackageName = (typeof NATIVE_PACKAGES)[number];

/**
 * `.has()` takes a `string` (user-controlled `require()` id), so
 * the public type is `ReadonlySet<string>`. The membership domain
 * is still pinned by the source-of-truth array above; the
 * mirror-parity test in `bsh-watchdog.test.ts` walks every entry
 * to assert sandbox.html and bsh-watchdog.ts carry it through.
 */
export const NODE_NATIVE_PACKAGES: ReadonlySet<string> = new Set<string>(NATIVE_PACKAGES);

/**
 * `Partial<Record<NativePackageName, string>>` because not every
 * native package has a specific recommended alternative — but a
 * typo here is now a compile error rather than a dead hint key.
 */
export const NATIVE_PACKAGE_HINTS: Partial<Record<NativePackageName, string>> = {
  sharp: " Use the built-in 'convert' shell command for image work.",
  canvas: " Use the built-in 'convert' / OffscreenCanvas for image work.",
  'better-sqlite3': " Use the built-in 'sqlite3' shell command (sql.js WASM).",
  sqlite3: " Use the built-in 'sqlite3' shell command (sql.js WASM).",
  bcrypt: ' Use crypto.subtle.digest() with PBKDF2 / Argon2 in pure JS.',
  puppeteer: ' Use the built-in browser-automation shell commands.',
};

export const LOAD_MODULE_TIMEOUT_MS = 15_000;

export function nativePackageError(id: string, bareId: string): Error {
  // `bareId` arrives as a free-form `string` from user `require()`
  // calls; cast through the literal record so we can still index
  // type-safely without losing the upstream signature.
  const hint = (NATIVE_PACKAGE_HINTS as Record<string, string | undefined>)[bareId] ?? '';
  return new Error(
    `require('${id}'): '${bareId}' is a Node native module (C++ bindings) — it cannot run in the browser sandbox.${hint}`
  );
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms / 1000}s loading ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
