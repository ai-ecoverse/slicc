/**
 * #2276 slice C, network domain (review-patterns category 10): business
 * logic in `scoops/` never asks "am I in the extension?" — runtime detection
 * happens at composition time in the transport layer that owns topology.
 *
 * `scoops/tray-leader.ts` used to answer that question itself inside
 * `createTrayFetch`. Caching the probe in `base/api-endpoint.ts` and reading
 * the cache from `tray-leader.ts` would have been the SAME probe under a new
 * name, still in `scoops/` — a slice-D lint gate keyed on probe names would
 * be bypassed by exactly that move. So `createTrayFetch` (and its
 * `TrayProxyFetchError`) moved to `shell/tray-fetch.ts`, a sibling of
 * `proxied-fetch.ts`: `scoops/tray-leader.ts` now asks for a fetch
 * implementation and gets one, with NO realm or topology read anywhere in
 * the file, re-exporting the factory under its established name so existing
 * callers keep this module as their address.
 *
 * `shell/proxied-fetch.ts` and `shell/tray-fetch.ts` are where topology is
 * OWNED (`shell/float-topology.ts`'s header says so), so they may read the
 * cached fact — `getChromeExtensionRealm()` in `base/api-endpoint.ts`, which
 * is itself still a probe (see its doc comment), just a deduped one.
 *
 * `shell/mcp/redirect-uri.ts` takes `topology` as a parameter; its two
 * callers (`shell/mcp/provider.ts`, `shell/supplemental-commands/mcp-
 * command.ts`) resolve `resolveFloatTopology()` at their own call site —
 * that is fine, `shell/` owns topology, this is not a relocation to fix.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', 'src', ...parts), 'utf8');

const FLOAT_PROBE_NAMES = [
  'isExtensionRealm',
  'isChromeExtensionRealm',
  'hasLocalNodeServer',
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',
  // True on the thin-bridge hosted page just like the six above — the same
  // class of float signal, and belongs on the same ban list (round-2 review).
  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',
] as const;

const FLOAT_PROBE_PATTERN = new RegExp(FLOAT_PROBE_NAMES.join('|'));

describe('#2276 slice C — scoops/tray-leader.ts has no float/topology read at all', () => {
  it('contains none of the float-probe names, anywhere in the file — not just its imports', () => {
    // The whole file, not just import statements: a call site that imports
    // the name under an alias, or re-derives it inline, would still be a
    // probe in the wrong layer. Comments ARE allowed to name a probe while
    // explaining it moved away — none of the current file's comments do,
    // so this stays a whole-source scan rather than carving out prose.
    const source = src('scoops', 'tray-leader.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('gets its fetch factory from shell/, a downward import', () => {
    const source = src('scoops', 'tray-leader.ts');
    expect(source).toContain("from '../shell/tray-fetch.js'");
  });
});

describe('#2276 slice C — shell/ owns topology and may read the cached fact', () => {
  it('shell/tray-fetch.ts holds the realm branch createTrayFetch needs', () => {
    const source = src('shell', 'tray-fetch.ts');
    expect(source).toContain('getChromeExtensionRealm()');
  });

  it('shell/tray-fetch.ts does not re-export getChromeExtensionRealm under any name', () => {
    // The cheapest bypass of a name-keyed gate: `export const isTrayExtension
    // = getChromeExtensionRealm` here, imported by `scoops/` under the new
    // name, reintroduces the exact branch this slice removed without ever
    // matching a literal `getChromeExtensionRealm` string at the scoops/
    // call site. This only catches the "still exported under the SAME name"
    // half of that; the rename half is why slice D needs a dataflow-aware
    // gate, not a name grep — see the TODO in `capability/index.ts`.
    const source = src('shell', 'tray-fetch.ts');
    const exportLines = [...source.matchAll(/^export .*$/gm)].map((m) => m[0]);
    expect(exportLines.some((line) => line.includes('getChromeExtensionRealm'))).toBe(false);
  });

  it('shell/proxied-fetch.ts reads the same cached fact for its own extension branch', () => {
    const source = src('shell', 'proxied-fetch.ts');
    expect(source).toContain('getChromeExtensionRealm()');
  });

  it('base/api-endpoint.ts is the one place that imports the live probe, and caches it', () => {
    const source = src('base', 'api-endpoint.ts');
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+'[^']+';$/gm)]
      .map((m) => m[0])
      .join('\n');
    expect(imports).toMatch(/isChromeExtensionRealm/);
    // Cached (read once, reused), not re-probed on every getter call.
    expect(source).toContain('let chromeExtensionRealm: boolean | null = null;');
  });
});

describe('#2276 slice C — redirect-uri.ts takes topology by injection', () => {
  it('resolveMcpRedirectUri takes topology as a parameter, not a return of its own probe', () => {
    const source = src('shell', 'mcp', 'redirect-uri.ts');
    expect(source).toContain('resolveMcpRedirectUri(topology: FloatTopology)');
  });

  it('its two callers resolve topology at their own call site — shell/ owns it, this is not a relocation to fix', () => {
    for (const parts of [
      ['shell', 'mcp', 'provider.ts'],
      ['shell', 'supplemental-commands', 'mcp-command.ts'],
    ] as const) {
      const source = src(...parts);
      expect(source).toContain('resolveMcpRedirectUri(resolveFloatTopology())');
    }
  });
});

describe('#2276 slice C — the guard actually catches the old shape', () => {
  const scan = (source: string) => FLOAT_PROBE_NAMES.filter((name) => source.includes(name));

  it('would fail if tray-leader.ts read the float again (documents the regression this guards against)', () => {
    // Not a real mutation test (that would require writing to source during a
    // test run) — this pins the exact string a regression would reintroduce,
    // so the assertion above is provably not a vacuous "innocuous term never
    // appears" check.
    const regressed = 'const isExtension = getChromeExtensionRealm();\nif (isExtension) {';
    expect(FLOAT_PROBE_PATTERN.test(regressed)).toBe(true);
  });

  it('catches an import of getChromeExtensionRealm from shell/tray-fetch.ts, not only from base/api-endpoint.ts', () => {
    // The scan is a whole-source name match, not tied to an import path, so
    // it does not matter which `shell/` module a future re-import comes
    // from — reusing the REAL current file plus one injected import line
    // proves that, rather than a hand-written fragment.
    const realSource = src('scoops', 'tray-leader.ts');
    expect(scan(realSource)).toEqual([]);
    const withRegressedImport = `import { getChromeExtensionRealm } from '../shell/tray-fetch.js';\n${realSource}`;
    expect(scan(withRegressedImport)).toEqual(['getChromeExtensionRealm']);
  });
});
