import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  baselineFiles,
  CONNECT_MODE_IDENTIFIER,
  compareToBaseline,
  discoveredAliasNames,
  FLOAT_PROBE_NAMES,
  findAliasedProbeReExports,
  findBannedZoneProbes,
  isBannedZoneFile,
  scanAliasedProbeReExports,
  scanBannedZoneProbes,
} from './check-no-float-probes.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-no-float-probes.mjs');
const scanRoot = resolve(repoRoot, 'packages/webapp/src');

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard(args = []) {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-no-float-probes: FLOAT_PROBE_NAMES (exact list, round-1 review #2843)', () => {
  it('is the ten identifiers resolveFloatTopology and its neighbors actually read', () => {
    // Snapshotted, not just length-checked: a name silently dropped from
    // this list (as `getExtensionDelegateId`/`setExtensionDelegateId` were,
    // pre-round-1) is exactly the kind of change this test exists to catch.
    expect(FLOAT_PROBE_NAMES).toEqual([
      'isExtensionRealm',
      'isChromeExtensionRealm',
      'hasLocalNodeServer',
      'resolveFloatTopology',
      'getChromeExtensionRealm',
      'setChromeExtensionRealm',
      'hasChromeRuntimeConnect',
      'canConnectToChromeRuntime',
      'getExtensionDelegateId',
      'setExtensionDelegateId',
    ]);
  });
});

describe('check-no-float-probes: isBannedZoneFile', () => {
  it('bans scoops/, tools/, and kernel/ except the exempt composition roots', () => {
    expect(isBannedZoneFile('scoops/orchestrator.ts')).toBe(true);
    expect(isBannedZoneFile('tools/bash-tool.ts')).toBe(true);
    expect(isBannedZoneFile('kernel/telemetry.ts')).toBe(true);
    expect(isBannedZoneFile('kernel/host.ts')).toBe(false);
    expect(isBannedZoneFile('kernel/kernel-worker.ts')).toBe(false);
    expect(isBannedZoneFile('kernel/port-bridge-client.ts')).toBe(false);
  });

  it('allows every other layer, including shell/ (which owns topology)', () => {
    expect(isBannedZoneFile('shell/float-topology.ts')).toBe(false);
    expect(isBannedZoneFile('ui/main.ts')).toBe(false);
    expect(isBannedZoneFile('core/secret-topology.ts')).toBe(false);
    expect(isBannedZoneFile('base/api-endpoint.ts')).toBe(false);
  });
});

describe('check-no-float-probes: findBannedZoneProbes — module-path ban (round-1 review #2843, P1)', () => {
  // Every one of Grok's planted evasions against the FIRST version of this
  // gate, each now a named regression test. All resolve against
  // `scoops/example.ts` — one directory level under `packages/webapp/src`,
  // so `../shell/…` / `../core/…` / `../base/…` land exactly on the probe
  // modules.
  const IMPORTER = 'scoops/example.ts';

  it('flags a namespace import of a probe-only module', () => {
    const source = "import * as topo from '../shell/float-topology.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../shell/float-topology.js'" },
    ]);
  });

  it('flags a dynamic import + destructure of a probe-only module', () => {
    const source =
      "async function f() { const { hasLocalNodeServer } = await import('../shell/float-topology.js'); }";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../shell/float-topology.js'" },
    ]);
  });

  it('flags a default import of a probe-only module', () => {
    const source = "import topo from '../shell/float-topology.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../shell/float-topology.js'" },
    ]);
  });

  it('flags a namespace import of a re-export barrel (core/float-topology.ts mirroring shell/)', () => {
    const source =
      "import * as topo from '../core/float-topology.js';\nconsole.log(topo.hasLocalNodeServer());";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../core/float-topology.js'" },
    ]);
  });

  it('flags a type-only import of a probe-only module (the type describes topology too)', () => {
    const source = "import type { FloatTopology } from '../shell/float-topology.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../shell/float-topology.js'" },
    ]);
  });

  it('flags export * from a probe-only module', () => {
    const source = "export * from '../shell/float-topology.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../shell/float-topology.js'" },
    ]);
  });

  it('flags a require() of a probe-only module', () => {
    const source = "const { hasLocalNodeServer } = require('../shell/float-topology.js');";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../shell/float-topology.js'" },
    ]);
  });

  it('flags a multi-line (Prettier-wrapped) braced clause from a probe-only module', () => {
    const source =
      "import {\n  hasLocalNodeServer,\n  isExtensionRealm,\n} from '../base/runtime-env.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: "import from '../base/runtime-env.js'" },
    ]);
  });

  it('flags every one of the four probe-only modules, resolved relative to the importer', () => {
    for (const spec of [
      '../shell/float-topology.js',
      '../core/float-topology.js',
      '../base/runtime-env.js',
      '../core/runtime-env.js',
    ]) {
      const source = `import { x } from '${spec}';`;
      expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
        { line: 1, what: `import from '${spec}'` },
      ]);
    }
  });
});

describe('check-no-float-probes: findBannedZoneProbes — named scan on mixed-surface modules (round-1 review #2843, P1)', () => {
  const IMPORTER = 'kernel/example.ts';

  it('flags getExtensionDelegateId named from shell/proxied-fetch.js', () => {
    const source = "import { getExtensionDelegateId } from '../shell/proxied-fetch.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: 'getExtensionDelegateId' },
    ]);
  });

  it('flags setExtensionDelegateId named from base/api-endpoint.js', () => {
    const source = "import { setExtensionDelegateId } from '../base/api-endpoint.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([
      { line: 1, what: 'setExtensionDelegateId' },
    ]);
  });

  it('does NOT flag an unrelated named import from those same mixed-surface modules', () => {
    expect(
      findBannedZoneProbes(IMPORTER, "import { resolveApiUrl } from '../base/api-endpoint.js';")
    ).toEqual([]);
    expect(
      findBannedZoneProbes(IMPORTER, "import { apiHeaders } from '../shell/proxied-fetch.js';")
    ).toEqual([]);
  });

  it('does NOT flag a type-only import of a probe NAME from a mixed-surface module (inert at runtime)', () => {
    const source = "import type { hasLocalNodeServer } from '../base/api-endpoint.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([]);
  });

  it('flags the two shared-ts probe names, but not the package itself', () => {
    expect(
      findBannedZoneProbes(IMPORTER, "import { isChromeExtensionRealm } from '@slicc/shared-ts';")
    ).toEqual([{ line: 1, what: 'isChromeExtensionRealm' }]);
    expect(
      findBannedZoneProbes(
        IMPORTER,
        "import { canConnectToChromeRuntime } from '@slicc/shared-ts';"
      )
    ).toEqual([{ line: 1, what: 'canConnectToChromeRuntime' }]);
    expect(
      findBannedZoneProbes(IMPORTER, "import { someOtherThing } from '@slicc/shared-ts';")
    ).toEqual([]);
  });
});

describe('check-no-float-probes: findBannedZoneProbes — __slicc_connect_mode (round-1 review #2843, P1)', () => {
  it('flags the raw connect-mode global property identifier', () => {
    const source = 'if (globalThis.__slicc_connect_mode) { doStuff(); }';
    expect(findBannedZoneProbes('scoops/example.ts', source)).toEqual([
      { line: 1, what: CONNECT_MODE_IDENTIFIER },
    ]);
  });
});

describe('check-no-float-probes: findBannedZoneProbes — false positives (round-1 review #2843, P2)', () => {
  const IMPORTER = 'scoops/example.ts';

  it('does not flag a string literal containing import-shaped text', () => {
    const source = `export const example = "import { hasLocalNodeServer } from '../x.js'";`;
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([]);
  });

  it('does not flag names inside comments', () => {
    const source = "// import { hasLocalNodeServer } from '../shell/float-topology.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([]);
  });

  it('does not flag a local const/parameter/property reusing a probe name — the sanctioned idiom', () => {
    const sources = [
      'const hasLocalNodeServer = () => localNode.ok;',
      'function getModeLabel(isExtensionRealm) { return isExtensionRealm; }',
      'webhook: { hasLocalNodeServer },',
      'export interface CrontaskCommandOptions { hasLocalNodeServer?: () => boolean; }',
    ];
    for (const source of sources) {
      expect(findBannedZoneProbes(IMPORTER, source)).toEqual([]);
    }
  });

  it('does not flag a type-only named import of an unrelated function from an unrelated module', () => {
    const source = "import type { hasLocalNodeServer } from '../some/unrelated-module.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([]);
  });

  it('folds discovered alias names into the scan when passed as extraNames', () => {
    const source = "import { resolveSecretTopology } from '../core/secret-topology.js';";
    expect(findBannedZoneProbes(IMPORTER, source)).toEqual([]);
    expect(findBannedZoneProbes(IMPORTER, source, ['resolveSecretTopology'])).toEqual([
      { line: 1, what: 'resolveSecretTopology' },
    ]);
  });
});

describe('check-no-float-probes: findAliasedProbeReExports (round-1 review #2843)', () => {
  it('flags a bare-value re-export under a new name', () => {
    const source = 'export const isTrayExtension = getChromeExtensionRealm;';
    expect(findAliasedProbeReExports(source)).toEqual([
      { line: 1, from: 'getChromeExtensionRealm', to: 'isTrayExtension' },
    ]);
  });

  it('flags a renamed named re-export', () => {
    const source = "export { getChromeExtensionRealm as isTrayExtension } from '../base/x.js';";
    expect(findAliasedProbeReExports(source)).toEqual([
      { line: 1, from: 'getChromeExtensionRealm', to: 'isTrayExtension' },
    ]);
  });

  it('flags a wrapper FUNCTION that calls the probe in its body', () => {
    const source = 'export function inExtension() { return isExtensionRealm(); }';
    expect(findAliasedProbeReExports(source)).toEqual([
      { line: 1, from: 'isExtensionRealm', to: 'inExtension' },
    ]);
  });

  it('flags an ARROW wrapper that calls the probe in its body', () => {
    const source = 'export const inExtension = () => isExtensionRealm();';
    expect(findAliasedProbeReExports(source)).toEqual([
      { line: 1, from: 'isExtensionRealm', to: 'inExtension' },
    ]);
  });

  it('flags an async arrow wrapper too', () => {
    const source = 'export const inExtension = async () => hasLocalNodeServer();';
    expect(findAliasedProbeReExports(source)).toEqual([
      { line: 1, from: 'hasLocalNodeServer', to: 'inExtension' },
    ]);
  });

  it('does NOT flag a same-name re-export (findBannedZoneProbes already covers that shape)', () => {
    const source = "export { hasLocalNodeServer } from '../shell/float-topology.js';";
    expect(findAliasedProbeReExports(source)).toEqual([]);
  });

  it('does NOT flag a call-result const (a composition-time answer, not a probe re-export)', () => {
    const source = 'export const isExtension = isExtensionRealm();';
    expect(findAliasedProbeReExports(source)).toEqual([]);
  });

  it('does NOT flag renaming one banned name to ANOTHER banned name (already fully covered)', () => {
    const source = "export { isExtensionRealm as isChromeExtensionRealm } from '../x.js';";
    expect(findAliasedProbeReExports(source)).toEqual([]);
  });

  it("does NOT flag a plain IMPORT's local alias — restricted to export forms (round-1 review #2843, P3)", () => {
    // `inExt` is a name confined to THIS one (allowed-layer) file; treating
    // it as a globally-discovered alias would poison every banned-zone file
    // that happens to use the same short local name for something else.
    const source = "import { isExtensionRealm as inExt } from '../base/runtime-env.js';";
    expect(findAliasedProbeReExports(source)).toEqual([]);
  });
});

describe('check-no-float-probes: discoveredAliasNames', () => {
  it('flattens every "to" name across every aliasing file', () => {
    const scan = {
      'a.ts': [{ line: 1, from: 'hasLocalNodeServer', to: 'x' }],
      'b.ts': [
        { line: 1, from: 'isExtensionRealm', to: 'y' },
        { line: 5, from: 'isExtensionRealm', to: 'y' },
      ],
    };
    expect(discoveredAliasNames(scan).sort()).toEqual(['x', 'y']);
  });

  it('returns [] for no aliases found', () => {
    expect(discoveredAliasNames({})).toEqual([]);
  });
});

describe('check-no-float-probes: baselineFiles', () => {
  it('returns the baseline keys as a debt list', () => {
    expect(baselineFiles({ 'a.ts': 2, 'b.ts': 1 })).toEqual(['a.ts', 'b.ts']);
  });

  it('returns [] for non-object or empty input', () => {
    expect(baselineFiles(null)).toEqual([]);
    expect(baselineFiles(undefined)).toEqual([]);
    expect(baselineFiles([])).toEqual([]);
    expect(baselineFiles({})).toEqual([]);
  });
});

describe('check-no-float-probes: compareToBaseline', () => {
  it('passes when current matches the baseline exactly', () => {
    expect(compareToBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([]);
  });

  it('fails on a NEW float-probe read in an unbaselined file', () => {
    const failures = compareToBaseline({ 'b.ts': 1 }, {});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('b.ts: 1 float-probe read(s), baseline allows 0');
  });

  it('fails when a baselined file grows more reads', () => {
    const failures = compareToBaseline({ 'a.ts': 3 }, { 'a.ts': 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('baseline allows 2');
  });

  it('fails (ratchet) when a file has fewer reads than the baseline', () => {
    const failures = compareToBaseline({ 'a.ts': 1 }, { 'a.ts': 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('--update');
  });

  it('fails on a stale baseline entry for a clean file', () => {
    const failures = compareToBaseline({}, { 'gone.ts': 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('stale');
  });
});

describe('check-no-float-probes: scanBannedZoneProbes — extraNames pass-through (round-1 review #2843, P2)', () => {
  // A temp file under a REAL banned-zone directory, importing a name that is
  // ONLY discoverable via the repo-wide alias scan — proves the extraNames
  // pass-through actually threads end to end through `scanBannedZoneProbes`,
  // not just through a direct `findBannedZoneProbes(..., extraNames)` call.
  // Deleting the extraNames pass-through (or the `core/secret-topology.ts`
  // alias it is discovered from) must fail this test.
  const tempRel = 'scoops/__temp_float_probe_alias_test__.ts';
  const tempAbs = resolve(scanRoot, tempRel);

  afterEach(() => {
    rmSync(tempAbs, { force: true });
  });

  it('flags a banned-zone import of resolveSecretTopology (discovered via core/secret-topology.ts)', () => {
    writeFileSync(
      tempAbs,
      "import { resolveSecretTopology } from '../core/secret-topology.js';\nresolveSecretTopology();\n"
    );
    const scan = scanBannedZoneProbes();
    expect(scan[`packages/webapp/src/${tempRel}`]).toBe(1);
  });
});

describe('check-no-float-probes: end-to-end over the real tree', () => {
  it('scan matches the committed EMPTY baseline (one-way ratchet holds, starts at zero)', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    expect(baseline).toEqual({});
    expect(compareToBaseline(scanBannedZoneProbes(), baseline)).toEqual([]);
  });

  it("core/secret-topology.ts's long-standing resolveFloatTopology rename is discovered but not itself flagged", () => {
    // #2276 predates this rename; it lives in core/ (not banned) and is
    // consumed only by core/ / providers/ / transcript/ call sites — see
    // the module doc comment for why that is fine, and why a FUTURE
    // scoops/tools/kernel import of resolveSecretTopology would not be.
    const aliases = scanAliasedProbeReExports();
    const secretTopologyFile = 'packages/webapp/src/core/secret-topology.ts';
    expect(aliases[secretTopologyFile]).toEqual([
      { line: 9, from: 'resolveFloatTopology', to: 'resolveSecretTopology' },
    ]);
    expect(discoveredAliasNames(aliases)).toContain('resolveSecretTopology');
  });

  it('kernel/port-bridge-client.ts and kernel/kernel-worker.ts are exempt, not clean by accident', () => {
    // Both have a genuine, live probe-name read today — the "0 grandfathered
    // files" result above is because they are EXEMPT, not because nothing
    // in kernel/ reads these names. If either file's read were ever removed
    // (or a real deny-listed read appeared elsewhere), this test would still
    // pass — it exists to make the exemption's premise visible, not to gate
    // on it.
    const portBridge = readFileSync(resolve(scanRoot, 'kernel/port-bridge-client.ts'), 'utf8');
    expect(portBridge).toContain('getExtensionDelegateId');
    const kernelWorker = readFileSync(resolve(scanRoot, 'kernel/kernel-worker.ts'), 'utf8');
    expect(kernelWorker).toContain('setExtensionDelegateId');
  });

  it('guard entry script passes and reports the zero-grandfathered baseline', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no new float-probe reads under scoops\/, tools\/, kernel\//);
    expect(out).toContain('0 grandfathered in 0 baselined files');
  });
});

describe('check-no-float-probes: --update refuses to grow the baseline without --allow-growth (round-1 review #2843, P2)', () => {
  const tempRel = 'scoops/__temp_float_probe_growth_test__.ts';
  const tempAbs = resolve(scanRoot, tempRel);
  const originalBaseline = readFileSync(BASELINE_PATH, 'utf8');

  afterEach(() => {
    rmSync(tempAbs, { force: true });
    writeFileSync(BASELINE_PATH, originalBaseline);
  });

  it('exits non-zero and leaves the baseline untouched when --update would grow it', () => {
    writeFileSync(
      tempAbs,
      "import { hasLocalNodeServer } from '../shell/float-topology.js';\nhasLocalNodeServer();\n"
    );
    const { code, out } = runGuard(['--update']);
    expect(code).toBe(1);
    expect(out).toContain('--allow-growth');
    expect(readFileSync(BASELINE_PATH, 'utf8')).toBe(originalBaseline);
  });

  it('writes the grown baseline when --allow-growth is passed', () => {
    writeFileSync(
      tempAbs,
      "import { hasLocalNodeServer } from '../shell/float-topology.js';\nhasLocalNodeServer();\n"
    );
    const { code, out } = runGuard(['--update', '--allow-growth']);
    expect(code).toBe(0);
    expect(out).toContain('baseline updated');
    const written = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    expect(written[`packages/webapp/src/${tempRel}`]).toBe(1);
  });
});
