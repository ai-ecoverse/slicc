import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runUnusedLayerSuppressionCheck } from './check-unused-layer-suppressions.mjs';
import { runLayerBoundaryGeneration } from './generate-layer-boundary-plugins.mjs';
import {
  generateLayerBoundaryPlugins,
  patchBiomeConfigPlugins,
} from './layer-boundary-codegen-lib.mjs';
import {
  findLayerSuppressionFiles,
  planLayerSuppressions,
  writeLayerSuppressions,
} from './layer-boundary-suppressions-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const tempRoots = [];

function testConfig() {
  return {
    stack: [
      { name: 'data', includes: ['**/src/data/**'] },
      { name: 'service/worker', includes: ['**/src/service/**', '**/src/worker/**'] },
      { name: 'view', includes: ['**/src/view/**'] },
    ],
    zones: [
      {
        name: 'isolated-no-view',
        includes: ['**/src/isolated/**'],
        denySegments: ['view'],
        message: 'Isolated code must not import view/.',
      },
    ],
  };
}

function createFixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'layer-codegen-'));
  tempRoots.push(root);
  mkdirSync(resolve(root, 'packages/dev-tools/tools'), { recursive: true });
  writeFileSync(
    resolve(root, 'packages/dev-tools/tools/layer-boundaries.json'),
    JSON.stringify(testConfig())
  );
  writeFileSync(root + '/biome.json', '{\n  "plugins": ["./manual.grit"]\n}\n');
  return root;
}

function pluginDiagnostic(plugin, path, line, sourceLine, importSource) {
  const column = sourceLine.indexOf(importSource) + 1;
  return {
    category: 'plugin',
    message: plugin.message,
    location: {
      path,
      start: { line, column },
      end: { line, column: column + importSource.length },
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generateLayerBoundaryPlugins', () => {
  it('derives multiple forbidden segments from later stack layers', () => {
    const plugin = generateLayerBoundaryPlugins(testConfig()).find(
      ({ ruleId }) => ruleId === 'layer-data'
    );
    expect(plugin.includes).toEqual(['**/src/data/**']);
    expect(plugin.content).toContain('(?:service|worker|view)/.*');
    expect(plugin.content).toContain('`export $_ from $source`');
  });

  it('does not emit a stack plugin with no forbidden segments', () => {
    const plugins = generateLayerBoundaryPlugins(testConfig());
    expect(plugins.some(({ ruleId }) => ruleId === 'layer-view')).toBe(false);
  });

  it('emits a zone plugin with its configured deny segments and message', () => {
    const plugin = generateLayerBoundaryPlugins(testConfig()).find(
      ({ ruleId }) => ruleId === 'zone-isolated-no-view'
    );
    expect(plugin.content).toContain('(?:view)/.*');
    expect(plugin.content).toContain('Isolated code must not import view/.');
    expect(plugin.content).toContain('`import $_ from $source`');
    expect(plugin.content).toContain('`export $_ from $source`');
    expect(plugin.content).toContain('`import($source)`');
    expect(plugin.content).toContain('`require($source)`');
  });

  it('seeds all seven repository stack layers and the provider zone', () => {
    const config = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/dev-tools/tools/layer-boundaries.json'), 'utf8')
    );
    expect(config.stack.map(({ name }) => name)).toEqual([
      'fs',
      'shell/git',
      'cdp',
      'tools',
      'core',
      'scoops',
      'ui',
    ]);
    expect(config.zones).toEqual([
      {
        name: 'providers-built-in-no-ui',
        includes: ['**/packages/webapp/src/providers/built-in/**'],
        denySegments: ['ui'],
        message: 'Built-in providers run before the UI exists and must not import from ui/.',
      },
    ]);
  });

  it('keeps the repository provider zone free of suppressions', () => {
    const providerRoot = resolve(repoRoot, 'packages/webapp/src/providers/built-in');
    const suppressions = readdirSync(providerRoot, { recursive: true })
      .filter((path) => path.endsWith('.ts'))
      .filter((path) =>
        readFileSync(resolve(providerRoot, path), 'utf8').includes(
          'biome-ignore lint/plugin/zone-providers-built-in-no-ui'
        )
      );
    expect(suppressions).toEqual([]);
  });
});

describe('patchBiomeConfigPlugins', () => {
  it('preserves hand-authored plugins and is idempotent', () => {
    const plugins = generateLayerBoundaryPlugins(testConfig());
    const content =
      '{\n  "plugins": [\n    "./manual.grit",\n    {\n      "path": "./.biome-plugins/generated/stale.grit",\n      "includes": ["**"]\n    }\n  ],\n  "formatter": { "enabled": true }\n}\n';
    const once = patchBiomeConfigPlugins(content, plugins);
    const twice = patchBiomeConfigPlugins(once, plugins);
    const patched = JSON.parse(once);
    expect(twice).toBe(once);
    expect(patched.plugins[0]).toBe('./manual.grit');
    expect(patched.plugins.slice(1)).toHaveLength(plugins.length);
    expect(patched.formatter).toEqual({ enabled: true });
  });
});

describe('runLayerBoundaryGeneration check mode', () => {
  it('detects a hand-edited generated plugin without writing', () => {
    const root = createFixtureRoot();
    runLayerBoundaryGeneration(root);
    const pluginPath = resolve(root, '.biome-plugins/generated/layer-data.grit');
    writeFileSync(pluginPath, 'hand edited\n');
    const result = runLayerBoundaryGeneration(root, { check: true });
    expect(result.ok).toBe(false);
    expect(result.drift).toContain('generated plugin content differs: layer-data.grit');
    expect(readFileSync(pluginPath, 'utf8')).toBe('hand edited\n');
  });

  it('detects a hand-edited biome.json generated plugins array without writing', () => {
    const root = createFixtureRoot();
    runLayerBoundaryGeneration(root);
    const biomePath = resolve(root, 'biome.json');
    const biome = JSON.parse(readFileSync(biomePath, 'utf8'));
    biome.plugins.pop();
    const edited = `${JSON.stringify(biome, null, 2)}\n`;
    writeFileSync(biomePath, edited);
    const result = runLayerBoundaryGeneration(root, { check: true });
    expect(result.ok).toBe(false);
    expect(result.drift).toContain('biome.json generated plugins array differs');
    expect(readFileSync(biomePath, 'utf8')).toBe(edited);
  });
});

describe('layer-boundary suppression migration', () => {
  it('inserts a precise suppression immediately above a plugin hit', () => {
    const root = createFixtureRoot();
    const path = 'packages/webapp/src/data/client.ts';
    const absolute = resolve(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    const sourceLine = "import { run } from '../service/run.js';";
    writeFileSync(absolute, `${sourceLine}\n`);
    const plugin = generateLayerBoundaryPlugins(testConfig()).find(
      ({ ruleId }) => ruleId === 'layer-data'
    );
    const biomeReport = {
      diagnostics: [pluginDiagnostic(plugin, path, 1, sourceLine, "'../service/run.js'")],
    };

    const result = runLayerBoundaryGeneration(root, { biomeReport, suppressExisting: true });

    expect(result.suppressionPlan.suppressionCount).toBe(1);
    expect(readFileSync(absolute, 'utf8')).toBe(
      `// biome-ignore lint/plugin/layer-data: migrated existing layer-boundary debt\n${sourceLine}\n`
    );
  });

  it('uses continuation indentation for a multiline dynamic import', () => {
    const root = createFixtureRoot();
    const path = 'packages/webapp/src/data/client.ts';
    const absolute = resolve(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    const lines = [
      'function load() {',
      '  const {',
      '    run,',
      "  } = await import('../service/run.js');",
      '}',
      '',
    ];
    writeFileSync(absolute, lines.join('\n'));
    const plugin = generateLayerBoundaryPlugins(testConfig()).find(
      ({ ruleId }) => ruleId === 'layer-data'
    );
    const report = {
      diagnostics: [pluginDiagnostic(plugin, path, 4, lines[3], "'../service/run.js'")],
    };

    const plan = planLayerSuppressions(root, report, [plugin]);
    writeLayerSuppressions(plan);

    expect(readFileSync(absolute, 'utf8')).toContain(
      '    // biome-ignore lint/plugin/layer-data: migrated existing layer-boundary debt\n' +
        "  } = await import('../service/run.js');"
    );
  });

  it('aborts all source writes when a zero-tolerance zone is reported', () => {
    const root = createFixtureRoot();
    const layerPath = 'packages/webapp/src/data/client.ts';
    const zonePath = 'packages/webapp/src/isolated/view.ts';
    for (const path of [layerPath, zonePath])
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
    const layerLine = "import { run } from '../service/run.js';";
    const zoneLine = "import { view } from '../view/render.js';";
    writeFileSync(resolve(root, layerPath), `${layerLine}\n`);
    writeFileSync(resolve(root, zonePath), `${zoneLine}\n`);
    const plugins = generateLayerBoundaryPlugins(testConfig());
    const layerPlugin = plugins.find(({ ruleId }) => ruleId === 'layer-data');
    const zonePlugin = plugins.find(({ ruleId }) => ruleId === 'zone-isolated-no-view');
    const report = {
      diagnostics: [
        pluginDiagnostic(layerPlugin, layerPath, 1, layerLine, "'../service/run.js'"),
        pluginDiagnostic(zonePlugin, zonePath, 1, zoneLine, "'../view/render.js'"),
      ],
    };

    expect(() => planLayerSuppressions(root, report, plugins)).toThrow(
      'zero-tolerance zone violation(s); no suppressions written'
    );
    expect(readFileSync(resolve(root, layerPath), 'utf8')).toBe(`${layerLine}\n`);
  });

  it('uses the baseline and issue-specific reasons and scans debt files', () => {
    const root = createFixtureRoot();
    const cdpPath = 'packages/webapp/src/cdp/transport.ts';
    const scoopsPath = 'packages/webapp/src/scoops/bridge.ts';
    const cdpLine = "import { value } from '../scoops/protocol.js';";
    const scoopsLine = "import { render } from '../ui/render.js';";
    for (const path of [cdpPath, scoopsPath])
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, cdpPath), `${cdpLine}\n`);
    writeFileSync(resolve(root, scoopsPath), `${scoopsLine}\n`);
    const plugins = [
      { kind: 'layer', message: 'cdp debt', ruleId: 'layer-cdp' },
      { kind: 'layer', message: 'scoops debt', ruleId: 'layer-scoops' },
    ];
    const report = {
      diagnostics: [
        pluginDiagnostic(plugins[0], cdpPath, 1, cdpLine, "'../scoops/protocol.js'"),
        pluginDiagnostic(plugins[1], scoopsPath, 1, scoopsLine, "'../ui/render.js'"),
      ],
    };

    const plan = planLayerSuppressions(root, report, plugins);
    writeLayerSuppressions(plan);

    expect(readFileSync(resolve(root, cdpPath), 'utf8')).toContain('issue #1950');
    expect(readFileSync(resolve(root, scoopsPath), 'utf8')).toContain(
      'migrated from ui-back-edge-baseline.json'
    );
    expect(findLayerSuppressionFiles(resolve(root, 'packages/webapp/src'), root)).toEqual([
      cdpPath,
      scoopsPath,
    ]);
  });

  it('fails only for Biome unused diagnostics on generated layer suppressions', () => {
    const root = createFixtureRoot();
    const layerPath = 'packages/webapp/src/data/stale.ts';
    const otherPath = 'packages/webapp/src/data/other.ts';
    for (const path of [layerPath, otherPath]) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
    }
    writeFileSync(
      resolve(root, layerPath),
      '// biome-ignore lint/plugin/layer-data: stale\nimport "./local.js";\n'
    );
    writeFileSync(
      resolve(root, otherPath),
      '// biome-ignore lint/suspicious/noExplicitAny: unrelated\nconst value: any = 1;\n'
    );
    const diagnostic = (path) => ({
      category: 'suppressions/unused',
      location: { path, start: { line: 1, column: 1 }, end: { line: 1, column: 20 } },
      severity: 'warning',
    });

    const stale = runUnusedLayerSuppressionCheck(root, {
      biomeReport: { diagnostics: [diagnostic(layerPath), diagnostic(otherPath)] },
    });
    const unrelated = runUnusedLayerSuppressionCheck(root, {
      biomeReport: {
        diagnostics: [
          diagnostic(otherPath),
          { category: 'lint/suspicious/noExplicitAny', severity: 'warning' },
        ],
      },
    });

    expect(stale).toEqual({ ok: false, unused: [{ line: 1, path: layerPath }] });
    expect(unrelated).toEqual({ ok: true, unused: [] });
  });
});
