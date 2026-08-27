import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_APPEX_NAME, stageWidgetAppex } from './stage-widget-appex.mjs';

describe('stageWidgetAppex', () => {
  let root;
  let appexSource;
  let plugInsDir;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'slicc-widget-appex-'));
    appexSource = resolve(root, 'build', WIDGET_APPEX_NAME);
    plugInsDir = resolve(root, 'PlugIns');
    mkdirSync(resolve(appexSource, 'Contents/MacOS'), { recursive: true });
    writeFileSync(resolve(appexSource, 'Contents/Info.plist'), '<plist></plist>');
    writeFileSync(resolve(appexSource, 'Contents/MacOS/SliccstartWidgets'), 'binary');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the appex into PlugIns/', () => {
    const dest = stageWidgetAppex({ appexSource, plugInsDir });

    expect(dest).toBe(resolve(plugInsDir, WIDGET_APPEX_NAME));
    expect(existsSync(resolve(dest, 'Contents/MacOS/SliccstartWidgets'))).toBe(true);
    expect(existsSync(resolve(dest, 'Contents/Info.plist'))).toBe(true);
  });

  it('embeds nothing — the widget links no third-party framework', () => {
    const dest = stageWidgetAppex({ appexSource, plugInsDir });

    expect(existsSync(resolve(dest, 'Contents/Frameworks'))).toBe(false);
  });

  it('creates PlugIns/ when the host bundle has no extensions yet', () => {
    expect(existsSync(plugInsDir)).toBe(false);

    stageWidgetAppex({ appexSource, plugInsDir });

    expect(existsSync(plugInsDir)).toBe(true);
  });

  it('fails loudly when xcodebuild produced no appex', () => {
    rmSync(appexSource, { recursive: true, force: true });

    expect(() => stageWidgetAppex({ appexSource, plugInsDir })).toThrow(WIDGET_APPEX_NAME);
  });
});
