import 'fake-indexeddb/auto';
import type { SecureFetch } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { installPackage, installPackages } from '../../../src/shell/ipk/installer.js';
import {
  fetchPackument,
  type PackumentVersion,
  resolveVersion,
} from '../../../src/shell/ipk/registry.js';
import { LIVE_REGISTRY, nodeFetch } from './helpers/live-registry.js';

let dbCounter = 0;

type RawFetch = (url: string, opts?: unknown) => Promise<{ body: Uint8Array }>;

describe.skipIf(!LIVE_REGISTRY)('ipk against the live npm registry', () => {
  it('verifies every tarball of a real tree and installs it', async () => {
    const fs = await VirtualFS.create({ dbName: `ipk-live-${dbCounter++}`, wipe: true });
    const result = await installPackage('chalk@^4', { fs, fetch: nodeFetch, cwd: '/work' });
    expect(result.version).toMatch(/^4\./);
    for (const dep of ['chalk', 'ansi-styles', 'supports-color', 'has-flag', 'color-convert']) {
      await expect(fs.exists(`/work/node_modules/${dep}/package.json`)).resolves.toBe(true);
    }
    await fs.dispose();
  }, 60_000);

  it('picks the live latest of every @ai-ecoverse/wasm-* package for "*", as pnpm does', async () => {
    for (const name of [
      '@ai-ecoverse/wasm-zlib',
      '@ai-ecoverse/wasm-bash',
      '@ai-ecoverse/wasm-sed',
    ]) {
      const pk = await fetchPackument(name, nodeFetch);
      const latest = pk['dist-tags']?.latest;
      expect(latest, name).toBeTruthy();
      if (!pk.versions[latest as string].deprecated) {
        expect(resolveVersion(pk, '*'), name).toBe(latest);
      }
    }
    const zlib = await fetchPackument('@ai-ecoverse/wasm-zlib', nodeFetch);
    expect(resolveVersion(zlib, '^1.3.1-1')).not.toBe('1.3.1');
  }, 60_000);

  it('installs express@^4 (68 packages) with parallel fetching', async () => {
    const fs = await VirtualFS.create({ dbName: `ipk-live-${dbCounter++}`, wipe: true });
    const t0 = performance.now();
    const result = await installPackage('express@^4', { fs, fetch: nodeFetch, cwd: '/work' });
    const ms = Math.round(performance.now() - t0);
    console.log(`[ipk-live] express@${result.version}: ${ms} ms`);
    expect(result.version).toMatch(/^4\./);
    await expect(fs.exists('/work/node_modules/body-parser/package.json')).resolves.toBe(true);
    await fs.dispose();
  }, 120_000);

  it('abbreviated packuments carry every field ipk reads, identical to the full ones', async () => {
    const FIELDS = [
      'deprecated',
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'bin',
      'engines',
      'os',
      'cpu',
    ] as const;

    const present = (value: unknown) =>
      value && typeof value === 'object' && Object.keys(value).length === 0 ? undefined : value;
    const pick = (v: PackumentVersion) => ({
      ...Object.fromEntries(FIELDS.map((f) => [f, present(v[f])])),
      tarball: v.dist?.tarball,
      integrity: v.dist?.integrity,
      shasum: v.dist?.shasum,
    });
    for (const name of [
      'typescript',
      'esbuild',
      '@esbuild/darwin-arm64',
      'request',
      '@ai-ecoverse/wasm-zlib',
    ]) {
      let abbreviatedBytes = 0;
      let fullBytes = 0;
      const counting = (sink: (n: number) => void) =>
        (async (url: string, opts?: unknown) => {
          const res = await (nodeFetch as unknown as RawFetch)(url, opts);
          sink(res.body.length);
          return res;
        }) as unknown as SecureFetch;
      const abbreviated = await fetchPackument(
        name,
        counting((n) => (abbreviatedBytes += n))
      );
      const full = await fetchPackument(
        name,
        counting((n) => (fullBytes += n)),
        { full: true }
      );
      console.log(`[ipk-live] ${name}: abbreviated ${abbreviatedBytes} B, full ${fullBytes} B`);
      expect(abbreviated['dist-tags'], name).toEqual(full['dist-tags']);
      expect(Object.keys(abbreviated.versions).sort(), name).toEqual(
        Object.keys(full.versions).sort()
      );
      for (const [version, entry] of Object.entries(full.versions)) {
        expect(pick(abbreviated.versions[version]), `${name}@${version}`).toEqual(pick(entry));
      }
      expect(abbreviatedBytes, name).toBeLessThan(fullBytes);
    }
  }, 180_000);

  it("installs only the wasm build among sharp's platform binaries", async () => {
    const fs = await VirtualFS.create({ dbName: `ipk-live-${dbCounter++}`, wipe: true });
    const out = await installPackages(['sharp@^0.35'], { fs, fetch: nodeFetch, cwd: '/work' });
    expect(out.errors).toEqual([]);
    const img = (await fs.readDir('/work/node_modules/@img')).map((e) => e.name).sort();

    expect(img).toContain('sharp-webcontainers-wasm32');
    expect(img).toContain('sharp-wasm32');
    expect(img.filter((n) => /linux|darwin|win32|freebsd/.test(n))).toEqual([]);
    expect(out.notes?.some((n) => n.includes('@img/sharp-linux-x64@'))).toBe(true);
    console.log(
      `[ipk-live] sharp: installed @img/${img.join(', @img/')}; ${out.notes?.length} skipped`
    );
    await fs.dispose();
  }, 180_000);

  it('installs the esbuild wrapper without any of its native binaries', async () => {
    const fs = await VirtualFS.create({ dbName: `ipk-live-${dbCounter++}`, wipe: true });
    const out = await installPackages(['esbuild@^0.25'], { fs, fetch: nodeFetch, cwd: '/work' });
    expect(out.errors).toEqual([]);
    await expect(fs.exists('/work/node_modules/esbuild/package.json')).resolves.toBe(true);
    await expect(fs.exists('/work/node_modules/@esbuild')).resolves.toBe(false);
    expect(out.notes?.length).toBeGreaterThan(10);
    await fs.dispose();
  }, 120_000);
});
