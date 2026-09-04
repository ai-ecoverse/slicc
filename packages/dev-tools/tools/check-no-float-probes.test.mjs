import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  baselineFiles,
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

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-no-float-probes: isBannedZoneFile', () => {
  it('bans scoops/, tools/, and kernel/ (except kernel/host.ts)', () => {
    expect(isBannedZoneFile('scoops/orchestrator.ts')).toBe(true);
    expect(isBannedZoneFile('tools/bash-tool.ts')).toBe(true);
    expect(isBannedZoneFile('kernel/telemetry.ts')).toBe(true);
    expect(isBannedZoneFile('kernel/host.ts')).toBe(false);
  });

  it('allows every other layer, including shell/ (which owns topology)', () => {
    expect(isBannedZoneFile('shell/float-topology.ts')).toBe(false);
    expect(isBannedZoneFile('ui/main.ts')).toBe(false);
    expect(isBannedZoneFile('core/secret-topology.ts')).toBe(false);
    expect(isBannedZoneFile('base/api-endpoint.ts')).toBe(false);
  });
});

describe('check-no-float-probes: findBannedZoneProbes', () => {
  it('flags a named import of a banned probe', () => {
    const source = "import { hasLocalNodeServer } from '../core/float-topology.js';";
    expect(findBannedZoneProbes(source)).toEqual([{ line: 1, name: 'hasLocalNodeServer' }]);
  });

  it('flags an aliased import by its ORIGINAL name, not the local alias', () => {
    const source = "import { isExtensionRealm as isExt } from '../base/runtime-env.js';";
    expect(findBannedZoneProbes(source)).toEqual([{ line: 1, name: 'isExtensionRealm' }]);
  });

  it('flags a same-name re-export', () => {
    const source = "export { resolveFloatTopology } from './float-topology.js';";
    expect(findBannedZoneProbes(source)).toEqual([{ line: 1, name: 'resolveFloatTopology' }]);
  });

  it('flags every one of the eight names', () => {
    for (const name of FLOAT_PROBE_NAMES) {
      const source = `import { ${name} } from '../x.js';`;
      expect(findBannedZoneProbes(source)).toEqual([{ line: 1, name }]);
    }
  });

  it('does NOT flag a local const/parameter/property reusing the same name — the sanctioned idiom', () => {
    // The exact shapes slices A–C's migrations landed: a composition-time
    // answer stored under the SAME name as the probe it replaced, so call
    // sites read identically either way.
    const sources = [
      'const hasLocalNodeServer = () => localNode.ok;',
      'function getModeLabel(isExtensionRealm: boolean) { return isExtensionRealm; }',
      'webhook: { hasLocalNodeServer },',
      'export interface CrontaskCommandOptions { hasLocalNodeServer?: () => boolean; }',
    ];
    for (const source of sources) {
      expect(findBannedZoneProbes(source)).toEqual([]);
    }
  });

  it('does not flag names inside comments', () => {
    const source = "// import { hasLocalNodeServer } from '../core/float-topology.js';";
    expect(findBannedZoneProbes(source)).toEqual([]);
  });

  it('folds discovered alias names into the scan when passed as extraNames', () => {
    const source = "import { resolveSecretTopology } from '../core/secret-topology.js';";
    expect(findBannedZoneProbes(source)).toEqual([]);
    expect(findBannedZoneProbes(source, ['resolveSecretTopology'])).toEqual([
      { line: 1, name: 'resolveSecretTopology' },
    ]);
  });
});

describe('check-no-float-probes: findAliasedProbeReExports', () => {
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

  it('does not flag a same-name re-export (findBannedZoneProbes already covers that shape)', () => {
    const source = "export { hasLocalNodeServer } from '../shell/float-topology.js';";
    expect(findAliasedProbeReExports(source)).toEqual([]);
  });

  it('does not flag a call-result const (a composition-time answer, not a probe re-export)', () => {
    const source = 'export const isExtension = isExtensionRealm();';
    expect(findAliasedProbeReExports(source)).toEqual([]);
  });

  it('does not flag renaming one banned name to ANOTHER banned name (already fully covered)', () => {
    const source = "export { isExtensionRealm as isChromeExtensionRealm } from '../x.js';";
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

  it('guard entry script passes and reports the zero-grandfathered baseline', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no new float-probe reads under scoops\/, tools\/, kernel\//);
    expect(out).toContain('0 grandfathered in 0 baselined files');
  });
});
