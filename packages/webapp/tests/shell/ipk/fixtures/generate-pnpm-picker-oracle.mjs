#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'pnpm-picker-oracle.json');
const PNPM_SOURCE =
  'pnpm/pnpm@1e87ac2 (pnpm 12, crates/resolving-npm-resolver pick_package_from_meta)';

const REAL_PACKAGES = [
  '@ai-ecoverse/wasm-bash',
  '@ai-ecoverse/wasm-coreutils',
  '@ai-ecoverse/wasm-freetype',
  '@ai-ecoverse/wasm-gawk',
  '@ai-ecoverse/wasm-gmake',
  '@ai-ecoverse/wasm-grep',
  '@ai-ecoverse/wasm-lcms2',
  '@ai-ecoverse/wasm-less',
  '@ai-ecoverse/wasm-libwebp',
  '@ai-ecoverse/wasm-libxml2',
  '@ai-ecoverse/wasm-pkgconf',
  '@ai-ecoverse/wasm-sed',
  '@ai-ecoverse/wasm-zlib',
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function synthetic(name, latest, versions, extraTags = {}) {
  const tags = latest === undefined ? { ...extraTags } : { latest, ...extraTags };
  return {
    name,
    'dist-tags': tags,
    versions: Object.fromEntries(
      Object.entries(versions).map(([v, extra]) => [
        v,
        {
          name,
          version: v,
          dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz` },
          ...extra,
        },
      ])
    ),
  };
}

const DEP = { deprecated: 'do not use' };

const SYNTHETIC = {
  'zlib-shape': synthetic('zlib-shape', '1.3.1-2', {
    '0.0.0': {},
    '0.0.1': {},
    '0.0.2': {},
    '1.3.1': { deprecated: 'superseded by packaging rev (-N)' },
    '1.3.1-1': {},
    '1.3.1-2': {},
  }),

  'latest-below-max': synthetic('latest-below-max', '1.0.0', {
    '1.0.0': {},
    '1.5.0': {},
    '2.0.0': {},
  }),

  'deprecated-latest': synthetic('deprecated-latest', '2.0.0', {
    '1.9.0': {},
    '2.0.0': DEP,
  }),

  'deprecated-prerelease-latest': synthetic('deprecated-prerelease-latest', '1.3.1-2', {
    '0.0.2': {},
    '1.3.1-1': {},
    '1.3.1-2': DEP,
  }),

  'deprecated-max-in-range': synthetic('deprecated-max-in-range', '2.0.0', {
    '1.0.0': {},
    '1.1.0': {},
    '1.2.0': DEP,
    '2.0.0': {},
  }),

  'all-deprecated': synthetic('all-deprecated', '1.1.0', {
    '1.0.0': DEP,
    '1.1.0': DEP,
    '1.2.0': DEP,
  }),

  'empty-deprecation': synthetic('empty-deprecation', '0.9.0', {
    '0.9.0': {},
    '1.0.0': {},
    '1.1.0': { deprecated: '' },
  }),

  prerelease: synthetic(
    'prerelease',
    '1.0.0',
    { '1.0.0': {}, '1.1.0-beta.1': {}, '1.1.0-beta.2': {}, '2.0.0-rc.1': {} },
    { next: '2.0.0-rc.1', beta: '1.1.0-beta.2' }
  ),

  'prerelease-latest': synthetic('prerelease-latest', '2.0.0-rc.1', {
    '1.0.0': {},
    '1.2.0': {},
    '2.0.0-rc.1': {},
  }),

  'no-latest': synthetic('no-latest', undefined, { '1.0.0': {}, '1.4.0': {}, '2.0.0-alpha.1': {} }),

  'build-metadata': synthetic('build-metadata', '1.0.0', {
    '1.0.0': {},
    '1.1.0+build.7': {},
    'not-a-version': {},
  }),
};

const SYNTHETIC_RANGES = [
  '',
  'latest',
  '*',
  'x',
  'X',
  '>=0.0.0',
  '>=0.0.0-0',
  '^0.0.0',
  '^1.0.0',
  '~1.0.0',
  '^1.3.1-1',
  '>=1.3.1-0',
  '1.3.1',
  '1.x',
  '<=1',
  '<2',
  '=1.0.0',
  '^1.1.0-beta.0',
  '^2.0.0',
  '>=2.0.0-0',
  '1.1.0+build.7',
  '1.5.0+build.7',
  'next',
  'beta',
  'nope',
  '9.9.9',
];

function trimVersion(name, v) {
  const out = { name: v.name ?? name, version: v.version, dist: { tarball: v.dist?.tarball } };
  if (typeof v.deprecated === 'string') out.deprecated = v.deprecated;
  return out;
}

async function fetchReal(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.json();
  return {
    name: body.name,
    'dist-tags': body['dist-tags'] ?? {},
    versions: Object.fromEntries(
      Object.entries(body.versions ?? {}).map(([v, entry]) => [v, trimVersion(name, entry)])
    ),
  };
}

function realRanges(pk) {
  const latest = pk['dist-tags']?.latest;
  const ranges = new Set(['', 'latest', '*', 'x', '>=0.0.0', '>=0.0.0-0', '^0.0.0', '^1.0.0']);
  if (latest) {
    ranges.add(`^${latest}`);
    ranges.add(`~${latest}`);
    ranges.add(`>=${latest}`);
  }
  for (const v of Object.keys(pk.versions)) ranges.add(v);
  return [...ranges];
}

function withoutEmptyDeprecations(pk) {
  return {
    ...pk,
    versions: Object.fromEntries(
      Object.entries(pk.versions).map(([v, entry]) => {
        if (entry.deprecated !== '') return [v, entry];
        const { deprecated: _drop, ...rest } = entry;
        return [v, rest];
      })
    ),
  };
}

function pnpmPick(pickVersion, pk, range) {
  try {
    const picked = JSON.parse(pickVersion(JSON.stringify(pk), pk.name, range));
    return picked ? picked.version : null;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const wasmDir = arg('--wasm');
  if (!wasmDir) {
    console.error('usage: generate-pnpm-picker-oracle.mjs --wasm <pnpm-pick-wasm/pkg> [--live]');
    process.exit(2);
  }
  const glue = resolve(wasmDir, 'pnpm_pick_wasm.js');
  const { initSync, pickVersion } = await import(pathToFileURL(glue).href);
  initSync({ module: readFileSync(resolve(wasmDir, 'pnpm_pick_wasm_bg.wasm')) });

  let real = {};
  if (process.argv.includes('--live')) {
    for (const name of REAL_PACKAGES) real[name] = await fetchReal(name);
  } else {
    const previous = JSON.parse(readFileSync(OUT, 'utf8'));
    real = Object.fromEntries(
      Object.entries(previous.packuments).filter(([key]) => key.startsWith('@'))
    );
  }

  const packuments = { ...SYNTHETIC, ...real };
  const cases = [];
  for (const [key, pk] of Object.entries(packuments)) {
    const ranges = key in SYNTHETIC ? SYNTHETIC_RANGES : realRanges(pk);
    const npmRule = withoutEmptyDeprecations(pk);
    for (const range of ranges) {
      const pnpm = pnpmPick(pickVersion, pk, range);
      const expected = pnpmPick(pickVersion, npmRule, range);
      if (expected !== null && typeof expected === 'object') {
        throw new Error(`pnpm threw for ${key}@${JSON.stringify(range)}: ${expected.error}`);
      }
      const row = { packument: key, range, expected };
      if (JSON.stringify(pnpm) !== JSON.stringify(expected)) row.pnpm12 = pnpm;
      cases.push(row);
    }
  }

  const fixture = {
    $comment:
      "Generated by generate-pnpm-picker-oracle.mjs; do not hand-edit. `expected` is pnpm 12's pick under npm's empty-deprecation rule; `pnpm12` appears only where raw pnpm 12 differs. null = pnpm picks nothing.",
    source: PNPM_SOURCE,
    generatedAt: new Date().toISOString().slice(0, 10),
    packuments,
    cases,
  };
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `wrote ${cases.length} cases over ${Object.keys(packuments).length} packuments to ${OUT}`
  );
}

await main();
