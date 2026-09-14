import { createLogger } from '../../../../base/logger.js';
import { fetchAndDiscover } from '../discover.js';
import { requireTab } from '../state.js';
import { armTeleportWatcher, cleanupTeleportWatcher } from '../teleport.js';
import type { PlaywrightHandler } from '../types.js';

const log = createLogger('playwright');

export const gotoHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'goto requires a URL\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await onTab(tab.targetId, (page) => page.navigate(positional[0]));
  state.snapshots.delete(tab.targetId);

  const teleStartStr = flags['teleport-start'];
  const teleReturnStr = flags['teleport-return'];
  if (teleStartStr && teleReturnStr) {
    log.info('Arming teleport via goto/navigate flags');
    log.debug('Arming teleport via goto/navigate flags details', {
      targetId: tab.targetId,
      startPattern: teleStartStr,
      returnPattern: teleReturnStr,
    });
    let teleStart: RegExp;
    let teleReturn: RegExp;
    try {
      teleStart = new RegExp(teleStartStr);
    } catch {
      return {
        stdout: '',
        stderr: `Invalid regex for --teleport-start: ${teleStartStr}\n`,
        exitCode: 1,
      };
    }
    try {
      teleReturn = new RegExp(teleReturnStr);
    } catch {
      return {
        stdout: '',
        stderr: `Invalid regex for --teleport-return: ${teleReturnStr}\n`,
        exitCode: 1,
      };
    }
    const teleTimeout = flags['timeout'] ? parseInt(flags['timeout'], 10) : 300;
    const existingWatcher = state.teleportWatchers.get(tab.targetId);
    if (existingWatcher) {
      cleanupTeleportWatcher(existingWatcher);
      state.teleportWatchers.delete(tab.targetId);
    }
    armTeleportWatcher(
      browser,
      state,
      teleStart,
      teleReturn,
      teleTimeout * 1000,
      flags['teleport-runtime'],
      positional[0],
      tab.targetId
    );
  }

  if (flags['discover'] === 'true') {
    const discoveryResult = await fetchAndDiscover(positional[0], {
      discover: true,
      fs,
    });

    const { browseShWarning, ...payloadFields } = discoveryResult;
    const payload = {
      action: 'navigate',
      targetId: tab.targetId,

      source: 'auxiliary-fetch' as const,
      ...payloadFields,
    };
    return {
      stdout: JSON.stringify(payload, null, 2) + '\n',
      stderr: browseShWarning ? `${browseShWarning}\n` : '',
      exitCode: 0,
    };
  }

  return { stdout: `Navigated to ${positional[0]}\n`, stderr: '', exitCode: 0 };
};

export const goBackHandler: PlaywrightHandler = async ({ browser, state, flags, onTab }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await onTab(tab.targetId, async (page) => {
    await page.evaluate('history.back()');
  });
  state.snapshots.delete(tab.targetId);
  return { stdout: 'Navigated back\n', stderr: '', exitCode: 0 };
};

export const goForwardHandler: PlaywrightHandler = async ({ browser, state, flags, onTab }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await onTab(tab.targetId, async (page) => {
    await page.evaluate('history.forward()');
  });
  state.snapshots.delete(tab.targetId);
  return { stdout: 'Navigated forward\n', stderr: '', exitCode: 0 };
};

export const reloadHandler: PlaywrightHandler = async ({ browser, flags, onTab }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await onTab(tab.targetId, async (page) => {
    await page.send('Page.reload');
  });
  return { stdout: 'Reloaded\n', stderr: '', exitCode: 0 };
};
