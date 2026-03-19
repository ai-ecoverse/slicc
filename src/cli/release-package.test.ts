import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  assertMatchingVersions,
  collectZipEntries,
  createDeterministicZip,
  parseNpmPackFilename,
  sanitizeArtifactName,
} from './release-package.js';

describe('release-package', () => {
  it('sanitizes artifact names for stable filenames', () => {
    expect(sanitizeArtifactName('@AI-Ecoverse/SLICC Release')).toBe('ai-ecoverse-slicc-release');
  });

  it('fails when package and extension versions diverge', () => {
    expect(() => assertMatchingVersions('0.1.0', '0.2.0')).toThrow(
      'package.json version (0.1.0) must match manifest.json version (0.2.0)'
    );
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
});
