import { describe, expect, it } from 'vitest';

import { findMatchingElectronAppPids } from './electron-controller.js';

describe('findMatchingElectronAppPids', () => {
  it('excludes the current CLI pid while keeping other matching Electron app pids', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 111,
            commandLine: 'node dist/cli/index.js --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 222,
            commandLine: '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 333,
            commandLine: '/Applications/Linear.app/Contents/MacOS/Linear',
            executablePath: '/Applications/Linear.app/Contents/MacOS/Linear',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        111,
      ),
    ).toEqual([222]);
  });
});