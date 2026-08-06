import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  baselineFiles,
  compareToBaseline,
  findLayerBackEdges,
  isWebappSource,
  layerOf,
  scanBackEdges,
} from './check-layer-back-edges.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-layer-back-edges.mjs');

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-layer-back-edges: layerOf', () => {
  it('returns the first path segment', () => {
    expect(layerOf('cdp/remote-cdp-transport.ts')).toBe('cdp');
    expect(layerOf('shell/supplemental-commands/open-command.ts')).toBe('shell');
  });
});

describe('check-layer-back-edges: findLayerBackEdges', () => {
  it('flags an import that points up the stack', () => {
    const hits = findLayerBackEdges(
      'cdp/remote-cdp-transport.ts',
      "import { reassembleCDPResponse } from '../scoops/tray-sync-protocol.js';"
    );
    expect(hits).toEqual([
      { line: 1, specifier: '../scoops/tray-sync-protocol.js', from: 'cdp', to: 'scoops' },
    ]);
  });

  it('allows imports pointing down the stack or within a layer', () => {
    const source = [
      "import { VirtualFS } from '../fs/virtual-fs.js';",
      "import { CDPClient } from './cdp-client.js';",
    ].join('\n');
    expect(findLayerBackEdges('cdp/browser-api.ts', source)).toEqual([]);
  });

  it('treats shell/ and git/ as the same rung', () => {
    expect(
      findLayerBackEdges('shell/vfs-adapter.ts', "import x from '../git/git-commands.js';")
    ).toEqual([]);
    expect(findLayerBackEdges('git/git-commands.ts', "import x from '../shell/types.js';")).toEqual(
      []
    );
  });

  it('flags ui/ imports from unranked directories but nothing lower', () => {
    expect(findLayerBackEdges('kernel/host.ts', "import x from '../ui/dip.js';")).toHaveLength(1);
    expect(
      findLayerBackEdges('kernel/host.ts', "import x from '../scoops/orchestrator.js';")
    ).toEqual([]);
  });

  it('ignores imports into unranked directories and bare package specifiers', () => {
    const source = [
      "import x from '../kernel/panel-rpc.js';",
      "import y from '@slicc/shared-ts';",
    ].join('\n');
    expect(findLayerBackEdges('cdp/panel-rpc-tray-provider.ts', source)).toEqual([]);
  });

  it('covers dynamic import and require forms, and ignores comments', () => {
    const source = [
      "// import { a } from '../ui/a.js';",
      "const b = await import('../ui/b.js');",
      "const c = require('../ui/c.js');",
    ].join('\n');
    expect(findLayerBackEdges('core/session.ts', source).map((h) => h.line)).toEqual([2, 3]);
  });
});

describe('check-layer-back-edges: isWebappSource', () => {
  it('accepts .ts and .tsx source', () => {
    expect(isWebappSource('export-service.ts')).toBe(true);
    expect(isWebappSource('widget.tsx')).toBe(true);
  });

  it('rejects tests and non-TS files', () => {
    expect(isWebappSource('export-service.test.ts')).toBe(false);
    expect(isWebappSource('widget.test.tsx')).toBe(false);
    expect(isWebappSource('README.md')).toBe(false);
  });
});

describe('check-layer-back-edges: baselineFiles', () => {
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

describe('check-layer-back-edges: compareToBaseline', () => {
  it('passes when current matches the baseline exactly', () => {
    expect(compareToBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([]);
  });

  it('fails on a NEW back-edge in an unbaselined file', () => {
    const failures = compareToBaseline({ 'b.ts': 1 }, {});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('b.ts: 1 layer back-edge(s), baseline allows 0');
  });

  it('fails when a baselined file grows more back-edges', () => {
    const failures = compareToBaseline({ 'a.ts': 3 }, { 'a.ts': 2 });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('baseline allows 2');
  });

  it('fails (ratchet) when a file has fewer back-edges than the baseline', () => {
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

describe('check-layer-back-edges: end-to-end over the real tree', () => {
  it('scan matches the committed baseline (one-way ratchet holds)', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    expect(compareToBaseline(scanBackEdges(), baseline)).toEqual([]);
  });

  it('guard entry script passes and reports the grandfathered count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no new layer back-edges in packages\/webapp\/src/);
  });
});
