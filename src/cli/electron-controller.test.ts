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

  it('excludes shell wrapper processes that mention the app path as an argument', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 100,
            commandLine: '/bin/zsh -c npx tsx src/cli/index.ts --electron /Applications/Slack.app --kill',
            executablePath: null,
          },
          {
            pid: 111,
            commandLine: 'npx tsx src/cli/index.ts --dev --electron /Applications/Slack.app --kill',
            executablePath: null,
          },
          {
            pid: 222,
            commandLine: '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: null,
          },
          {
            pid: 444,
            commandLine: '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper --type=renderer',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        111,
      ),
    ).toEqual([222, 444]);
  });
});