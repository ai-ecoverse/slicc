import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLI_CDP_PORT,
  DEFAULT_ELECTRON_ATTACH_CDP_PORT,
  parseCliRuntimeFlags,
} from './runtime-flags.js';

describe('parseCliRuntimeFlags', () => {
  it('uses the default CLI runtime flags', () => {
    expect(parseCliRuntimeFlags([])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_CLI_CDP_PORT,
      electron: false,
      electronApp: null,
      kill: false,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses dev and serve-only flags', () => {
    expect(parseCliRuntimeFlags(['--dev', '--serve-only'])).toEqual({
      dev: true,
      serveOnly: true,
      cdpPort: DEFAULT_CLI_CDP_PORT,
      electron: false,
      electronApp: null,
      kill: false,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses an explicit CDP port', () => {
    expect(parseCliRuntimeFlags(['--cdp-port=9333']).cdpPort).toBe(9333);
  });

  it('ignores invalid CDP ports', () => {
    expect(parseCliRuntimeFlags(['--cdp-port=nope']).cdpPort).toBe(DEFAULT_CLI_CDP_PORT);
  });

  it('parses electron mode with a positional app path', () => {
    expect(parseCliRuntimeFlags(['--electron', '/Applications/Slack.app'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_ELECTRON_ATTACH_CDP_PORT,
      electron: true,
      electronApp: '/Applications/Slack.app',
      kill: false,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('keeps an explicit CDP port in electron mode', () => {
    expect(parseCliRuntimeFlags(['--electron', '--cdp-port=9444', '/Applications/Slack.app'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: 9444,
      electron: true,
      electronApp: '/Applications/Slack.app',
      kill: false,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses explicit electron app and kill flags', () => {
    expect(parseCliRuntimeFlags(['--electron-app=/Applications/Linear.app', '--kill'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_ELECTRON_ATTACH_CDP_PORT,
      electron: true,
      electronApp: '/Applications/Linear.app',
      kill: true,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('does not consume a following flag token as the electron app path', () => {
    expect(parseCliRuntimeFlags(['--electron-app', '--kill'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_ELECTRON_ATTACH_CDP_PORT,
      electron: true,
      electronApp: null,
      kill: true,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses --log-level flag', () => {
    expect(parseCliRuntimeFlags(['--log-level=debug']).logLevel).toBe('debug');
    expect(parseCliRuntimeFlags(['--log-level=error']).logLevel).toBe('error');
    expect(parseCliRuntimeFlags(['--log-level=warn']).logLevel).toBe('warn');
  });

  it('ignores invalid log levels', () => {
    expect(parseCliRuntimeFlags(['--log-level=verbose']).logLevel).toBe('info');
  });

  it('parses --log-dir flag', () => {
    expect(parseCliRuntimeFlags(['--log-dir=/tmp/my-logs']).logDir).toBe('/tmp/my-logs');
  });

  it('sets logDir to null for empty --log-dir', () => {
    expect(parseCliRuntimeFlags(['--log-dir=']).logDir).toBe(null);
  });
});