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
    });
  });
});