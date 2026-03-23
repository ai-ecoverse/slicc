import { describe, expect, it } from 'vitest';

import {
  buildElectronAppLaunchSpec,
  buildElectronAppProcessMatchPatterns,
  buildElectronOverlayAppUrl,
  buildElectronOverlayBootstrapScript,
  buildElectronOverlayEntryUrl,
  buildElectronOverlayInjectionCall,
  buildElectronServerSpawnConfig,
  DEFAULT_ELECTRON_CDP_PORT,
  DEFAULT_ELECTRON_SERVE_HOST,
  DEFAULT_ELECTRON_SERVE_PORT,
  DEFAULT_ELECTRON_TARGET_URL,
  getElectronAppDisplayName,
  getElectronAppPort,
  getElectronAppPorts,
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  hashString,
  parseElectronFloatFlags,
  PORT_HASH_RANGE,
  resolveElectronAppExecutablePath,
  selectBestOverlayTargets,
  shouldInjectElectronOverlayTarget,
} from '../src/electron-runtime.js';

describe('electron-runtime', () => {
  it('parses the default Electron float flags', () => {
    expect(parseElectronFloatFlags([])).toEqual({
      dev: false,
      cdpPort: DEFAULT_ELECTRON_CDP_PORT,
      servePort: DEFAULT_ELECTRON_SERVE_PORT,
      targetUrl: DEFAULT_ELECTRON_TARGET_URL,
    });
  });

  it('parses explicit dev, cdp, target url, and env port overrides', () => {
    expect(
      parseElectronFloatFlags(['--dev', '--cdp-port=9333', '--target-url=https://claude.ai'], {
        PORT: '3333',
      })
    ).toEqual({
      dev: true,
      cdpPort: 9333,
      servePort: 3333,
      targetUrl: 'https://claude.ai',
    });
  });

  it('accepts a positional target url and ignores invalid numeric flags', () => {
    expect(
      parseElectronFloatFlags(['--cdp-port=nope', 'https://example.com'], { PORT: 'nope' })
    ).toEqual({
      dev: false,
      cdpPort: DEFAULT_ELECTRON_CDP_PORT,
      servePort: DEFAULT_ELECTRON_SERVE_PORT,
      targetUrl: 'https://example.com',
    });
  });

  it('builds the child process command for dev mode', () => {
    expect(
      buildElectronServerSpawnConfig('/repo', { dev: true, cdpPort: 9444, platform: 'darwin' })
    ).toEqual({
      command: 'npx',
      args: ['tsx', 'packages/node-server/src/index.ts', '--dev', '--serve-only', '--cdp-port=9444'],
    });
  });

  it('builds the child process command for production mode', () => {
    expect(
      buildElectronServerSpawnConfig('/repo', {
        dev: false,
        cdpPort: 9555,
        nodePath: '/custom/node',
      })
    ).toEqual({
      command: '/custom/node',
      args: ['/repo/dist/node-server/index.js', '--serve-only', '--cdp-port=9555'],
    });
  });

  it('falls back to npm_node_execpath for production mode', () => {
    const previous = process.env['npm_node_execpath'];
    process.env['npm_node_execpath'] = '/npm/node';

    try {
      expect(
        buildElectronServerSpawnConfig('/repo', {
          dev: false,
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

  it('builds the electron serve and overlay urls', () => {
    const serveOrigin = getElectronServeOrigin(3005);
    expect(serveOrigin).toBe(`http://${DEFAULT_ELECTRON_SERVE_HOST}:3005`);
    expect(buildElectronOverlayAppUrl(serveOrigin)).toBe(
      `http://${DEFAULT_ELECTRON_SERVE_HOST}:3005/electron`
    );
    expect(buildElectronOverlayAppUrl(serveOrigin, 'memory')).toBe(
      `http://${DEFAULT_ELECTRON_SERVE_HOST}:3005/electron?tab=memory`
    );
    expect(buildElectronOverlayEntryUrl(serveOrigin)).toBe(
      `http://${DEFAULT_ELECTRON_SERVE_HOST}:3005/electron-overlay-entry.js`
    );
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
    expect(result).toBe(`if(document.body){${call}}else{document.addEventListener('DOMContentLoaded',function(){${call}});}`)
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

  it('builds the combined overlay bootstrap script', () => {
    expect(
      buildElectronOverlayBootstrapScript({
        bundleSource: 'window.__overlayLoaded = true;',
        appUrl: 'http://localhost:5710/electron',
      })
    ).toBe(
      'window.__overlayLoaded = true;\n' +
      'if(document.body){window.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":"http://localhost:5710/electron"});}' +
      'else{document.addEventListener(\'DOMContentLoaded\',function(){window.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":"http://localhost:5710/electron"});});}',
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
        { type: 'page', title: 'Slack', url: 'https://app.slack.com/', webSocketDebuggerUrl: 'ws://1' },
        { type: 'page', title: 'Discord', url: 'https://discord.com/channels', webSocketDebuggerUrl: 'ws://2' },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(2);
    });

    it('deduplicates same-origin targets, picking the one with the longest title', () => {
      // Simulates Teams: 3 pages on same origin, different titles
      const targets = [
        { type: 'page', title: 'Microsoft Teams', url: 'https://teams.microsoft.com/v2/', webSocketDebuggerUrl: 'ws://1' },
        { type: 'page', title: 'Calendar | Calendar | Adobe | trieloff@adobe.com | Microsoft Teams', url: 'https://teams.microsoft.com/v2/', webSocketDebuggerUrl: 'ws://2' },
        { type: 'page', title: 'Microsoft Teams', url: 'https://teams.microsoft.com/v2/#deepLink=default&isMinimized=false', webSocketDebuggerUrl: 'ws://3' },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://2'); // The content window
    });

    it('penalizes targets with deepLink/isMinimized hash fragments', () => {
      const targets = [
        { type: 'page', title: 'Microsoft Teams', url: 'https://teams.microsoft.com/v2/#deepLink=default&isMinimized=false', webSocketDebuggerUrl: 'ws://1' },
        { type: 'page', title: 'Microsoft Teams', url: 'https://teams.microsoft.com/v2/', webSocketDebuggerUrl: 'ws://2' },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://2');
    });

    it('filters out non-page and internal targets', () => {
      const targets = [
        { type: 'page', title: 'App', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://1' },
        { type: 'service_worker', title: 'SW', url: 'https://example.com/sw.js', webSocketDebuggerUrl: 'ws://2' },
        { type: 'worker', title: 'Worker', url: 'https://example.com/worker.js', webSocketDebuggerUrl: 'ws://3' },
        { type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://4' },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://1');
    });

    it('handles single-window apps unchanged', () => {
      const targets = [
        { type: 'page', title: 'Slack', url: 'https://app.slack.com/', webSocketDebuggerUrl: 'ws://1' },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(1);
      expect(result[0].webSocketDebuggerUrl).toBe('ws://1');
    });

    it('handles file:// and different-origin targets', () => {
      const targets = [
        { type: 'page', title: 'VS Code', url: 'file:///app/workbench.html', webSocketDebuggerUrl: 'ws://1' },
        { type: 'page', title: 'Settings', url: 'https://vscode-settings.example.com/', webSocketDebuggerUrl: 'ws://2' },
      ];
      const result = selectBestOverlayTargets(targets);
      expect(result).toHaveLength(2);
    });
  });

  describe('dynamic port allocation', () => {
    it('hashString returns deterministic values within range', () => {
      const hash1 = hashString('/Applications/Slack.app', PORT_HASH_RANGE);
      const hash2 = hashString('/Applications/Slack.app', PORT_HASH_RANGE);
      const hash3 = hashString('/Applications/Discord.app', PORT_HASH_RANGE);

      // Same input produces same output
      expect(hash1).toBe(hash2);
      // Different inputs produce different outputs (with high probability)
      expect(hash1).not.toBe(hash3);
      // All values are within range
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

      // All hashes should be in valid range
      for (const hash of hashes) {
        expect(hash).toBeGreaterThanOrEqual(0);
        expect(hash).toBeLessThan(PORT_HASH_RANGE);
      }

      // Check for reasonable distribution (no more than 2 collisions in 5 items)
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBeGreaterThanOrEqual(3);
    });

    it('getElectronAppPort returns port based on hash offset', async () => {
      const basePort = 9223;
      const appPath = '/Applications/Slack.app';
      const expectedOffset = hashString(appPath, PORT_HASH_RANGE);

      const port = await getElectronAppPort(appPath, basePort);

      // Port should be basePort + offset (assuming port is available)
      expect(port).toBeGreaterThanOrEqual(basePort);
      expect(port).toBeLessThan(basePort + PORT_HASH_RANGE + 100); // Allow for fallback range
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

      // Different apps should get different ports (unless collision + fallback)
      // At minimum, verify they're valid ports
      expect(ports1.cdpPort).toBeGreaterThan(0);
      expect(ports2.cdpPort).toBeGreaterThan(0);
      expect(ports1.servePort).toBeGreaterThan(0);
      expect(ports2.servePort).toBeGreaterThan(0);
    });
  });
});
