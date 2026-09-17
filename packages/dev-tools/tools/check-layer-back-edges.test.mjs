import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  baselineFiles,
  chromeExtensionLayerOf,
  cloudflareWorkerLayerOf,
  compareToBaseline,
  findChromeExtensionWebappEscapes,
  findCrossPackageEscapes,
  findLayerBackEdges,
  findWebcomponentsWebappEscapes,
  isWebappSource,
  LAYER_STACKS,
  layerOf,
  nodeServerLayerOf,
  scanBackEdges,
  scanChromeExtensionWebappEscapes,
  scanCrossPackageEscapes,
  scanStackBackEdges,
  scanWebcomponentsWebappEscapes,
  stackById,
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

  it('flags a scoops/ VALUE import of kernel/ even though kernel/ is unranked (#3231)', () => {
    expect(
      findLayerBackEdges(
        'scoops/tray-runtime-config.ts',
        "import { LEADER_RUNTIME_QUERY_NAME } from '../kernel/messages.js';"
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../kernel/messages.js',
        from: 'scoops',
        to: 'kernel',
      },
    ]);
  });

  it('allows a scoops/ top-level import type { … } clause of kernel/', () => {
    expect(
      findLayerBackEdges(
        'scoops/orchestrator.ts',
        "import type { LocalVfsClient } from '../kernel/local-vfs-client.js';"
      )
    ).toEqual([]);
  });

  it('flags a scoops/ mixed { type X, Y } clause of kernel/ (value import)', () => {
    expect(
      findLayerBackEdges(
        'scoops/orchestrator.ts',
        "import { type ProcessManager, spawn } from '../kernel/process-manager.js';"
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../kernel/process-manager.js',
        from: 'scoops',
        to: 'kernel',
      },
    ]);
  });

  it('allows a scoops/ import type clause whose specifier itself contains "from"', () => {
    expect(
      findLayerBackEdges(
        'scoops/orchestrator.ts',
        "import type { bufferFrom } from '../kernel/realm/helpers/buffer-from.js';"
      )
    ).toEqual([]);
  });

  it('flags a scoops/ VALUE import whose specifier itself contains "from"', () => {
    expect(
      findLayerBackEdges(
        'scoops/orchestrator.ts',
        "import { bufferFrom } from '../kernel/realm/helpers/buffer-from.js';"
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../kernel/realm/helpers/buffer-from.js',
        from: 'scoops',
        to: 'kernel',
      },
    ]);
  });

  it('flags a scoops/ static template-literal import() of kernel/', () => {
    expect(
      findLayerBackEdges(
        'scoops/tray-runtime-config.ts',
        'const m = await import(`../kernel/messages.js`);'
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../kernel/messages.js',
        from: 'scoops',
        to: 'kernel',
      },
    ]);
  });

  it('flags a scoops/ interpolated template-literal import() whose text names kernel/', () => {
    expect(
      findLayerBackEdges(
        'scoops/orchestrator.ts',
        'const m = await import(`../kernel/${name}.js`);'
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../kernel/${name}.js',
        from: 'scoops',
        to: 'kernel',
      },
    ]);
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
    expect(findChromeExtensionWebappEscapes('src/service-worker.ts', source)).toEqual([]);
  });

  it('flags a VALUE import from kernel/messages.ts (no runtime coupling exemption)', () => {
    const source =
      "import { LEADER_EXT_ID_QUERY_NAME } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('src/service-worker.ts', source)).toEqual([
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
    expect(findChromeExtensionWebappEscapes('src/service-worker.ts', source)).toHaveLength(1);
  });

  it('flags a type-only import of any OTHER webapp module (exemption is path-specific)', () => {
    const source = "import type { TargetInfo } from '../../webapp/src/cdp/types.js';";
    expect(findChromeExtensionWebappEscapes('src/bridge-sw.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/cdp/types.js',
        to: 'packages/webapp/src/cdp/types.js',
      },
    ]);
  });

  it('flags a dynamic import() targeting webapp/src', () => {
    const source = "async function f() { await import('../../webapp/src/net/handoff-link.js'); }";
    expect(findChromeExtensionWebappEscapes('src/discovery-observer.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/net/handoff-link.js',
        to: 'packages/webapp/src/net/handoff-link.js',
      },
    ]);
  });

  it('flags a namespace import targeting webapp/src', () => {
    const source = "import * as messages from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('src/service-worker.ts', source)).toHaveLength(1);
  });

  it('allows imports that stay inside packages/chrome-extension/src', () => {
    const source = [
      "import { CHERRY_PANEL_PORT_NAME } from './cherry-panel-protocol.js';",
      "import { nudgeIframeRepaint } from './iframe-repaint.js';",
    ].join('\n');
    expect(findChromeExtensionWebappEscapes('src/sidepanel-entry.ts', source)).toEqual([]);
  });

  it('allows bare package specifiers (the real path for shared code)', () => {
    const source = "import { probeWellKnown } from '@slicc/shared-ts';";
    expect(findChromeExtensionWebappEscapes('src/discovery-observer.ts', source)).toEqual([]);
  });

  it('flags a template-literal (backtick) dynamic import() targeting webapp/src', () => {
    const source = 'async function f() { await import(`../../webapp/src/net/handoff-link.js`); }';
    expect(findChromeExtensionWebappEscapes('src/discovery-observer.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/net/handoff-link.js',
        to: 'packages/webapp/src/net/handoff-link.js',
      },
    ]);
  });

  it('flags an interpolated template-literal import() whose literal text lands on webapp/src', () => {
    const source = 'async function f(mod) { await import(`../../webapp/src/net/${mod}.js`); }';
    const hits = findChromeExtensionWebappEscapes('src/discovery-observer.ts', source);
    expect(hits).toHaveLength(1);
    expect(hits[0].specifier).toContain('webapp/src');
  });

  it('allows an interpolated template-literal import() that does NOT reference webapp/src', () => {
    const source = 'async function f(mod) { await import(`./commands/${mod}.js`); }';
    expect(findChromeExtensionWebappEscapes('src/discovery-observer.ts', source)).toEqual([]);
  });

  it('flags a concatenated (+-joined) specifier targeting webapp/src', () => {
    const source = "import('../../webapp' + '/src/net/handoff-link.js');";
    expect(findChromeExtensionWebappEscapes('src/discovery-observer.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/net/handoff-link.js',
        to: 'packages/webapp/src/net/handoff-link.js',
      },
    ]);
  });

  it('flags a triple-slash reference path targeting webapp/src', () => {
    const source = '/// <reference path="../../webapp/src/cdp/types.ts" />\nexport {};';
    expect(findChromeExtensionWebappEscapes('src/bridge-sw.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/cdp/types.ts',
        to: 'packages/webapp/src/cdp/types.ts',
      },
    ]);
  });

  it('flags "export type { ... } from" — only a top-level "import type {" clause is granted', () => {
    const source = "export type { ExtensionMessage } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('src/service-worker.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/kernel/messages.js',
        to: 'packages/webapp/src/kernel/messages.js',
      },
    ]);
  });

  it('ignores escapes inside comments', () => {
    const source = "// import { x } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('src/service-worker.ts', source)).toEqual([]);
  });

  it('flags a synthetic chrome-extension tests → webapp/src climb (#3047)', () => {
    const source = "import { isExtensionMessage } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('tests/messages.test.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../webapp/src/kernel/messages.js',
        to: 'packages/webapp/src/kernel/messages.js',
      },
    ]);
  });

  it('still allows a type-only kernel/messages clause from tests/', () => {
    const source = "import type { ExtensionMessage } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('tests/messages.test.ts', source)).toEqual([]);
  });

  it('does not exempt a value import of kernel/messages.js from tests/', () => {
    const source =
      "import { type ExtensionMessage, isExtensionMessage } from '../../webapp/src/kernel/messages.js';";
    expect(findChromeExtensionWebappEscapes('tests/messages.test.ts', source)).toHaveLength(1);
  });
});

describe('check-layer-back-edges: findWebcomponentsWebappEscapes', () => {
  it('flags a synthetic webcomponents → webapp/src import (the #3027 cycle)', () => {
    const source = "import { createMemoryRows } from '../../../webapp/src/ui/wc/wc-memory.js';";
    expect(
      findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.stories.ts', source)
    ).toEqual([
      {
        line: 1,
        specifier: '../../../webapp/src/ui/wc/wc-memory.js',
        to: 'packages/webapp/src/ui/wc/wc-memory.js',
      },
    ]);
  });

  it('flags the same climb from a webcomponents test file', () => {
    const source = "import { createMemoryRows } from '../../../webapp/src/ui/wc/wc-memory.js';";
    expect(
      findWebcomponentsWebappEscapes('tests/memory/slicc-memory-panel.test.ts', source)
    ).toHaveLength(1);
  });

  it('flags a type-only import — webcomponents has no kernel/messages exemption', () => {
    const source =
      "import type { ExtensionMessage } from '../../../webapp/src/kernel/messages.js';";
    expect(findWebcomponentsWebappEscapes('src/memory/memory-rows.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../../webapp/src/kernel/messages.js',
        to: 'packages/webapp/src/kernel/messages.js',
      },
    ]);
  });

  it('flags a dynamic import() targeting webapp/src', () => {
    const source = "async function f() { await import('../../../webapp/src/ui/wc/wc-memory.js'); }";
    expect(findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../../webapp/src/ui/wc/wc-memory.js',
        to: 'packages/webapp/src/ui/wc/wc-memory.js',
      },
    ]);
  });

  it('flags a template-literal import() targeting webapp/src', () => {
    const source = 'async function f() { await import(`../../../webapp/src/ui/wc/wc-memory.js`); }';
    expect(findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../../webapp/src/ui/wc/wc-memory.js',
        to: 'packages/webapp/src/ui/wc/wc-memory.js',
      },
    ]);
  });

  it('flags a concatenated specifier targeting webapp/src', () => {
    const source = "import('../../../webapp' + '/src/ui/wc/wc-memory.js');";
    expect(findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../../webapp/src/ui/wc/wc-memory.js',
        to: 'packages/webapp/src/ui/wc/wc-memory.js',
      },
    ]);
  });

  it('flags a triple-slash reference path targeting webapp/src', () => {
    const source = '/// <reference path="../../../webapp/src/ui/wc/wc-memory.ts" />\nexport {};';
    expect(findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.ts', source)).toEqual([
      {
        line: 1,
        specifier: '../../../webapp/src/ui/wc/wc-memory.ts',
        to: 'packages/webapp/src/ui/wc/wc-memory.ts',
      },
    ]);
  });

  it('allows imports that stay inside packages/webcomponents', () => {
    const source = [
      "import { SliccMemoryPanel } from './slicc-memory-panel.js';",
      "import { escapeHtml } from '../internal/html.js';",
    ].join('\n');
    expect(findWebcomponentsWebappEscapes('src/memory/memory-rows.ts', source)).toEqual([]);
  });

  it('allows bare package specifiers', () => {
    const source = "import { createMemoryRows } from '@slicc/webcomponents/memory/rows';";
    expect(findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.ts', source)).toEqual([]);
  });

  it('ignores escapes inside comments', () => {
    const source = "// import { x } from '../../../webapp/src/ui/wc/wc-memory.js';";
    expect(findWebcomponentsWebappEscapes('src/memory/slicc-memory-panel.ts', source)).toEqual([]);
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

describe('check-layer-back-edges: per-package layerOf', () => {
  it('classifies node-server transport / services / entry, including .js specifiers', () => {
    expect(nodeServerLayerOf('cdp-proxy/close-codes.ts')).toBe('transport');
    expect(nodeServerLayerOf('bridge-security.js')).toBe('transport');
    expect(nodeServerLayerOf('secrets/types.ts')).toBe('services');
    expect(nodeServerLayerOf('routes/fetch-proxy.ts')).toBe('services');
    expect(nodeServerLayerOf('index.ts')).toBe('entry');
    expect(nodeServerLayerOf('electron-main.js')).toBe('entry');
  });

  it('classifies chrome-extension shared/page vs sw vs the SW entry', () => {
    expect(chromeExtensionLayerOf('secrets-storage.js')).toBe('shared');
    expect(chromeExtensionLayerOf('sidepanel-entry.ts')).toBe('shared');
    expect(chromeExtensionLayerOf('bridge-sw.ts')).toBe('sw');
    expect(chromeExtensionLayerOf('secrets-sw.ts')).toBe('sw');
    expect(chromeExtensionLayerOf('service-worker.ts')).toBe('entry');
    expect(chromeExtensionLayerOf('service-worker.js')).toBe('entry');
  });

  it('classifies cloudflare-worker shared vs routes vs index, including DO internals', () => {
    expect(cloudflareWorkerLayerOf('shared.ts')).toBe('shared');
    expect(cloudflareWorkerLayerOf('links.js')).toBe('shared');
    expect(cloudflareWorkerLayerOf('auth/cloud-callback.ts')).toBe('shared');
    expect(cloudflareWorkerLayerOf('session-tray-bridge.ts')).toBe('shared');
    expect(cloudflareWorkerLayerOf('cloud/auth.ts')).toBe('shared');
    expect(cloudflareWorkerLayerOf('session-tray.ts')).toBe('routes');
    expect(cloudflareWorkerLayerOf('preview-worker.ts')).toBe('entry');
    expect(cloudflareWorkerLayerOf('preview-handler.ts')).toBe('routes');
    expect(cloudflareWorkerLayerOf('cloud/handlers.ts')).toBe('routes');
    expect(cloudflareWorkerLayerOf('preview-routes.js')).toBe('routes');
    expect(cloudflareWorkerLayerOf('preview-bridge-assets.ts')).toBe('shared');
    expect(cloudflareWorkerLayerOf('index.ts')).toBe('entry');
    expect(cloudflareWorkerLayerOf('index.js')).toBe('entry');
  });
});

describe('check-layer-back-edges: node-server stack', () => {
  const stack = stackById('node-server');

  it('flags a transport → services back-edge', () => {
    expect(
      findLayerBackEdges(
        'cdp-proxy/close-codes.ts',
        "import { EnvSecretStore } from '../secrets/env-secret-store.js';",
        stack
      )
    ).toEqual([
      {
        line: 1,
        specifier: '../secrets/env-secret-store.js',
        from: 'transport',
        to: 'services',
      },
    ]);
  });

  it('allows services → transport and same-layer imports', () => {
    const source = [
      "import { mintBridgeToken } from '../bridge-security.js';",
      "import { EnvSecretStore } from './env-secret-store.js';",
    ].join('\n');
    expect(findLayerBackEdges('secrets/proxy-manager.ts', source, stack)).toEqual([]);
  });

  it('flags a service importing the CLI entry', () => {
    expect(
      findLayerBackEdges('cloud/dispatch.ts', "import { main } from '../index.js';", stack)
    ).toEqual([{ line: 1, specifier: '../index.js', from: 'services', to: 'entry' }]);
  });

  it('allows the CLI entry to import services and transport', () => {
    const source = [
      "import { mintBridgeToken } from './bridge-security.js';",
      "import { startCloud } from './cloud/start.js';",
    ].join('\n');
    expect(findLayerBackEdges('index.ts', source, stack)).toEqual([]);
  });
});

describe('check-layer-back-edges: chrome-extension stack', () => {
  const stack = stackById('chrome-extension');

  it('flags a page/shared module importing a service-worker module', () => {
    expect(
      findLayerBackEdges(
        'sidepanel-entry.ts',
        "import { attachBridge } from './bridge-sw.js';",
        stack
      )
    ).toEqual([{ line: 1, specifier: './bridge-sw.js', from: 'shared', to: 'sw' }]);
  });

  it('allows the SW entry and SW modules to import shared helpers', () => {
    expect(
      findLayerBackEdges(
        'secrets-sw.ts',
        "import { loadSecrets } from './secrets-storage.js';",
        stack
      )
    ).toEqual([]);
    expect(
      findLayerBackEdges(
        'service-worker.ts',
        "import { attachBridge } from './bridge-sw.js';",
        stack
      )
    ).toEqual([]);
  });

  it('flags a SW module importing the composition-root entry', () => {
    expect(
      findLayerBackEdges('bridge-sw.ts', "import { boot } from './service-worker.js';", stack)
    ).toEqual([{ line: 1, specifier: './service-worker.js', from: 'sw', to: 'entry' }]);
  });

  it('allows page entries to import shared helpers (not SW modules)', () => {
    expect(
      findLayerBackEdges(
        'secrets-entry.ts',
        "import { loadSecrets } from './secrets-storage.js';",
        stack
      )
    ).toEqual([]);
  });
});

describe('check-layer-back-edges: cloudflare-worker stack', () => {
  const stack = stackById('cloudflare-worker');

  it('flags a shared helper importing a route module', () => {
    expect(
      findLayerBackEdges('flags.ts', "import { handleOauth } from './oauth-exchange.js';", stack)
    ).toEqual([{ line: 1, specifier: './oauth-exchange.js', from: 'shared', to: 'routes' }]);
  });

  it('flags a route importing index.ts (composition root)', () => {
    expect(
      findLayerBackEdges('webhook-revoke-route.ts', "import { json } from './index.js';", stack)
    ).toEqual([{ line: 1, specifier: './index.js', from: 'routes', to: 'entry' }]);
  });

  it('flags sideways imports between route modules', () => {
    expect(
      findLayerBackEdges(
        'preview-transfer-route.ts',
        "import { handlePreview } from './preview-routes.js';",
        stack
      )
    ).toEqual([{ line: 1, specifier: './preview-routes.js', from: 'routes', to: 'routes' }]);
  });

  it('allows a route to import shared helpers, and shared to import shared', () => {
    expect(
      findLayerBackEdges('oauth-exchange.ts', "import { sign } from './shared.js';", stack)
    ).toEqual([]);
    expect(
      findLayerBackEdges('session-tray-bridge.ts', "import { sign } from './shared.js';", stack)
    ).toEqual([]);
  });

  it('allows index.ts to import routes and shared', () => {
    const source = [
      "import { applySliccLinks } from './links.js';",
      "import { handleOauth } from './oauth-exchange.js';",
    ].join('\n');
    expect(findLayerBackEdges('index.ts', source, stack)).toEqual([]);
  });

  it('does not treat a self-import as a sideways back-edge', () => {
    expect(
      findLayerBackEdges(
        'preview-routes.ts',
        "export { handlePreview } from './preview-routes.js';",
        stack
      )
    ).toEqual([]);
  });
});

describe('check-layer-back-edges: end-to-end over the real tree', () => {
  it('scan matches the committed baseline (one-way ratchet holds)', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    expect(compareToBaseline(scanBackEdges(), baseline)).toEqual([]);
  });

  it('each package stack matches its committed baseline', () => {
    expect(LAYER_STACKS.map((s) => s.id)).toEqual([
      'webapp',
      'node-server',
      'chrome-extension',
      'cloudflare-worker',
    ]);
    for (const stack of LAYER_STACKS) {
      const baseline = JSON.parse(readFileSync(stack.baselinePath, 'utf8'));
      expect(compareToBaseline(scanStackBackEdges(stack), baseline), stack.id).toEqual([]);
    }
  });

  it('no webapp source escapes into a sibling package (zero tolerance)', () => {
    expect(scanCrossPackageEscapes()).toEqual({});
  });

  it('no chrome-extension source or test escapes into packages/webapp/src beyond the one exemption (zero tolerance)', () => {
    expect(scanChromeExtensionWebappEscapes()).toEqual({});
  });

  it('no webcomponents source or test escapes into packages/webapp/src (zero tolerance)', () => {
    expect(scanWebcomponentsWebappEscapes()).toEqual({});
  });

  it('guard entry script passes and reports the grandfathered count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no new layer back-edges/);
  });
});
