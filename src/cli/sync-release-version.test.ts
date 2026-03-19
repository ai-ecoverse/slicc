import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { updateManifestVersionContents, writeManifestVersion } from './sync-release-version.js';

describe('sync-release-version', () => {
  it('updates manifest version JSON content', () => {
    expect(
      updateManifestVersionContents('{"name":"slicc","version":"0.1.0"}\n', '1.2.3'),
    ).toBe(`{
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
      'manifest.json must contain a string version',
    );
  });
});