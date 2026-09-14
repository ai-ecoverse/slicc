import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  collectZipEntries,
  comparePaths,
  createDeterministicZip,
  createExtensionArchive,
  createNpmPackageTarball,
  packageReleaseArtifacts,
  parseNpmPackFilename,
  requirePath,
  resolveNpmCommand,
  sanitizeArtifactName,
  toProjectRelative,
  writeReleaseManifest,
} from '../src/release-package.js';

function makeReleaseTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'slicc-release-package-'));
  mkdirSync(join(root, 'dist', 'extension'), { recursive: true });
  mkdirSync(join(root, 'dist', 'node-server'), { recursive: true });
  mkdirSync(join(root, 'dist', 'ui'), { recursive: true });
  writeFileSync(join(root, 'dist', 'extension', 'manifest.json'), '{"manifest_version":3}');
  writeFileSync(join(root, 'package.json'), '{"name":"@slicc/test","version":"1.2.3"}');
  return root;
}

describe('release-package', () => {
  it('sanitizes artifact names for stable filenames', () => {
    expect(sanitizeArtifactName('@AI-Ecoverse/SLICC Release')).toBe('ai-ecoverse-slicc-release');
    expect(sanitizeArtifactName(' --- ')).toBe('');
    expect(comparePaths('same', 'same')).toBe(0);
    expect(comparePaths('a', 'b')).toBe(-1);
    expect(comparePaths('b', 'a')).toBe(1);
  });

  it('reads the packed tarball filename from npm pack json output', () => {
    expect(parseNpmPackFilename('[{"filename":"sliccy-0.1.0.tgz"}]\n')).toBe('sliccy-0.1.0.tgz');
  });

  it('fails when npm pack json output does not report a filename', () => {
    expect(() => parseNpmPackFilename('[{}]\n')).toThrow(
      'npm pack did not report an output filename.'
    );
  });

  it('creates deterministic zip output from filesystem input', () => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-release-package-'));

    try {
      mkdirSync(join(root, 'nested'), { recursive: true });
      writeFileSync(join(root, 'b.txt'), 'bravo');
      writeFileSync(join(root, 'nested', 'a.txt'), 'alpha');

      const entries = collectZipEntries(root);
      const zipA = createDeterministicZip(entries);
      const zipB = createDeterministicZip([...entries].reverse());

      expect(Buffer.compare(zipA, zipB)).toBe(0);
      expect(zipA.includes(Buffer.from('b.txt'))).toBe(true);
      expect(zipA.includes(Buffer.from('nested/a.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates required paths and normalizes project-relative paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-release-paths-'));
    try {
      requirePath(root, 'temporary root');
      expect(() => requirePath(join(root, 'missing'), 'Expected output')).toThrow(
        'Expected output was not found'
      );
      expect(toProjectRelative(root, join(root, 'nested', 'file.txt'))).toBe('nested/file.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves npm through npm_execpath or the platform command', () => {
    expect(
      resolveNpmCommand({ npmExecPath: '/tmp/npm-cli.js', execPath: '/usr/bin/node' })
    ).toEqual({ command: '/usr/bin/node', argsPrefix: ['/tmp/npm-cli.js'] });
    expect(resolveNpmCommand({ npmExecPath: '', platform: 'win32' })).toEqual({
      command: 'npm.cmd',
      argsPrefix: [],
    });
    expect(resolveNpmCommand({ npmExecPath: '', platform: 'linux' })).toEqual({
      command: 'npm',
      argsPrefix: [],
    });
  });

  it('creates the extension archive and manifest in a caller-owned release directory', () => {
    const root = makeReleaseTree();
    const releaseDir = join(root, 'release');
    mkdirSync(releaseDir);
    try {
      const archive = createExtensionArchive(
        { name: '@slicc/test', version: '1.2.3' },
        root,
        releaseDir
      );
      expect(archive).toBe(join(releaseDir, 'slicc-test-extension-v1.2.3.zip'));
      expect(readFileSync(archive).includes(Buffer.from('manifest.json'))).toBe(true);

      const manifestPath = writeReleaseManifest(
        {
          version: '1.2.3',
          extensionArchive: 'release/extension.zip',
          npmPackageTarball: 'release/package.tgz',
        },
        releaseDir
      );
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
        version: '1.2.3',
        extensionArchive: 'release/extension.zip',
        npmPackageTarball: 'release/package.tgz',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs npm pack with the exact release destination and returns its artifact path', () => {
    const root = makeReleaseTree();
    const releaseDir = join(root, 'release');
    mkdirSync(releaseDir);
    const calls: unknown[][] = [];
    try {
      const tarball = createNpmPackageTarball({
        projectRoot: root,
        releaseDir,
        npm: { command: 'node', argsPrefix: ['/npm-cli.js'] },
        spawn: (command, args, options) => {
          calls.push([command, args, options]);
          return { status: 0, stdout: '[{"filename":"test.tgz"}]', stderr: '' };
        },
      });
      expect(tarball).toBe(join(releaseDir, 'test.tgz'));
      expect(calls).toEqual([
        [
          'node',
          ['/npm-cli.js', 'pack', '--json', '--ignore-scripts', '--pack-destination', releaseDir],
          {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports missing builds and every npm pack failure diagnostic', () => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-release-failures-'));
    const releaseDir = join(root, 'release');
    mkdirSync(releaseDir);
    try {
      expect(() =>
        createExtensionArchive({ name: 'test', version: '1' }, root, releaseDir)
      ).toThrow('Extension build output was not found');
      expect(() => createNpmPackageTarball({ projectRoot: root, releaseDir })).toThrow(
        'CLI build output was not found'
      );

      mkdirSync(join(root, 'dist', 'node-server'), { recursive: true });
      expect(() => createNpmPackageTarball({ projectRoot: root, releaseDir })).toThrow(
        'UI build output was not found'
      );
      mkdirSync(join(root, 'dist', 'ui'), { recursive: true });

      for (const [stderr, stdout, expected] of [
        ['stderr detail', 'stdout detail', 'stderr detail'],
        ['', 'stdout detail', 'stdout detail'],
        ['', '', 'npm pack failed'],
      ]) {
        expect(() =>
          createNpmPackageTarball({
            projectRoot: root,
            releaseDir,
            spawn: () => ({ status: 1, stdout, stderr }),
          })
        ).toThrow(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('packages a complete synthetic release and replaces stale output', () => {
    const root = makeReleaseTree();
    const releaseDir = join(root, 'artifacts', 'release');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'stale.txt'), 'old');
    try {
      const manifest = packageReleaseArtifacts({
        projectRoot: root,
        releaseDir,
        spawn: (_command, args) => {
          const destination = args.at(-1)!;
          writeFileSync(join(destination, 'slicc-test-1.2.3.tgz'), 'tarball');
          return {
            status: 0,
            stdout: '[{"filename":"slicc-test-1.2.3.tgz"}]',
            stderr: '',
          };
        },
      });
      expect(manifest).toEqual({
        version: '1.2.3',
        extensionArchive: 'artifacts/release/slicc-test-extension-v1.2.3.zip',
        npmPackageTarball: 'artifacts/release/slicc-test-1.2.3.tgz',
      });
      expect(existsSync(join(releaseDir, 'stale.txt'))).toBe(false);
      expect(JSON.parse(readFileSync(join(releaseDir, 'release-artifacts.json'), 'utf8'))).toEqual(
        manifest
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
