import { type existsSync, type readdirSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildChromeLaunchArgs,
  DEFAULT_CDP_LAUNCH_TIMEOUT_MS,
  ensureQaProfileScaffold,
  findChromeExecutable,
  getDefaultCdpLaunchTimeoutMs,
  parseCdpPortFromStderr,
  planChromeSpawn,
  resolveChromeAppBundle,
  resolveChromeLaunchProfile,
  waitForCdpPort,
  waitForCdpPortFromActivePortFile,
  waitForCdpPortFromStderr,
} from '../src/chrome-launch.js';

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

  it('appends serve port to default profile dir when not the default port', () => {
    const profile = resolveChromeLaunchProfile({
      projectRoot: '/repo',
      tmpDir: '/tmp/test-root',
      servePort: 5720,
    });

    expect(profile.userDataDir).toBe('/tmp/test-root/browser-coding-agent-chrome-5720');
  });

  it('omits port suffix for the default serve port 5710', () => {
    const profile = resolveChromeLaunchProfile({
      projectRoot: '/repo',
      tmpDir: '/tmp/test-root',
      servePort: 5710,
    });

    expect(profile.userDataDir).toBe('/tmp/test-root/browser-coding-agent-chrome');
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
      '--disable-crash-reporter',
      '--disable-background-tracing',
      '--user-data-dir=/repo/.qa/chrome/extension',
      '--disable-extensions-except=/repo/dist/extension',
      '--load-extension=/repo/dist/extension',
      'http://localhost:3000',
    ]);
  });

  describe('resolveChromeAppBundle', () => {
    it('walks up to the canonical Chrome .app bundle on darwin', () => {
      expect(
        resolveChromeAppBundle(
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          'darwin'
        )
      ).toBe('/Applications/Google Chrome.app');
    });

    it('walks up to a Chrome for Testing bundle on darwin', () => {
      const exe =
        '/Users/test/.cache/puppeteer/chrome/mac-123/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
      expect(resolveChromeAppBundle(exe, 'darwin')).toBe(
        '/Users/test/.cache/puppeteer/chrome/mac-123/chrome-mac-arm64/Google Chrome for Testing.app'
      );
    });

    it('returns null on non-darwin platforms even when given a .app-style path', () => {
      const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      expect(resolveChromeAppBundle(exe, 'linux')).toBeNull();
      expect(resolveChromeAppBundle(exe, 'win32')).toBeNull();
    });

    it('returns null for bare-binary paths on darwin', () => {
      expect(resolveChromeAppBundle('/usr/local/bin/chromium', 'darwin')).toBeNull();
      expect(resolveChromeAppBundle('/tmp/just-a-binary', 'darwin')).toBeNull();
    });
  });

  describe('planChromeSpawn', () => {
    const baseArgs = [
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/profile',
      'about:blank',
    ];

    it('routes darwin Chrome through /usr/bin/open with -n -a <bundle> -W --args …', () => {
      // The exact prefix shape matters: dropping `--args` would let `open`
      // swallow Chrome's flags into its own option parser; reordering
      // before `--args` would do the same. Pin the full prefix so a
      // refactor that breaks LaunchServices delegation breaks the build.
      const plan = planChromeSpawn({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        chromeArgs: baseArgs,
        platform: 'darwin',
      });
      expect(plan.command).toBe('/usr/bin/open');
      expect(plan.args.slice(0, 5)).toEqual([
        '-n',
        '-a',
        '/Applications/Google Chrome.app',
        '-W',
        '--args',
      ]);
      expect(plan.args.slice(5)).toEqual(baseArgs);
      expect(plan.usesLaunchServices).toBe(true);
    });

    it('uses a direct exec on linux and windows', () => {
      const linuxPlan = planChromeSpawn({
        executablePath: '/usr/bin/google-chrome',
        chromeArgs: baseArgs,
        platform: 'linux',
      });
      expect(linuxPlan).toEqual({
        command: '/usr/bin/google-chrome',
        args: baseArgs,
        usesLaunchServices: false,
      });

      const winPlan = planChromeSpawn({
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        chromeArgs: baseArgs,
        platform: 'win32',
      });
      expect(winPlan.command).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
      expect(winPlan.usesLaunchServices).toBe(false);
    });

    it('falls back to direct exec for bare-binary paths on darwin', () => {
      const plan = planChromeSpawn({
        executablePath: '/opt/chromium/chromium-bin',
        chromeArgs: baseArgs,
        platform: 'darwin',
      });
      expect(plan).toEqual({
        command: '/opt/chromium/chromium-bin',
        args: baseArgs,
        usesLaunchServices: false,
      });
    });
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

  it('parses the DevTools line when it spans multiple chunks (the original flake)', async () => {
    // Regression: stderr `data` events split on byte boundaries, not on
    // newlines. The original implementation regex'd each chunk in
    // isolation, so a line like "DevTools listening on ws://…" arriving
    // as ["DevTools listening", " on ws://127.0.0.1:9222/devtools/…\n"]
    // was silently dropped and the watcher waited forever (until the
    // timeout). Buffering across chunks prevents this.
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPortFromStderr(child, 5000);

    stderr.emit('data', Buffer.from('[noise] starting up\nDevTools listening'));
    stderr.emit('data', Buffer.from(' on ws://127.0.0.1:'));
    stderr.emit('data', Buffer.from('57321/devtools/browser/abc-123\n'));

    await expect(promise).resolves.toBe(57321);
  });
});

describe('getDefaultCdpLaunchTimeoutMs', () => {
  it('returns the built-in default when the env var is unset', () => {
    expect(getDefaultCdpLaunchTimeoutMs({})).toBe(DEFAULT_CDP_LAUNCH_TIMEOUT_MS);
  });

  it('honors a positive integer override', () => {
    expect(getDefaultCdpLaunchTimeoutMs({ SLICC_CDP_LAUNCH_TIMEOUT_MS: '45000' })).toBe(45000);
  });

  it('falls back to the default for non-positive or non-numeric overrides', () => {
    expect(getDefaultCdpLaunchTimeoutMs({ SLICC_CDP_LAUNCH_TIMEOUT_MS: '0' })).toBe(
      DEFAULT_CDP_LAUNCH_TIMEOUT_MS
    );
    expect(getDefaultCdpLaunchTimeoutMs({ SLICC_CDP_LAUNCH_TIMEOUT_MS: '-100' })).toBe(
      DEFAULT_CDP_LAUNCH_TIMEOUT_MS
    );
    expect(getDefaultCdpLaunchTimeoutMs({ SLICC_CDP_LAUNCH_TIMEOUT_MS: 'not-a-number' })).toBe(
      DEFAULT_CDP_LAUNCH_TIMEOUT_MS
    );
  });
});

describe('waitForCdpPortFromActivePortFile', () => {
  it('resolves with the port written to DevToolsActivePort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-active-port-'));
    tempDirs.push(dir);
    const { EventEmitter } = await import('events');
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;

    const promise = waitForCdpPortFromActivePortFile(dir, child, 2000, 10);
    // Simulate Chrome writing the file shortly after launch.
    setTimeout(() => {
      void writeFile(join(dir, 'DevToolsActivePort'), '49321\n/devtools/browser/abc-123\n');
    }, 30);

    await expect(promise).resolves.toBe(49321);
  });

  it('rejects on timeout when the file never appears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-active-port-'));
    tempDirs.push(dir);
    const { EventEmitter } = await import('events');
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;

    await expect(waitForCdpPortFromActivePortFile(dir, child, 100, 10)).rejects.toThrow(
      /Timed out waiting for DevToolsActivePort/
    );
  });

  it('rejects when Chrome exits before writing the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-active-port-'));
    tempDirs.push(dir);
    const { EventEmitter } = await import('events');
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;

    const promise = waitForCdpPortFromActivePortFile(dir, child, 5000, 10);
    setTimeout(() => child.emit('exit', 1), 20);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });
});

describe('waitForCdpPort (race)', () => {
  it('resolves from stderr when the active-port file is delayed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-active-port-'));
    tempDirs.push(dir);
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPort(child, { userDataDir: dir, timeoutMs: 5000 });
    stderr.emit(
      'data',
      Buffer.from('DevTools listening on ws://127.0.0.1:11111/devtools/browser/id\n')
    );

    await expect(promise).resolves.toBe(11111);
  });

  it('resolves from the active-port file when stderr never prints the line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slicc-active-port-'));
    tempDirs.push(dir);
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPort(child, { userDataDir: dir, timeoutMs: 2000 });
    setTimeout(() => {
      void writeFile(join(dir, 'DevToolsActivePort'), '22222\n/devtools/browser/zzz\n');
    }, 30);

    await expect(promise).resolves.toBe(22222);
  });

  it('falls back to plain stderr-only waiting when no userDataDir is provided', async () => {
    const { EventEmitter } = await import('events');
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as import('child_process').ChildProcess;
    (child as { stderr: typeof stderr }).stderr = stderr;

    const promise = waitForCdpPort(child, { timeoutMs: 5000 });
    stderr.emit(
      'data',
      Buffer.from('DevTools listening on ws://127.0.0.1:33333/devtools/browser/id\n')
    );

    await expect(promise).resolves.toBe(33333);
  });
});
