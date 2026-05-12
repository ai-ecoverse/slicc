import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Phase 8 moved the extension's `node -e` execution out of
 * `node-command.ts` and into `sandbox.html` (per-task realm
 * iframe). The wrappedCode template that used `cdn.jsdelivr.net`
 * + indirect Function constructor lives there now. These
 * assertions pin the same load-module behavior in its new home so
 * the extension's `node -e require('lodash')` keeps working.
 */
const sandboxSrc = readFileSync(
  resolve(__dirname, '..', '..', '..', '..', 'chrome-extension', 'sandbox.html'),
  'utf-8'
);

describe('extension-mode JS realm __loadModule (sandbox.html)', () => {
  it('uses jsdelivr CDN for require() pre-fetch', () => {
    expect(sandboxSrc).toContain("'https://cdn.jsdelivr.net/npm/'");
  });

  it('does not use dynamic import() for require pre-fetch in the sandbox', () => {
    // The realm-protocol `runRealm` block fetches via fetch() +
    // indirect Function constructor. `import()` would be blocked
    // by the sandbox CSP for cross-origin URLs.
    const realmFnMatch = sandboxSrc.match(/async function runRealm[\s\S]*?\n\}\n/);
    expect(realmFnMatch).toBeTruthy();
    const body = realmFnMatch![0];
    expect(body).not.toContain('await import(');
    expect(body).not.toContain('import(url)');
  });

  it('uses indirect Function constructor with module/exports shim', () => {
    expect(sandboxSrc).toContain("(0, Function)('module', 'exports', text)(mod, mod.exports)");
  });

  it('wraps Function invocation in try-catch with a clear error', () => {
    expect(sandboxSrc).toContain("'Failed to execute module '");
  });

  it('falls back to globalThis for libraries that set self[id]', () => {
    expect(sandboxSrc).toContain('self[id]');
  });

  it('hard-fails Node-native packages before attempting the CDN fetch', () => {
    // Without this, `require('sharp')` parked the realm for minutes
    // on a transitive `.node` loader fetch instead of erroring.
    expect(sandboxSrc).toContain('NODE_NATIVE_PACKAGES');
    expect(sandboxSrc).toMatch(/'sharp'/);
    expect(sandboxSrc).toContain('is a Node native module');
  });

  it('caps require pre-fetch with a hard timeout', () => {
    // Bound to 15s so a stuck transitive import can't hang
    // `Promise.allSettled` indefinitely.
    expect(sandboxSrc).toContain('LOAD_MODULE_TIMEOUT_MS');
    expect(sandboxSrc).toMatch(/Timed out after/);
  });

  it('points sharp / sqlite3 callers at the WASM-backed shell commands', () => {
    expect(sandboxSrc).toContain("Use the built-in 'convert' shell command");
    expect(sandboxSrc).toContain("Use the built-in 'sqlite3' shell command");
  });
});
