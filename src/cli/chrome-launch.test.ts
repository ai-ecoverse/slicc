import { existsSync, readdirSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildChromeLaunchArgs,
  ensureQaProfileScaffold,
  findChromeExecutable,
  parseCdpPortFromStderr,
  resolveChromeLaunchProfile,
  waitForCdpPortFromStderr,
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
      })
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
      })
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
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          String(path) === '/custom/chrome',
        readdirSyncImpl: () => [],
      })
    ).toBe('/custom/chrome');
  });

  it('resolves a macOS .app bundle CHROME_PATH to the inner executable', () => {
    const appPath = '/Applications/Google Chrome.app';
    const binaryPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        env: { CHROME_PATH: appPath },
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          String(path) === appPath || String(path) === binaryPath,
        readdirSyncImpl: () => [],
      })
    ).toBe(binaryPath);
  });

  it('falls back to the raw CHROME_PATH when .app binary is missing', () => {
    const appPath = '/Applications/Weird Browser.app';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        env: { CHROME_PATH: appPath },
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) => String(path) === appPath,
        readdirSyncImpl: () => [],
      })
    ).toBe(appPath);
  });

  it('keeps Chrome for Testing first by default when both it and installed Chrome exist', () => {
    const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromeForTesting =
      '/Users/tester/.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        homeDir: '/Users/tester',
        env: {},
        readdirSyncImpl: ((path: Parameters<typeof readdirSync>[0]) => {
          expect(String(path)).toBe('/Users/tester/.cache/puppeteer/chrome');
          return ['mac_arm-131.0.6778.204'];
        }) as typeof readdirSync,
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          [installedChrome, chromeForTesting].includes(String(path)),
      })
    ).toBe(chromeForTesting);
  });

  it('prefers installed Chrome when explicitly requested', () => {
    const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromeForTesting =
      '/Users/tester/.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        homeDir: '/Users/tester',
        env: {},
        executablePreference: 'installed',
        readdirSyncImpl: ((path: Parameters<typeof readdirSync>[0]) => {
          expect(String(path)).toBe('/Users/tester/.cache/puppeteer/chrome');
          return ['mac_arm-131.0.6778.204'];
        }) as typeof readdirSync,
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          [installedChrome, chromeForTesting].includes(String(path)),
      })
    ).toBe(installedChrome);
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
      })
    ).toBe(
      '/Users/tester/.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
  });

  it('falls back to Chrome for Testing when installed-preferred mode has no installed Chrome', () => {
    const chromeForTesting =
      '/Users/tester/.cache/puppeteer/chrome/mac_arm-131.0.6778.204/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

    expect(
      findChromeExecutable({
        platform: 'darwin',
        homeDir: '/Users/tester',
        env: {},
        executablePreference: 'installed',
        readdirSyncImpl: ((path: Parameters<typeof readdirSync>[0]) => {
          expect(String(path)).toBe('/Users/tester/.cache/puppeteer/chrome');
          return ['mac_arm-131.0.6778.204'];
        }) as typeof readdirSync,
        existsSyncImpl: (path: Parameters<typeof existsSync>[0]) =>
          String(path) === chromeForTesting,
      })
    ).toBe(chromeForTesting);
  });

  it('creates seeded QA profile directories and profile metadata files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'slicc-qa-'));
    tempDirs.push(projectRoot);

    const profiles = await ensureQaProfileScaffold(projectRoot);
    expect(profiles.map((profile) => profile.id)).toEqual(['leader', 'follower', 'extension']);

    const localState = JSON.parse(
      await readFile(join(projectRoot, '.qa', 'chrome', 'leader', 'Local State'), 'utf8')
    ) as {
      profile?: { info_cache?: { Default?: { name?: string; profile_highlight_color?: number } } };
    };
    expect(localState.profile?.info_cache?.Default?.name).toBe('SLICC QA Leader');
    expect(typeof localState.profile?.info_cache?.Default?.profile_highlight_color).toBe('number');

    const preferences = JSON.parse(
      await readFile(
        join(projectRoot, '.qa', 'chrome', 'extension', 'Default', 'Preferences'),
        'utf8'
      )
    ) as { profile?: { name?: string } };
    expect(preferences.profile?.name).toBe('SLICC QA Extension');
  });
});

describe('parseCdpPortFromStderr', () => {
  it('extracts the port from a standard Chrome DevTools line', () => {
    expect(
      parseCdpPortFromStderr('DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-123')
    ).toBe(9222);
  });

  it('extracts a non-default port', () => {
    expect(
      parseCdpPortFromStderr('DevTools listening on ws://127.0.0.1:41567/devtools/browser/abc-123')
    ).toBe(41567);
  });

  it('returns null for unrelated stderr output', () => {
    expect(parseCdpPortFromStderr('[0312/120000:WARNING] something else')).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(parseCdpPortFromStderr('')).toBe(null);
  });

  it('handles 0.0.0.0 host binding', () => {
    expect(
      parseCdpPortFromStderr('DevTools listening on ws://0.0.0.0:9333/devtools/browser/xyz')
    ).toBe(9333);
  });
});

describe('waitForCdpPortFromStderr', () => {
  it('resolves with the port when Chrome prints the DevTools line', async () => {
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPortFromStderr(child, 5000);

    // Simulate Chrome printing to stderr
    stderr.emit(
      'data',
      Buffer.from('DevTools listening on ws://127.0.0.1:44123/devtools/browser/id\n')
    );

    await expect(promise).resolves.toBe(44123);
  });

  it('handles multi-line chunks with the DevTools line after noise', async () => {
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPortFromStderr(child, 5000);

    stderr.emit(
      'data',
      Buffer.from(
        '[WARNING] some noise\nDevTools listening on ws://127.0.0.1:9222/devtools/browser/id\n'
      )
    );

    await expect(promise).resolves.toBe(9222);
  });

  it('rejects when Chrome exits before printing the DevTools line', async () => {
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPortFromStderr(child, 5000);

    child.emit('exit', 1);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it('rejects on timeout', async () => {
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPortFromStderr(child, 50);

    await expect(promise).rejects.toThrow(/Timed out/);
  });
});
