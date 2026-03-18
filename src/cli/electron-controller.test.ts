import { describe, expect, it } from 'vitest';

import { findMatchingElectronAppPids } from './electron-controller.js';

describe('findMatchingElectronAppPids', () => {
  it('matches Slack process where app path is the executable', () => {
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

  it('does not match node/npx/tsx ancestor processes that have the app path as a CLI argument', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            // npm/npx parent — has app path as argument, not as the executable
            pid: 100,
            commandLine: 'node /usr/local/bin/npx tsx src/cli/index.ts --electron --kill /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            // Current tsx process — also has app path as argument
            pid: 111,
            commandLine: 'node dist/cli/index.js --electron --kill /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            // Actual Slack process — app path is the executable
            pid: 222,
            commandLine: '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        111,
      ),
    ).toEqual([222]);
  });
});