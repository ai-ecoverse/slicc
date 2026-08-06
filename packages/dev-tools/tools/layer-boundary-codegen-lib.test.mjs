import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runLayerBoundaryGeneration } from './generate-layer-boundary-plugins.mjs';
import {
  generateLayerBoundaryPlugins,
  patchBiomeConfigPlugins,
} from './layer-boundary-codegen-lib.mjs';

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
    expect(config.zones[0].denySegments).toEqual(['ui']);
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
