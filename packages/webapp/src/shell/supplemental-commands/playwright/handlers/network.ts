/**
 * Network subcommands: network-state-set.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const networkStateSetHandler: PlaywrightHandler = async ({ browser, flags, positional }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const stateArg = positional[0];
  if (stateArg !== 'online' && stateArg !== 'offline') {
    return {
      stdout: '',
      stderr: 'network-state-set requires "online" or "offline"\n',
      exitCode: 1,
    };
  }
  await browser.withTab(tab.targetId, async () => {
    await browser.sendCDP('Network.enable', {});
    await browser.sendCDP('Network.emulateNetworkConditions', {
      offline: stateArg === 'offline',
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });
  return { stdout: `Network set to ${stateArg}\n`, stderr: '', exitCode: 0 };
};
