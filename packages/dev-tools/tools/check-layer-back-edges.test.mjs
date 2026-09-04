import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  baselineFiles,
  compareToBaseline,
  findChromeExtensionWebappEscapes,
  findCrossPackageEscapes,
  findLayerBackEdges,
  isWebappSource,
  layerOf,
  scanBackEdges,
  scanChromeExtensionWebappEscapes,
  scanCrossPackageEscapes,
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

  it('catches bare side-effect imports (registration/CSS form)', () => {
    const source = [
      "import '../ui/wc/foo.js';",
      "import './same-layer-polyfill.js';",
      'import "../ui/double-quoted.js";',
    ].join('\n');
    expect(findLayerBackEdges('core/session.ts', source).map((h) => h.line)).toEqual([1, 3]);
  });

  // Regression fixtures for the import shapes that slipped past #1960's
  // per-shape text patterns: specifier count and clause shape must not matter.
  it('catches multi-specifier imports and re-exports regardless of clause shape', () => {
    const source = [
      "import { a, b, type C } from '../ui/multi.js';",
      "import def, { d } from '../ui/mixed.js';",
      "export { e, f } from '../ui/re-export.js';",
      "export * from '../ui/star.js';",
      "import type { G } from '../ui/types.js';",
    ].join('\n');
    expect(findLayerBackEdges('core/session.ts', source).map((h) => h.line)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("matches Prettier's multiline dynamic import form (line = the import keyword)", () => {
    const source = "const irrelevant = 1;\nconst m = await import(\n  '../ui/lazy.js'\n);";
    expect(findLayerBackEdges('core/session.ts', source)).toEqual([
      { line: 2, specifier: '../ui/lazy.js', from: 'core', to: 'ui' },
    ]);
  });

  it('resolves specifiers against the importer dir, not by specifier text', () => {
    // scoops/sub/x.ts + '../ui/y.js' → scoops/ui/y.js: same layer, NOT a back-edge
    // (a '../ui/' text match would false-positive here).
    expect(findLayerBackEdges('scoops/sub/x.ts', "import y from '../ui/y.js';")).toEqual([]);
    // One more rung up it really is ui/: back-edge.
    expect(findLayerBackEdges('scoops/sub/x.ts', "import y from '../../ui/y.js';")).toEqual([
      { line: 1, specifier: '../../ui/y.js', from: 'scoops', to: 'ui' },
    ]);
  });
});

describe('check-layer-back-edges: findCrossPackageEscapes', () => {
  it('flags a relative import that climbs into a sibling package', () => {
    expect(
      findCrossPackageEscapes(
        'base/tray-url-config.ts',
        "import { parseTrayJoinUrl } from '../../../node-server/src/tray-url-shared.js';"
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../../../node-server/src/tray-url-shared.js',
        to: 'packages/node-server/src/tray-url-shared.js',
      },
    ]);
  });

  it('allows imports that stay inside packages/webapp/src', () => {
    const source = [
      "import { createLogger } from '../base/logger.js';",
      "import { CDPClient } from './cdp-client.js';",
      "import x from '../../fs/index.js';",
    ].join('\n');
    expect(findCrossPackageEscapes('cdp/nested/browser-api.ts', source)).toEqual([]);
  });

  it('allows inert asset imports (?raw / ?url) that carry the bytes, not the module', () => {
    const source = [
      "import sudoers from '../../../vfs-root/etc/sudoers?raw';",
      "import fontUrl from '../../../../assets/fonts/AdobeClean-Regular.otf?url';",
    ].join('\n');
    expect(findCrossPackageEscapes('sudo/sudo-manager.ts', source)).toEqual([]);
  });

  it('still flags escapes whose query EXECUTES the target (?worker et al.)', () => {
    // The exemption is an allowlist, not "any query": Vite bundles and runs a
    // `?worker` target, so waving it through would reopen the very
    // wrong-direction package dependency this gate exists to stop.
    for (const query of ['?worker', '?sharedworker', '?inline', '?raw&inline']) {
      const source = `import W from '../../../node-server/src/tray-url-shared.js${query}';`;
      expect(findCrossPackageEscapes('base/tray-url-config.ts', source)).toEqual([
        {
          line: 1,
          specifier: `../../../node-server/src/tray-url-shared.js${query}`,
          to: 'packages/node-server/src/tray-url-shared.js',
        },
      ]);
    }
  });

  it('ignores bare package specifiers', () => {
    expect(
      findCrossPackageEscapes('base/x.ts', "import { parseTrayJoinUrl } from '@slicc/shared-ts';")
    ).toEqual([]);
  });

  it('ignores escapes inside comments', () => {
    const source = "// import x from '../../../node-server/src/tray-url-shared.js';";
    expect(findCrossPackageEscapes('base/x.ts', source)).toEqual([]);
  });
});

describe('check-layer-back-edges: findChromeExtensionWebappEscapes', () => {
  it('allows the one permitted exception: a top-level type-only clause from kernel/messages.ts', () => {
    const source = "import type { ExtensionMessage } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('service-worker.ts', source)).toEqual([]);
  });

  it('flags a VALUE import from kernel/messages.ts (no runtime coupling exemption)', () => {
    const source =
      "import { LEADER_EXT_ID_QUERY_NAME } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('service-worker.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/kernel/messages.js',
        to: 'packages/webapp/src/kernel/messages.js',
      },
    ]);
  });

  it('flags a MIXED clause ({ type X, Y }) from kernel/messages.ts', () => {
    // A mixed clause carries a real value import alongside the type — the
    // top-level `import type` exemption is deliberately narrower than this.
    const source =
      "import { type ExtensionMessage, LEADER_EXT_ID_QUERY_NAME } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('service-worker.ts', source)).toHaveLength(1);
  });

  it('flags a type-only import of any OTHER webapp module (exemption is path-specific)', () => {
    const source = "import type { TargetInfo } from '../../webapp/src/cdp/types.js';";
    expect(findChromeExtensionWebappEscapes('bridge-sw.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/cdp/types.js',
        to: 'packages/webapp/src/cdp/types.js',
      },
    ]);
  });

  it('flags a dynamic import() targeting webapp/src', () => {
    const source = "async function f() { await import('../../webapp/src/net/handoff-link.js'); }";
    expect(findChromeExtensionWebappEscapes('discovery-observer.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/net/handoff-link.js',
        to: 'packages/webapp/src/net/handoff-link.js',
      },
    ]);
  });

  it('flags a namespace import targeting webapp/src', () => {
    const source = "import * as messages from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('service-worker.ts', source)).toHaveLength(1);
  });

  it('allows imports that stay inside packages/chrome-extension/src', () => {
    const source = [
      "import { CHERRY_PANEL_PORT_NAME } from './cherry-panel-protocol.js';",
      "import { nudgeIframeRepaint } from './iframe-repaint.js';",
    ].join('\n');
    expect(findChromeExtensionWebappEscapes('sidepanel-entry.ts', source)).toEqual([]);
  });

  it('allows bare package specifiers (the real path for shared code)', () => {
    const source = "import { probeWellKnown } from '@slicc/shared-ts';";
    expect(findChromeExtensionWebappEscapes('discovery-observer.ts', source)).toEqual([]);
  });

  it('flags a template-literal (backtick) dynamic import() targeting webapp/src', () => {
    const source = 'async function f() { await import(`../../webapp/src/net/handoff-link.js`); }';
    expect(findChromeExtensionWebappEscapes('discovery-observer.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/net/handoff-link.js',
        to: 'packages/webapp/src/net/handoff-link.js',
      },
    ]);
  });

  it('flags an interpolated template-literal import() whose literal text lands on webapp/src', () => {
    const source = 'async function f(mod) { await import(`../../webapp/src/net/${mod}.js`); }';
    const hits = findChromeExtensionWebappEscapes('discovery-observer.ts', source);
    expect(hits).toHaveLength(1);
    expect(hits[0].specifier).toContain('webapp/src');
  });

  it('allows an interpolated template-literal import() that does NOT reference webapp/src', () => {
    const source = 'async function f(mod) { await import(`./commands/${mod}.js`); }';
    expect(findChromeExtensionWebappEscapes('discovery-observer.ts', source)).toEqual([]);
  });

  it('flags a concatenated (+-joined) specifier targeting webapp/src', () => {
    const source = "import('../../webapp' + '/src/net/handoff-link.js');";
    expect(findChromeExtensionWebappEscapes('discovery-observer.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/net/handoff-link.js',
        to: 'packages/webapp/src/net/handoff-link.js',
      },
    ]);
  });

  it('flags a triple-slash reference path targeting webapp/src', () => {
    const source = '/// <reference path="../../webapp/src/cdp/types.ts" />\nexport {};';
    expect(findChromeExtensionWebappEscapes('bridge-sw.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/cdp/types.ts',
        to: 'packages/webapp/src/cdp/types.ts',
      },
    ]);
  });

  it('flags "export type { ... } from" — only a top-level "import type {" clause is granted', () => {
    const source = "export type { ExtensionMessage } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('service-worker.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/kernel/messages.js',
        to: 'packages/webapp/src/kernel/messages.js',
      },
    ]);
  });

  it('ignores escapes inside comments', () => {
    const source = "// import { x } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('service-worker.ts', source)).toEqual([]);
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

  it('no webapp source escapes into a sibling package (zero tolerance)', () => {
    expect(scanCrossPackageEscapes()).toEqual({});
  });

  it('no chrome-extension source escapes into packages/webapp/src beyond the one exemption (zero tolerance)', () => {
    expect(scanChromeExtensionWebappEscapes()).toEqual({});
  });

  it('guard entry script passes and reports the grandfathered count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no new layer back-edges/);
  });
});
