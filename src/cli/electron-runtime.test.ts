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
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  parseElectronFloatFlags,
  resolveElectronAppExecutablePath,
  shouldInjectElectronOverlayTarget,
} from './electron-runtime.js';

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
      parseElectronFloatFlags(
        ['--dev', '--cdp-port=9333', '--target-url=https://claude.ai'],
        { PORT: '3333' },
      ),
    ).toEqual({
      dev: true,
      cdpPort: 9333,
      servePort: 3333,
      targetUrl: 'https://claude.ai',
    });
  });

  it('accepts a positional target url and ignores invalid numeric flags', () => {
    expect(
      parseElectronFloatFlags(['--cdp-port=nope', 'https://example.com'], { PORT: 'nope' }),
    ).toEqual({
      dev: false,
      cdpPort: DEFAULT_ELECTRON_CDP_PORT,
      servePort: DEFAULT_ELECTRON_SERVE_PORT,
      targetUrl: 'https://example.com',
    });
  });

  it('builds the child process command for dev mode', () => {
    expect(
      buildElectronServerSpawnConfig('/repo', { dev: true, cdpPort: 9444, platform: 'darwin' }),
    ).toEqual({
      command: 'npx',
      args: ['tsx', 'src/cli/index.ts', '--dev', '--serve-only', '--cdp-port=9444'],
    });
  });

  it('builds the child process command for production mode', () => {
    expect(
      buildElectronServerSpawnConfig('/repo', {
        dev: false,
        cdpPort: 9555,
        nodePath: '/custom/node',
      }),
    ).toEqual({
      command: '/custom/node',
      args: ['/repo/dist/cli/index.js', '--serve-only', '--cdp-port=9555'],
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
        }),
      ).toEqual({
        command: '/npm/node',
        args: ['/repo/dist/cli/index.js', '--serve-only', '--cdp-port=9666'],
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
    expect(buildElectronOverlayAppUrl(serveOrigin, 'memory')).toBe(
      `http://${DEFAULT_ELECTRON_SERVE_HOST}:3005/?runtime=electron-overlay&tab=memory`,
    );
    expect(buildElectronOverlayEntryUrl(serveOrigin)).toBe(
      `http://${DEFAULT_ELECTRON_SERVE_HOST}:3005/electron-overlay-entry.js`,
    );
    expect(getElectronOverlayEntryDistPath('/repo')).toBe('/repo/dist/ui/electron-overlay-entry.js');
  });

  it('serializes the overlay injection call', () => {
    expect(
      buildElectronOverlayInjectionCall({
        appUrl: `http://${DEFAULT_ELECTRON_SERVE_HOST}:3000/?runtime=electron-overlay`,
        open: true,
        activeTab: 'files',
      }),
    ).toBe(
      `window.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":"http://${DEFAULT_ELECTRON_SERVE_HOST}:3000/?runtime=electron-overlay","open":true,"activeTab":"files"});`,
    );
  });

  it('builds a macOS app launch spec from a .app bundle path', () => {
    expect(
      buildElectronAppLaunchSpec('/Applications/Slack.app', { cdpPort: 9223, platform: 'darwin' }),
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
      buildElectronAppLaunchSpec('/opt/Linear/linear', { cdpPort: 9555, platform: 'linux' }),
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
      '/Applications/Slack.app/Contents/MacOS/Slack',
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
        appUrl: 'http://localhost:3000/?runtime=electron-overlay',
      }),
    ).toBe(
      'window.__overlayLoaded = true;\nwindow.__SLICC_ELECTRON_OVERLAY__?.inject({"appUrl":"http://localhost:3000/?runtime=electron-overlay"});',
    );
  });

  it('filters out non-page and internal targets for overlay injection', () => {
    expect(
      shouldInjectElectronOverlayTarget({
        type: 'page',
        url: 'https://example.com',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1',
      }),
    ).toBe(true);
    expect(
      shouldInjectElectronOverlayTarget({
        type: 'browser',
        url: 'about:blank',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser',
      }),
    ).toBe(false);
    expect(
      shouldInjectElectronOverlayTarget({
        type: 'page',
        url: 'devtools://devtools/bundled/inspector.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/2',
      }),
    ).toBe(false);
  });
});