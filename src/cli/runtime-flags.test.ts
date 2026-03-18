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
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
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
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
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
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
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
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
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
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
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
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses lead mode with an explicit worker base URL', () => {
    expect(parseCliRuntimeFlags(['--lead', 'https://tray.example.com/base'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_CLI_CDP_PORT,
      electron: false,
      electronApp: null,
      kill: false,
      lead: true,
      leadWorkerBaseUrl: 'https://tray.example.com/base',
      profile: null,
      join: false,
      joinUrl: null,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('supports --lead without consuming unrelated positional arguments', () => {
    expect(parseCliRuntimeFlags(['--lead', '--electron', '/Applications/Slack.app'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_ELECTRON_ATTACH_CDP_PORT,
      electron: true,
      electronApp: '/Applications/Slack.app',
      kill: false,
      lead: true,
      leadWorkerBaseUrl: null,
      profile: null,
      join: false,
      joinUrl: null,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses --lead=<url> syntax', () => {
    expect(parseCliRuntimeFlags(['--lead=https://tray.example.com'])).toMatchObject({
      lead: true,
      leadWorkerBaseUrl: 'https://tray.example.com',
      profile: null,
      join: false,
      joinUrl: null,
    });
  });

  it('parses a named QA profile', () => {
    expect(parseCliRuntimeFlags(['--profile=leader'])).toMatchObject({
      profile: 'leader',
    });
  });

  it('does not consume another flag token as the profile name', () => {
    expect(parseCliRuntimeFlags(['--profile', '--lead'])).toMatchObject({
      profile: null,
      lead: true,
    });
  });

  it('parses join mode with an explicit join URL', () => {
    expect(parseCliRuntimeFlags(['--join', 'https://tray.example.com/base/join/tray-123.secret'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_CLI_CDP_PORT,
      electron: false,
      electronApp: null,
      kill: false,
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: true,
      joinUrl: 'https://tray.example.com/base/join/tray-123.secret',
      logLevel: 'info',
      logDir: null,
    });
  });

  it('supports --join without consuming unrelated positional arguments', () => {
    expect(parseCliRuntimeFlags(['--join', '--electron', '/Applications/Slack.app'])).toEqual({
      dev: false,
      serveOnly: false,
      cdpPort: DEFAULT_ELECTRON_ATTACH_CDP_PORT,
      electron: true,
      electronApp: '/Applications/Slack.app',
      kill: false,
      lead: false,
      leadWorkerBaseUrl: null,
      profile: null,
      join: true,
      joinUrl: null,
      logLevel: 'info',
      logDir: null,
    });
  });

  it('parses --join=<url> syntax', () => {
    expect(parseCliRuntimeFlags(['--join=https://tray.example.com/base/join/tray-123.secret'])).toMatchObject({
      join: true,
      joinUrl: 'https://tray.example.com/base/join/tray-123.secret',
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