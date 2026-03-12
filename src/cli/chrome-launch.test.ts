import { existsSync, readdirSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildChromeLaunchArgs,
  ensureQaProfileScaffold,
  findChromeExecutable,
  resolveChromeLaunchProfile,
} from './chrome-launch.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('chrome-launch', () => {
  it('uses the legacy tmp profile when no QA profile is requested', () => {
    const profile = resolveChromeLaunchProfile({
      projectRoot: '/repo',
      tmpDir: '/tmp/test-root',
    });

    expect(profile).toEqual({
      id: null,
      displayName: 'Chrome',
      userDataDir: '/tmp/test-root/browser-coding-agent-chrome',
      extensionPath: null,
    });
  });

  it('resolves the extension QA profile inside the repo and points at dist/extension', () => {
    const profile = resolveChromeLaunchProfile({
      projectRoot: '/repo',
      profile: 'extension',
    });

    expect(profile).toEqual({
      id: 'extension',
      displayName: 'SLICC QA Extension',
      userDataDir: '/repo/.qa/chrome/extension',
      extensionPath: '/repo/dist/extension',
    });
  });

  it('rejects unknown QA profile names', () => {
    expect(() =>
      resolveChromeLaunchProfile({
        projectRoot: '/repo',
        profile: 'mystery',
      }),
    ).toThrow(/Unknown Chrome profile/);
  });

  it('builds Chrome launch args with extension flags for the extension profile', () => {
    const profile = resolveChromeLaunchProfile({
      projectRoot: '/repo',
      profile: 'extension',
    });

    expect(
      buildChromeLaunchArgs({
        cdpPort: 9222,
        launchUrl: 'http://localhost:3000',
        profile,
      }),
    ).toEqual([
      '--remote-debugging-port=9222',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=/repo/.qa/chrome/extension',
      '--disable-extensions-except=/repo/dist/extension',
      '--load-extension=/repo/dist/extension',
      'http://localhost:3000',
    ]);
  });

  it('prefers CHROME_PATH over discovered installations', () => {
    expect(
      findChromeExecutable({
        env: { CHROME_PATH: '/custom/chrome' },
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) => String(path) === '/custom/chrome',
        readdirSyncImpl: () => [],
      }),
    ).toBe('/custom/chrome');
  });

  it('resolves a macOS .app bundle CHROME_PATH to the inner executable', () => {
    const appPath = '/Applications/Google Chrome.app';
    const binaryPath =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        env: { CHROME_PATH: appPath },
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          String(path) === appPath || String(path) === binaryPath,
        readdirSyncImpl: () => [],
      }),
    ).toBe(binaryPath);
  });

  it('falls back to the raw CHROME_PATH when .app binary is missing', () => {
    const appPath = '/Applications/Weird Browser.app';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        env: { CHROME_PATH: appPath },
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          String(path) === appPath,
        readdirSyncImpl: () => [],
      }),
    ).toBe(appPath);
  });

  it('finds the newest Chrome for Testing binary in the Puppeteer cache', () => {
    expect(
      findChromeExecutable({
        platform: 'darwin',
        homeDir: '/Users/tester',
        env: {},
        readdirSyncImpl: ((path: Parameters<typeof readdirSync>[0]) => {
          expect(String(path)).toBe('/Users/tester/.cache/puppeteer/chrome');
          return ['mac_arm-130.0.6723.58', 'mac_arm-131.0.6778.204'];
        }) as typeof readdirSync,
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          String(path) ===
          '/Users/tester/.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      }),
    ).toBe(
      '/Users/tester/.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
  });

  it('creates seeded QA profile directories and profile metadata files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'slicc-qa-'));
    tempDirs.push(projectRoot);

    const profiles = await ensureQaProfileScaffold(projectRoot);
    expect(profiles.map((profile) => profile.id)).toEqual(['leader', 'follower', 'extension']);

    const localState = JSON.parse(
      await readFile(join(projectRoot, '.qa', 'chrome', 'leader', 'Local State'), 'utf8'),
    ) as {
      profile?: { info_cache?: { Default?: { name?: string; profile_highlight_color?: number } } };
    };
    expect(localState.profile?.info_cache?.Default?.name).toBe('SLICC QA Leader');
    expect(typeof localState.profile?.info_cache?.Default?.profile_highlight_color).toBe(
      'number',
    );

    const preferences = JSON.parse(
      await readFile(
        join(projectRoot, '.qa', 'chrome', 'extension', 'Default', 'Preferences'),
        'utf8',
      ),
    ) as { profile?: { name?: string } };
    expect(preferences.profile?.name).toBe('SLICC QA Extension');
  });
});