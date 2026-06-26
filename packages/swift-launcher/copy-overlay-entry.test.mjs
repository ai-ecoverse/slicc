import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyElectronOverlayEntry, OVERLAY_ENTRY_FILENAME } from './copy-overlay-entry.mjs';

describe('copyElectronOverlayEntry', () => {
  let root;
  let distUiDir;
  let resourcesDir;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'slicc-overlay-'));
    distUiDir = resolve(root, 'dist/ui');
    resourcesDir = resolve(root, 'Contents/Resources');
    mkdirSync(distUiDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the overlay bootstrap into Contents/Resources/slicc/dist/ui/', () => {
    const source = resolve(distUiDir, OVERLAY_ENTRY_FILENAME);
    writeFileSync(source, 'window.__SLICC_ELECTRON_OVERLAY__ = {};');

    const dest = copyElectronOverlayEntry({ distUiDir, resourcesDir });

    expect(dest).toBe(resolve(resourcesDir, 'slicc/dist/ui', OVERLAY_ENTRY_FILENAME));
    expect(readFileSync(dest, 'utf8')).toBe('window.__SLICC_ELECTRON_OVERLAY__ = {};');
  });

  it('creates the nested slicc/dist/ui directory when it does not exist', () => {
    writeFileSync(resolve(distUiDir, OVERLAY_ENTRY_FILENAME), '// bootstrap');

    // resourcesDir has no `slicc` subtree yet — the helper must create it.
    const dest = copyElectronOverlayEntry({ distUiDir, resourcesDir });

    expect(dest.endsWith(`slicc/dist/ui/${OVERLAY_ENTRY_FILENAME}`)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('// bootstrap');
  });

  it('fails loudly when the overlay bootstrap source is missing', () => {
    // distUiDir exists but the entry file was never built.
    expect(() => copyElectronOverlayEntry({ distUiDir, resourcesDir })).toThrow(
      /Electron overlay bootstrap not found/
    );
  });
});
