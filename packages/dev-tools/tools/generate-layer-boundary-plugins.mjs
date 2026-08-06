#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  generateLayerBoundaryPlugins,
  patchBiomeConfigPlugins,
} from './layer-boundary-codegen-lib.mjs';
import {
  planLayerSuppressions,
  writeLayerSuppressions,
} from './layer-boundary-suppressions-lib.mjs';

const filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(filename), '..', '..', '..');

function generatedFileNames(outputDir) {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .filter((name) => name.endsWith('.grit'))
    .sort();
}

function collectPluginDrift(outputDir, plugins) {
  const drift = [];
  const expectedNames = new Set(plugins.map(({ fileName }) => fileName));
  for (const fileName of generatedFileNames(outputDir)) {
    if (!expectedNames.has(fileName)) drift.push(`unexpected generated plugin: ${fileName}`);
  }
  for (const plugin of plugins) {
    const path = resolve(outputDir, plugin.fileName);
    if (!existsSync(path)) drift.push(`missing generated plugin: ${plugin.fileName}`);
    else if (readFileSync(path, 'utf8') !== plugin.content) {
      drift.push(`generated plugin content differs: ${plugin.fileName}`);
    }
  }
  return drift;
}

function writePlugins(outputDir, plugins) {
  mkdirSync(outputDir, { recursive: true });
  const expectedNames = new Set(plugins.map(({ fileName }) => fileName));
  for (const fileName of generatedFileNames(outputDir)) {
    if (!expectedNames.has(fileName)) unlinkSync(resolve(outputDir, fileName));
  }
  for (const { fileName, content } of plugins) {
    writeFileSync(resolve(outputDir, fileName), content);
  }
}

function runBiomePluginLint(repoRoot) {
  const executable = resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'biome.cmd' : 'biome'
  );
  const result = spawnSync(
    executable,
    ['lint', '--only=plugin', '--reporter=json', 'packages/webapp/src'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || `Biome lint exited with status ${result.status}`);
  }
  return result.stdout;
}

export function runLayerBoundaryGeneration(repoRoot = defaultRepoRoot, options = {}) {
  const configPath = resolve(repoRoot, 'packages/dev-tools/tools/layer-boundaries.json');
  const biomePath = resolve(repoRoot, 'biome.json');
  const outputDir = resolve(repoRoot, '.biome-plugins/generated');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const plugins = generateLayerBoundaryPlugins(config);
  const biomeContent = readFileSync(biomePath, 'utf8');
  const expectedBiomeContent = patchBiomeConfigPlugins(biomeContent, plugins);

  if (options.check) {
    const drift = collectPluginDrift(outputDir, plugins);
    if (biomeContent !== expectedBiomeContent) {
      drift.push('biome.json generated plugins array differs');
    }
    return { ok: drift.length === 0, drift, plugins };
  }

  writePlugins(outputDir, plugins);
  if (biomeContent !== expectedBiomeContent) writeFileSync(biomePath, expectedBiomeContent);
  if (options.suppressExisting) {
    const report = options.biomeReport ?? runBiomePluginLint(repoRoot);
    const suppressionPlan = planLayerSuppressions(repoRoot, report, plugins);
    writeLayerSuppressions(suppressionPlan);
    return { ok: true, drift: [], plugins, suppressionPlan };
  }
  return { ok: true, drift: [], plugins };
}

function main() {
  const args = argv.slice(2);
  const allowed = new Set(['--check', '--suppress-existing']);
  if (args.some((arg) => !allowed.has(arg))) {
    throw new Error(`unknown argument: ${args.find((arg) => !allowed.has(arg))}`);
  }
  const check = args.includes('--check');
  const suppressExisting = args.includes('--suppress-existing');
  if (check && suppressExisting) throw new Error('--check and --suppress-existing are exclusive');
  const result = runLayerBoundaryGeneration(defaultRepoRoot, { check, suppressExisting });
  if (!result.ok) {
    for (const item of result.drift) process.stderr.write(`layer-boundary drift: ${item}\n`);
    process.stderr.write('Run node packages/dev-tools/tools/generate-layer-boundary-plugins.mjs\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    check
      ? `ok: ${result.plugins.length} generated layer-boundary plugins are current\n`
      : suppressExisting
        ? `added ${result.suppressionPlan.suppressionCount} layer-boundary suppressions in ${result.suppressionPlan.files.length} files\n`
        : `generated ${result.plugins.length} layer-boundary plugins\n`
  );
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) main();
