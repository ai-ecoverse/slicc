import { describe, expect, it } from 'vitest';

import { findMatchingElectronAppPids } from '../src/electron-controller.js';

describe('findMatchingElectronAppPids', () => {
  it('excludes the current CLI pid while keeping other matching Electron app pids', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 111,
            commandLine: 'node dist/node-server/index.js --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 222,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 333,
            commandLine: '/Applications/Linear.app/Contents/MacOS/Linear',
            executablePath: '/Applications/Linear.app/Contents/MacOS/Linear',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        111
      )
    ).toEqual([222]);
  });

  it('excludes all Node.js tool-chain processes that have the app path as a CLI argument', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 100,
            commandLine: 'npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 101,
            commandLine:
              'npx tsx packages/node-server/src/index.ts --dev --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 102,
            commandLine:
              'tsx packages/node-server/src/index.ts --dev --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 103,
            commandLine: 'node dist/node-server/index.js --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 200,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 201,
            commandLine:
              '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper --type=renderer',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        103
      )
    ).toEqual([200, 201]);
  });

  it('matches via executablePath when commandLine has no app path', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 111,
            commandLine: '/Applications/Slack.app/Contents/Frameworks/Slack Helper --type=gpu',
            executablePath: '/Applications/Slack.app/Contents/Frameworks/Slack Helper',
          },
          {
            pid: 222,
            commandLine: '',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 333,
            commandLine: 'node server.js',
            executablePath: '/usr/local/bin/node',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([111, 222]);
  });

  it('handles case-insensitive Node.js executable names', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 50,
            commandLine: 'Node dist/node-server/index.js --electron /Applications/Slack.app',
            executablePath: null,
          },
          {
            pid: 51,
            commandLine:
              'NPX tsx packages/node-server/src/index.ts --electron /Applications/Slack.app',
            executablePath: null,
          },
          {
            pid: 60,
            commandLine: '/Applications/Slack.app/Contents/MacOS/Slack',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app'],
        999
      )
    ).toEqual([60]);
  });

  it('excludes full-path node executables (e.g. Homebrew-installed node)', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 400,
            commandLine:
              '/opt/homebrew/Cellar/node/25.2.1/bin/node --require /opt/homebrew/lib/node_modules/npm/node_modules/dotenv/config --electron /Applications/Slack.app',
            executablePath: '/opt/homebrew/Cellar/node/25.2.1/bin/node',
          },
          {
            pid: 401,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([401]);
  });

  it('excludes the `open` command used to launch macOS .app bundles', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 500,
            commandLine:
              'open -n -a /Applications/Slack.app -W --args --remote-debugging-port=9223',
            executablePath: '/usr/bin/open',
          },
          {
            pid: 501,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([501]);
  });

  it('excludes shell wrapper processes that have the app path in their arguments', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 600,
            commandLine:
              'zsh -c -l source /dev/stdin npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/bin/zsh',
          },
          {
            pid: 601,
            commandLine: 'bash -c npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/bin/bash',
          },
          {
            pid: 602,
            commandLine: 'timeout 30 npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/usr/bin/timeout',
          },
          {
            pid: 603,
            commandLine: 'env npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/usr/bin/env',
          },
          {
            pid: 604,
            commandLine: '/bin/sh -c npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/bin/sh',
          },
          {
            pid: 605,
            commandLine: 'sudo npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/sudo',
          },
          {
            pid: 606,
            commandLine: 'caffeinate -i npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/caffeinate',
          },
          {
            pid: 700,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([700]);
  });

  it('excludes full-path shell wrappers (e.g. /usr/local/bin/bash)', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 610,
            commandLine: '/usr/local/bin/bash -c npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/local/bin/bash',
          },
          {
            pid: 611,
            commandLine: '/usr/bin/env npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/env',
          },
          {
            pid: 612,
            commandLine: '/usr/bin/timeout 30 npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/timeout',
          },
          {
            pid: 700,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([700]);
  });

  it('does not filter out non-Node processes that happen to have "node" in their path', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 70,
            commandLine:
              '/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/crashpad_handler --monitor-self',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app'],
        999
      )
    ).toEqual([70]);
  });
});
