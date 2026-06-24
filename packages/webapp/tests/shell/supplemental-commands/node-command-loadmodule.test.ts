import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The extension's `node -e` / `.jsh` execution lives in `sandbox.html` (the
 * per-task realm iframe). After the CJS require hard-switch (architecture 4.4,
 * 6) the realm resolves `require()` from the installed `node_modules` graph the
 * kernel host builds over the `module` RPC channel — the legacy
 * `cdn.jsdelivr.net/npm/<id>` + indirect Function CDN download path is GONE.
 *
 * These assertions pin that BOTH floats are wired to the host loader and that
 * neither retains a CDN fallback, keeping the dual-float parity green.
 */
const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
const sandboxSrc = readFileSync(
  resolve(repoRoot, 'packages/chrome-extension/sandbox.html'),
  'utf-8'
);
const sharedSrc = readFileSync(
  resolve(repoRoot, 'packages/webapp/src/kernel/realm/js-realm-shared.ts'),
  'utf-8'
);

describe('extension-mode JS realm require() — hard-switched to the node_modules loader', () => {
  it('builds the CJS module graph over the `module`/buildGraph RPC channel', () => {
    expect(sandboxSrc).toContain("rpcCall('module', 'buildGraph'");
    expect(sharedSrc).toContain("rpc.call<RealmModuleGraph>('module', 'buildGraph'");
  });

  it('removed the esm.sh / jsdelivr CDN download path entirely', () => {
    // No jsdelivr host construction, `/npm/<id>` fetch, or indirect-Function
    // CDN eval survives in the require path of either float (comments may still
    // reference the legacy path; only the executable patterns are asserted).
    expect(sandboxSrc).not.toContain("['cdn', 'jsdelivr', 'net'].join('.')");
    expect(sandboxSrc).not.toContain("new URL('/npm/' + id");
    expect(sandboxSrc).not.toContain("(0, Function)('module', 'exports', text)");
    expect(sandboxSrc).not.toContain('fetchAndEval');
    // The worker float no longer imports the esm.sh URL builder or does a
    // dynamic import() against a CDN.
    expect(sharedSrc).not.toContain('esmShUrl');
    expect(sharedSrc).not.toContain('await import(/* @vite-ignore */');
  });

  it('resolves require synchronously over the preloaded graph (no CDN download)', () => {
    // The hard-switch loader walks host-resolved edges; the sandbox serves
    // module files from `moduleSourceByPath` rather than fetching them.
    expect(sandboxSrc).toContain('moduleSourceByPath');
    expect(sandboxSrc).toContain('requireModuleFile');
    expect(sharedSrc).toContain('sourceByPath');
    expect(sharedSrc).toContain('requireFile');
  });

  it('throws the exact install-hint error for a missing bare module (no CDN, immediate)', () => {
    // Both floats build the identical `Cannot find module 'x' (run: ipk install x)`
    // shape from the resolver/graph errors, with no "not pre-loaded" / esm.sh wording.
    for (const src of [sandboxSrc, sharedSrc]) {
      expect(src).toContain('(run: ipk install ');
      expect(src).toContain("Cannot find module '");
      expect(src).not.toContain('not pre-loaded');
    }
  });

  it('preserves node:/sliccy: schemes and Node built-ins through the rewire', () => {
    for (const src of [sandboxSrc, sharedSrc]) {
      // Worker float uses the SLICCY_SCHEME constant; sandbox inlines the literal.
      expect(src).toMatch(/startsWith\(\s*(?:'sliccy:'|SLICCY_SCHEME)\s*\)/);
      expect(src).toContain("bareId === 'fs'");
      expect(src).toContain("bareId === 'path'");
      expect(src).toContain("bareId === 'process'");
      expect(src).toMatch(/bareId === 'buffer'[\s\S]*?globalThis[\s\S]*?Buffer/);
      // Native packages still hard-fail; browser-unavailable built-ins still throw.
      expect(src).toContain('NODE_NATIVE_PACKAGES');
      expect(src).toContain('NODE_BUILTINS_UNAVAILABLE');
    }
  });

  it('serves require("path") from an inlined POSIX path module in both floats', () => {
    // `path` can no longer be fetched from a CDN, so each float ships the same
    // `nodePath` implementation (parity helper).
    for (const src of [sandboxSrc, sharedSrc]) {
      expect(src).toContain('nodePath');
    }
    // Worker float imports the canonical implementation; sandbox inlines it.
    expect(sharedSrc).toMatch(/import[\s\S]*nodePath[\s\S]*js-realm-helpers/);
    expect(sandboxSrc).toContain('const nodePath = (function () {');
  });
});
