#!/usr/bin/env node
/**
 * Regenerates `pnpm-picker-oracle.json`: pnpm's own answer to "which version
 * does `name@range` pick from this packument?" for every case below. The
 * `pnpm-picker-oracle.test.ts` suite asserts ipk's `resolveVersion` against it.
 *
 * NOT run in CI. It needs the wasm build of pnpm 12's picker
 * (`pick_package_from_meta`, compiled verbatim from pnpm/pnpm with a
 * wasm-bindgen wrapper; see the pnpm-rs research report) and, with `--live`,
 * the public npm registry.
 *
 *   node generate-pnpm-picker-oracle.mjs --wasm <dir with pnpm_pick_wasm.js> [--live]
 *
 * Without `--live` the real packument snapshots already in the fixture are
 * reused, so the synthetic cases can be regenerated offline.
 *
 * One deliberate divergence from pnpm 12: it treats `deprecated: ""` as
 * deprecated, while npm and pnpm 11 treat an empty message as live. ipk keeps
 * npm's rule, so each case's `expected` comes from pnpm run on the packument
 * with empty deprecation messages removed. `pnpm` records the raw pnpm 12
 * answer; the two differ only where an empty message matters.
 */

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

/** Synthetic packuments: each isolates one rule of pnpm's picker. */
const SYNTHETIC = {
  // The live @ai-ecoverse/wasm-zlib shape as of 2026-09-28, frozen.
  'zlib-shape': synthetic('zlib-shape', '1.3.1-2', {
    '0.0.0': {},
    '0.0.1': {},
    '0.0.2': {},
    '1.3.1': { deprecated: 'superseded by packaging rev (-N)' },
    '1.3.1-1': {},
    '1.3.1-2': {},
  }),
  // `latest` deliberately below the highest version.
  'latest-below-max': synthetic('latest-below-max', '1.0.0', {
    '1.0.0': {},
    '1.5.0': {},
    '2.0.0': {},
  }),
  // `latest` deprecated, a live version below it.
  'deprecated-latest': synthetic('deprecated-latest', '2.0.0', {
    '1.9.0': {},
    '2.0.0': DEP,
  }),
  // `latest` a deprecated prerelease: `*` keeps the release line.
  'deprecated-prerelease-latest': synthetic('deprecated-prerelease-latest', '1.3.1-2', {
    '0.0.2': {},
    '1.3.1-1': {},
    '1.3.1-2': DEP,
  }),
  // Highest in range deprecated, `latest` outside the range.
  'deprecated-max-in-range': synthetic('deprecated-max-in-range', '2.0.0', {
    '1.0.0': {},
    '1.1.0': {},
    '1.2.0': DEP,
    '2.0.0': {},
  }),
  // Everything deprecated: fall back to the plain pick.
  'all-deprecated': synthetic('all-deprecated', '1.1.0', {
    '1.0.0': DEP,
    '1.1.0': DEP,
    '1.2.0': DEP,
  }),
  // An empty deprecation message: live for npm and pnpm 11, deprecated for pnpm 12.
  'empty-deprecation': synthetic('empty-deprecation', '0.9.0', {
    '0.9.0': {},
    '1.0.0': {},
    '1.1.0': { deprecated: '' },
  }),
  // Prerelease handling.
  prerelease: synthetic(
    'prerelease',
    '1.0.0',
    { '1.0.0': {}, '1.1.0-beta.1': {}, '1.1.0-beta.2': {}, '2.0.0-rc.1': {} },
    { next: '2.0.0-rc.1', beta: '1.1.0-beta.2' }
  ),
  // `latest` itself a prerelease.
  'prerelease-latest': synthetic('prerelease-latest', '2.0.0-rc.1', {
    '1.0.0': {},
    '1.2.0': {},
    '2.0.0-rc.1': {},
  }),
  // No `latest` tag at all.
  'no-latest': synthetic('no-latest', undefined, { '1.0.0': {}, '1.4.0': {}, '2.0.0-alpha.1': {} }),
  // Build metadata and a non-semver key.
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

/** npm's rule: an empty deprecation message is not a deprecation. */
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
