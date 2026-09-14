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

export const NODE_NATIVE_PACKAGES: ReadonlySet<string> = new Set<string>(NATIVE_PACKAGES);

export const NATIVE_PACKAGE_HINTS: Partial<Record<NativePackageName, string>> = {
  sharp: " Use the built-in 'convert' shell command for image work.",
  canvas: " Use the built-in 'convert' / OffscreenCanvas for image work.",
  'better-sqlite3': " Use the built-in 'sqlite3' shell command (sql.js WASM).",
  sqlite3: " Use the built-in 'sqlite3' shell command (sql.js WASM).",
  bcrypt: ' Use crypto.subtle.digest() with PBKDF2 / Argon2 in pure JS.',
  puppeteer: ' Use the built-in browser-automation shell commands.',
};

export const LOAD_MODULE_TIMEOUT_MS = 15_000;

export function resolveLoadModuleTimeoutMs(env: Record<string, string> | undefined): number {
  const raw = env?.['SLICC_REALM_PREFETCH_BUDGET_MS'];
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return LOAD_MODULE_TIMEOUT_MS;
}

export function nativePackageError(id: string, bareId: string): Error {
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
