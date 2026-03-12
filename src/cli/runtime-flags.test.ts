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
    });
  });

  it('parses --lead=<url> syntax', () => {
    expect(parseCliRuntimeFlags(['--lead=https://tray.example.com'])).toMatchObject({
      lead: true,
      leadWorkerBaseUrl: 'https://tray.example.com',
    });
  });
});