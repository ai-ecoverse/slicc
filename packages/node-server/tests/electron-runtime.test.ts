import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildElectronAppLaunchSpec,
  buildElectronAppProcessMatchPatterns,
  buildElectronChildWindowOptions,
  buildElectronOverlayBootstrapScript,
  buildElectronOverlayInjectionCall,
  buildElectronServerSpawnConfig,
  DEFAULT_ELECTRON_CDP_PORT,
  DEFAULT_ELECTRON_SERVE_HOST,
  DEFAULT_ELECTRON_SERVE_PORT,
  DEFAULT_ELECTRON_TARGET_URL,
  ELECTRON_FLOAT_WINDOW_BOX,
  findAvailablePort,
  getElectronAppDisplayName,
  getElectronAppPort,
  getElectronAppPorts,
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  hashString,
  isExecutableFile,
  isPortAvailable,
  PORT_HASH_RANGE,
  parseElectronFloatFlags,
  resolveElectronAppExecutablePath,
  selectBestOverlayTargets,
  shouldInjectElectronOverlayTarget,
  tryListenOnPort,
  windowOpenFeaturesRequestSize,
} from '../src/electron-runtime.js';

describe('electron-runtime', () => {
  describe('renderer-opened child windows', () => {
    it('detects a requested size in a window.open features string', () => {
      expect(windowOpenFeaturesRequestSize('popup=yes,width=1280,height=800')).toBe(true);
      expect(windowOpenFeaturesRequestSize('height=800')).toBe(true);
      expect(windowOpenFeaturesRequestSize(' innerWidth = 640 , innerHeight = 480 ')).toBe(true);
      expect(windowOpenFeaturesRequestSize('')).toBe(false);
      expect(windowOpenFeaturesRequestSize('noopener,noreferrer')).toBe(false);
      expect(windowOpenFeaturesRequestSize('popup=yes')).toBe(false);
    });

    it('leaves a sized popup alone so the requested 1280×800 is honoured unclamped', () => {
      expect(buildElectronChildWindowOptions('popup=yes,width=1280,height=800')).toEqual({
        autoHideMenuBar: true,
      });
    });

    it('gives a featureless target="_blank" window the default float box', () => {
      expect(buildElectronChildWindowOptions('')).toEqual({
        autoHideMenuBar: true,
        ...ELECTRON_FLOAT_WINDOW_BOX,
      });
      expect(ELECTRON_FLOAT_WINDOW_BOX).toEqual({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 720,
      });
    });
  });

  it('rejects missing executable files', () => {
    expect(isExecutableFile(join(tmpdir(), 'missing-slicc-executable'))).toBe(false);
  });

  it('parses the default Electron float flags', () => {
    expect(parseElectronFloatFlags([])).toEqual({
      cdpPort: DEFAULT_ELECTRON_CDP_PORT,
      servePort: DEFAULT_ELECTRON_SERVE_PORT,
      targetUrl: DEFAULT_ELECTRON_TARGET_URL,
    });
  });

  it('parses explicit cdp, target url, and env port overrides', () => {
    expect(
      parseElectronFloatFlags(['--cdp-port=9333', '--target-url=https://claude.ai'], {
        PORT: '3333',
      })
    ).toEqual({
      cdpPort: 9333,
      servePort: 3333,
      targetUrl: 'https://claude.ai',
    });
  });

  it('accepts a positional target url and ignores invalid numeric flags', () => {
    expect(
      parseElectronFloatFlags(['--cdp-port=nope', 'https://example.com'], { PORT: 'nope' })
    ).toEqual({
      cdpPort: DEFAULT_ELECTRON_CDP_PORT,
      servePort: DEFAULT_ELECTRON_SERVE_PORT,
      targetUrl: 'https://example.com',
    });
  });

  it('builds the child process command with an explicit node path', () => {
    expect(
      buildElectronServerSpawnConfig('/repo', {
        cdpPort: 9555,
        nodePath: '/custom/node',
      })
    ).toEqual({
      command: '/custom/node',
      args: ['/repo/dist/node-server/index.js', '--serve-only', '--cdp-port=9555'],
    });
  });

  it('falls back to npm_node_execpath for the child process command', () => {
    const previous = process.env['npm_node_execpath'];
    process.env['npm_node_execpath'] = '/npm/node';

    try {
      expect(
        buildElectronServerSpawnConfig('/repo', {
          cdpPort: 9666,
        })
      ).toEqual({
        command: '/npm/node',
        args: ['/repo/dist/node-server/index.js', '--serve-only', '--cdp-port=9666'],
      });
    } finally {
      if (previous === undefined) {
        delete process.env['npm_node_execpath'];
      } else {
        process.env['npm_node_execpath'] = previous;
      }
    }
  });

  it('builds the electron serve origin and overlay-entry dist path', () => {
    const serveOrigin = getElectronServeOrigin(3005);
    expect(serveOrigin).toBe(`http://${DEFAULT_ELECTRON_SERVE_HOST}:3005`);
    expect(getElectronOverlayEntryDistPath('/repo')).toBe(
      '/repo/dist/ui/electron-overlay-entry.js'
    );
  });

  it('serializes the overlay injection call with DOMContentLoaded guard', () => {
    const result = buildElectronOverlayInjectionCall({
      appUrl: `http://${DEFAULT_ELECTRON_SERVE_HOST}:3000/electron`,
      open: true,
      activeTab: 'files',
    });
    const call = `window.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":"http://${DEFAULT_ELECTRON_SERVE_HOST}:3000/electron","open":true,"activeTab":"files"});`;
    expect(result).toBe(
      `if(document.body){${call}}else{document.addEventListener('DOMContentLoaded',function(){${call}});}`
    );
  });

  it('serializes optional status-only overlay fields', () => {
    const result = buildElectronOverlayInjectionCall({
      appUrl: '',
      open: false,
      statusMessage: 'Network access blocked',
    });
    expect(result).toContain('"appUrl":"","open":false,"statusMessage":"Network access blocked"');
  });

  it('builds a macOS app launch spec from a .app bundle path', () => {
    expect(
      buildElectronAppLaunchSpec('/Applications/Slack.app', { cdpPort: 9223, platform: 'darwin' })
    ).toEqual({
      command: '/Applications/Slack.app/Contents/MacOS/Slack',
      args: ['--remote-debugging-port=9223'],
      displayName: 'Slack',
      resolvedAppPath: '/Applications/Slack.app',
      processMatchPatterns: [
        '/Applications/Slack.app',
        '/Applications/Slack.app/Contents/MacOS/Slack',
      ],
    });
  });

  it('builds a direct executable launch spec outside macOS app bundles', () => {
    expect(
      buildElectronAppLaunchSpec('/opt/Linear/linear', { cdpPort: 9555, platform: 'linux' })
    ).toEqual({
      command: '/opt/Linear/linear',
      args: ['--remote-debugging-port=9555'],
      displayName: 'linear',
      resolvedAppPath: '/opt/Linear/linear',
      processMatchPatterns: ['/opt/Linear/linear'],
    });
  });

  it('derives the app display name and executable path from a macOS bundle', () => {
    expect(getElectronAppDisplayName('/Applications/Slack.app')).toBe('Slack');
    expect(resolveElectronAppExecutablePath('/Applications/Slack.app', 'darwin')).toBe(
      '/Applications/Slack.app/Contents/MacOS/Slack'
    );
    expect(buildElectronAppProcessMatchPatterns('/Applications/Slack.app', 'darwin')).toEqual([
      '/Applications/Slack.app',
      '/Applications/Slack.app/Contents/MacOS/Slack',
    ]);
  });

  it('discovers expected, Electron, and fallback macOS bundle executables', () => {
    const root = mkdtempSync(join(tmpdir(), 'slicc-electron-runtime-'));
    const app = join(root, 'Example.app');
    const macOS = join(app, 'Contents', 'MacOS');
    mkdirSync(macOS, { recursive: true });
    try {
      const expected = join(macOS, 'Example');
      writeFileSync(expected, 'binary');
      expect(resolveElectronAppExecutablePath(app, 'darwin')).toBe(expected);

      rmSync(expected);
      const electron = join(macOS, 'Electron');
      writeFileSync(electron, 'binary');
      chmodSync(electron, 0o755);
      expect(resolveElectronAppExecutablePath(app, 'darwin')).toBe(electron);

      rmSync(electron);
      writeFileSync(join(macOS, '.hidden'), 'skip');
      writeFileSync(join(macOS, 'setup.sh'), 'skip');
      writeFileSync(join(macOS, 'Example Helper'), 'skip');
      writeFileSync(join(macOS, 'not-executable'), 'skip');
      const main = join(macOS, 'MainApp');
      writeFileSync(main, 'binary');
      chmodSync(main, 0o755);
      expect(resolveElectronAppExecutablePath(app, 'darwin')).toBe(main);

      rmSync(macOS, { recursive: true, force: true });
      expect(resolveElectronAppExecutablePath(app, 'darwin')).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds the combined overlay bootstrap script', () => {
    const appUrl =
      'https://www.sliccy.ai/electron?bridge=ws%3A%2F%2Flocalhost%3A5711%2Fcdp&role=leader';
    expect(
      buildElectronOverlayBootstrapScript({
        bundleSource: 'window.__overlayLoaded = true;',
        appUrl,
      })
    ).toBe(
      'window.__overlayLoaded = true;\n' +
        `if(document.body){window.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":${JSON.stringify(appUrl)}});}` +
        `else{document.addEventListener('DOMContentLoaded',function(){window.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":${JSON.stringify(appUrl)}});});}`
    );
  });

  it('filters out non-page and internal targets for overlay injection', () => {
    expect(
      shouldInjectElectronOverlayTarget({
        type: 'page',
        url: 'https://example.com',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1',
      })
    ).toBe(true);
    expect(
      shouldInjectElectronOverlayTarget({
        type: 'browser',
        url: 'about:blank',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser',
      })
    ).toBe(false);
    expect(
      shouldInjectElectronOverlayTarget({
        type: 'page',
        url: 'devtools://devtools/bundled/inspector.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/2',
      })
    ).toBe(false);
  });

  describe('selectBestOverlayTargets', () => {
    it('returns all targets when they have different origins', () => {
      const targets = [
        {
          type: 'page',
          title: 'Slack',
          url: 'https://app.slack.com/',
          webSocketDebuggerUrl: 'ws://1',
        },
        {
          type: 'page',
          title: 'Discord',
          url: 'https://discord.com/channels',
          webSocketDebuggerUrl: 'ws://2',
        },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(2);
    });

    it('deduplicates same-origin targets, picking the one with the longest title', () => {
      const targets = [
        {
          type: 'page',
          title: 'Microsoft Teams',
          url: 'https://teams.microsoft.com/v2/',
          webSocketDebuggerUrl: 'ws://1',
        },
        {
          type: 'page',
          title: 'Calendar | Calendar | Adobe | trieloff@adobe.com | Microsoft Teams',
          url: 'https://teams.microsoft.com/v2/',
          webSocketDebuggerUrl: 'ws://2',
        },
        {
          type: 'page',
          title: 'Microsoft Teams',
          url: 'https://teams.microsoft.com/v2/#deepLink=default&isMinimized=false',
          webSocketDebuggerUrl: 'ws://3',
        },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://2');
    });

    it('penalizes targets with deepLink/isMinimized hash fragments', () => {
      const targets = [
        {
          type: 'page',
          title: 'Microsoft Teams',
          url: 'https://teams.microsoft.com/v2/#deepLink=default&isMinimized=false',
          webSocketDebuggerUrl: 'ws://1',
        },
        {
          type: 'page',
          title: 'Microsoft Teams',
          url: 'https://teams.microsoft.com/v2/',
          webSocketDebuggerUrl: 'ws://2',
        },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://2');
    });

    it('filters out non-page and internal targets', () => {
      const targets = [
        { type: 'page', title: 'App', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://1' },
        {
          type: 'service_worker',
          title: 'SW',
          url: 'https://example.com/sw.js',
          webSocketDebuggerUrl: 'ws://2',
        },
        {
          type: 'worker',
          title: 'Worker',
          url: 'https://example.com/worker.js',
          webSocketDebuggerUrl: 'ws://3',
        },
        {
          type: 'page',
          title: 'DevTools',
          url: 'devtools://devtools/bundled/inspector.html',
          webSocketDebuggerUrl: 'ws://4',
        },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://1');
    });

    it('handles single-window apps unchanged', () => {
      const targets = [
        {
          type: 'page',
          title: 'Slack',
          url: 'https://app.slack.com/',
          webSocketDebuggerUrl: 'ws://1',
        },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://1');
    });

    it('handles file:// and different-origin targets', () => {
      const targets = [
        {
          type: 'page',
          title: 'VS Code',
          url: 'file:///app/workbench.html',
          webSocketDebuggerUrl: 'ws://1',
        },
        {
          type: 'page',
          title: 'Settings',
          url: 'https://vscode-settings.example.com/',
          webSocketDebuggerUrl: 'ws://2',
        },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(2);
    });

    it('keeps malformed target URLs in a stable fallback origin group', () => {
      const result = selectBestOverlayTargets([
        { type: 'page', title: 'short', url: 'not a url', webSocketDebuggerUrl: 'ws://1' },
        {
          type: 'page',
          title: 'a longer title',
          url: 'not a url',
          webSocketDebuggerUrl: 'ws://2',
        },
      ]);
      expect(result.map((target) => target.webSocketDebuggerUrl)).toEqual(['ws://2']);
    });
  });

  describe('dynamic port allocation', () => {
    it('binds an ephemeral loopback port and closes it again', async () => {
      await expect(tryListenOnPort(0, '127.0.0.1')).resolves.toBeGreaterThan(0);
    });

    it('classifies IPv4 and IPv6 bind failures independently', async () => {
      const hosts: string[] = [];
      await expect(
        isPortAvailable(9000, async (_port, host) => {
          hosts.push(host);
          return 9000;
        })
      ).resolves.toBe(true);
      expect(hosts).toEqual(['127.0.0.1', '::1']);

      await expect(
        isPortAvailable(9000, async () => {
          throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
        })
      ).resolves.toBe(false);

      let call = 0;
      await expect(
        isPortAvailable(9000, async () => {
          call++;
          if (call === 2) throw Object.assign(new Error('no ipv6'), { code: 'EAFNOSUPPORT' });
          return 9000;
        })
      ).resolves.toBe(true);

      call = 0;
      await expect(
        isPortAvailable(9000, async () => {
          call++;
          if (call === 2) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
          return 9000;
        })
      ).resolves.toBe(false);
    });

    it('searches forward for a port and fails after the bounded attempt count', async () => {
      await expect(findAvailablePort(9100, 3, async (port) => port === 9102)).resolves.toBe(9102);
      await expect(findAvailablePort(9100, 2, async () => false)).rejects.toThrow(
        'Could not find available port starting from 9100'
      );
    });

    it('uses the preferred app slot or advances to the next open port', async () => {
      const appPath = '/Applications/Test.app';
      const preferred = 9200 + hashString(appPath, PORT_HASH_RANGE);
      await expect(getElectronAppPort(appPath, 9200, async () => true)).resolves.toBe(preferred);
      await expect(
        getElectronAppPort(appPath, 9200, async (port) => port === preferred + 2)
      ).resolves.toBe(preferred + 2);
    });

    it('hashString returns deterministic values within range', () => {
      const hash1 = hashString('/Applications/Slack.app', PORT_HASH_RANGE);
      const hash2 = hashString('/Applications/Slack.app', PORT_HASH_RANGE);
      const hash3 = hashString('/Applications/Discord.app', PORT_HASH_RANGE);

      expect(hash1).toBe(hash2);

      expect(hash1).not.toBe(hash3);

      expect(hash1).toBeGreaterThanOrEqual(0);
      expect(hash1).toBeLessThan(PORT_HASH_RANGE);
      expect(hash3).toBeGreaterThanOrEqual(0);
      expect(hash3).toBeLessThan(PORT_HASH_RANGE);
    });

    it('hashString handles empty string', () => {
      const hash = hashString('', PORT_HASH_RANGE);
      expect(hash).toBe(0);
    });

    it('hashString handles various app paths', () => {
      const paths = [
        '/Applications/Visual Studio Code.app',
        '/Applications/Slack.app',
        '/Applications/Discord.app',
        '/Applications/Linear.app',
        '/opt/electron-app/myapp',
      ];
      const hashes = paths.map((p) => hashString(p, PORT_HASH_RANGE));

      for (const hash of hashes) {
        expect(hash).toBeGreaterThanOrEqual(0);
        expect(hash).toBeLessThan(PORT_HASH_RANGE);
      }

      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBeGreaterThanOrEqual(3);
    });

    it('getElectronAppPort returns port based on hash offset', async () => {
      const basePort = 9223;
      const appPath = '/Applications/Slack.app';
      const expectedOffset = hashString(appPath, PORT_HASH_RANGE);

      const port = await getElectronAppPort(appPath, basePort);

      expect(port).toBeGreaterThanOrEqual(basePort);
      expect(port).toBeLessThan(basePort + PORT_HASH_RANGE + 100);
    });

    it('getElectronAppPorts returns both CDP and serve ports', async () => {
      const appPath = '/Applications/Discord.app';
      const ports = await getElectronAppPorts(appPath);

      expect(ports).toHaveProperty('cdpPort');
      expect(ports).toHaveProperty('servePort');
      expect(ports.cdpPort).toBeGreaterThanOrEqual(DEFAULT_ELECTRON_CDP_PORT);
      expect(ports.servePort).toBeGreaterThanOrEqual(DEFAULT_ELECTRON_SERVE_PORT);
    });

    it('different apps get different ports', async () => {
      const ports1 = await getElectronAppPorts('/Applications/Slack.app');
      const ports2 = await getElectronAppPorts('/Applications/Discord.app');

      expect(ports1.cdpPort).toBeGreaterThan(0);
      expect(ports2.cdpPort).toBeGreaterThan(0);
      expect(ports1.servePort).toBeGreaterThan(0);
      expect(ports2.servePort).toBeGreaterThan(0);
    });
  });
});
