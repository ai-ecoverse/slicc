import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_PROVIDER_APPEX_NAME,
  stageFileProviderAppex,
} from './stage-file-provider-appex.mjs';

describe('stageFileProviderAppex', () => {
  let root;
  let appexSource;
  let plugInsDir;
  let webrtcFramework;
  let appIconIcns;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'slicc-appex-'));
    appexSource = resolve(root, 'build', FILE_PROVIDER_APPEX_NAME);
    plugInsDir = resolve(root, 'PlugIns');
    webrtcFramework = resolve(root, 'WebRTC.framework');
    appIconIcns = resolve(root, 'AppIcon.icns');
    mkdirSync(resolve(appexSource, 'Contents/MacOS'), { recursive: true });
    writeFileSync(resolve(appexSource, 'Contents/Info.plist'), '<plist></plist>');
    writeFileSync(resolve(appexSource, 'Contents/MacOS/SliccFileProvider'), 'binary');
    mkdirSync(resolve(webrtcFramework, 'Versions/A'), { recursive: true });
    writeFileSync(resolve(webrtcFramework, 'Versions/A/WebRTC'), 'webrtc');
    writeFileSync(appIconIcns, 'icns');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the appex, WebRTC.framework, and AppIcon.icns into PlugIns/', () => {
    const dest = stageFileProviderAppex({
      appexSource,
      plugInsDir,
      webrtcFramework,
      appIconIcns,
    });

    expect(dest).toBe(resolve(plugInsDir, FILE_PROVIDER_APPEX_NAME));
    expect(existsSync(resolve(dest, 'Contents/MacOS/SliccFileProvider'))).toBe(true);
    expect(existsSync(resolve(dest, 'Contents/Frameworks/WebRTC.framework/Versions/A/WebRTC'))).toBe(
      true
    );
    expect(existsSync(resolve(dest, 'Contents/Resources/AppIcon.icns'))).toBe(true);
  });

  it('fails loudly when the built appex is missing', () => {
    expect(() =>
      stageFileProviderAppex({
        appexSource: resolve(root, 'missing.appex'),
        plugInsDir,
        webrtcFramework,
        appIconIcns,
      })
    ).toThrow(/SliccFileProvider\.appex not found/);
  });

  it('fails loudly when WebRTC.framework is missing', () => {
    expect(() =>
      stageFileProviderAppex({
        appexSource,
        plugInsDir,
        webrtcFramework: resolve(root, 'missing.framework'),
        appIconIcns,
      })
    ).toThrow(/WebRTC\.framework not found/);
  });

  it('fails loudly when AppIcon.icns is missing', () => {
    expect(() =>
      stageFileProviderAppex({
        appexSource,
        plugInsDir,
        webrtcFramework,
        appIconIcns: resolve(root, 'missing.icns'),
      })
    ).toThrow(/AppIcon\.icns not found/);
  });
});
