import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildVfsRootVersionContents,
  updateManifestVersionContents,
  writeManifestVersion,
  writeVfsRootVersion,
} from '../src/sync-release-version.js';

describe('sync-release-version', () => {
  it('updates manifest version JSON content', () => {
    expect(updateManifestVersionContents('{"name":"slicc","version":"0.1.0"}\n', '1.2.3')).toBe(`{
  "name": "slicc",
  "version": "1.2.3"
}\n`);
  });

  it('updates manifest.json on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-sync-release-version-'));
    const manifestPath = join(root, 'manifest.json');

    try {
      writeFileSync(manifestPath, '{"name":"slicc","version":"0.1.0"}\n');
      writeManifestVersion(manifestPath, '2.0.0');

      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: '2.0.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the manifest has no string version', () => {
    expect(() => updateManifestVersionContents('{"name":"slicc"}\n', '1.2.3')).toThrow(
      'manifest.json must contain a string version'
    );
  });

  it('serializes the bundled vfs-root version file with version + releasedAt', () => {
    const releasedAt = '2026-04-28T12:34:56.000Z';
    expect(buildVfsRootVersionContents('1.2.3', releasedAt)).toBe(`{
  "version": "1.2.3",
  "releasedAt": "${releasedAt}"
}\n`);
  });

  it('writes the vfs-root version file to disk so the boot-time detector can read it', () => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-sync-vfs-version-'));
    const versionPath = join(root, 'version.json');
    const releasedAt = '2026-04-28T00:00:00.000Z';

    try {
      writeVfsRootVersion(versionPath, '4.5.6', releasedAt);
      expect(JSON.parse(readFileSync(versionPath, 'utf8'))).toEqual({
        version: '4.5.6',
        releasedAt,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
