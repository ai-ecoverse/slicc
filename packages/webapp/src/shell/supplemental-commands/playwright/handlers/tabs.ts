import { createLogger } from '../../../../base/logger.js';
import { fetchAndDiscover } from '../discover.js';
import { getActionablePages, resolveAppTabId } from '../snapshot.js';
import { requireTab } from '../state.js';
import { armTeleportWatcher, cleanupTeleportWatcher } from '../teleport.js';
import type { PlaywrightHandler, PlaywrightHandlerCtx } from '../types.js';

const log = createLogger('playwright');

const MOBILE_VIEWPORT = { width: 412, height: 915, deviceScaleFactor: 2.625 };

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

function armTeleportFromFlags(
  browser: PlaywrightHandlerCtx['browser'],
  state: PlaywrightHandlerCtx['state'],
  flags: Record<string, string>,
  url: string,
  targetId: string
): { stdout: string; stderr: string; exitCode: number } | null {
  const teleStartStr = flags['teleport-start'];
  const teleReturnStr = flags['teleport-return'];
  if (!teleStartStr || !teleReturnStr) return null;

  log.info('Arming teleport via open/tab-new flags');
  log.debug('Arming teleport via open/tab-new flags details', {
    targetId,
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
  const existingWatcher = state.teleportWatchers.get(targetId);
  if (existingWatcher) {
    cleanupTeleportWatcher(existingWatcher);
    state.teleportWatchers.delete(targetId);
  }
  armTeleportWatcher(
    browser,
    state,
    teleStart,
    teleReturn,
    teleTimeout * 1000,
    flags['teleport-runtime'],
    url,
    targetId
  );
  return null;
}

export const openHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
  onTab,
}) => {
  const url = positional[0] || 'about:blank';
  const runtimeFlag = flags['runtime'];
  const mobile = flags['mobile'] === 'true';
  await resolveAppTabId(browser, state);

  const initialUrl = mobile ? 'about:blank' : url;
  let targetId: string;
  if (runtimeFlag) {
    targetId = await browser.createRemotePage(runtimeFlag, initialUrl);
  } else {
    targetId = await browser.createPage(initialUrl);
  }

  if (mobile) {
    await onTab(targetId, async (page) => {
      await page.setViewportOverride(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height, {
        deviceScaleFactor: MOBILE_VIEWPORT.deviceScaleFactor,
        mobile: true,
        userAgent: MOBILE_USER_AGENT,
      });
      if (url !== 'about:blank') await page.navigate(url);
    });
  }

  if (flags['foreground'] === 'true' || flags['fg'] === 'true') {
    try {
      await onTab(targetId, (page) => page.bringToFront());
    } catch (err) {
      log.debug('open/tab-new --foreground bringToFront failed', {
        targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const teleportError = armTeleportFromFlags(browser, state, flags, url, targetId);
  if (teleportError) return teleportError;

  if (flags['discover'] === 'true') {
    const discoveryResult = await fetchAndDiscover(url, { discover: true, fs });

    const { browseShWarning, ...payloadFields } = discoveryResult;
    const payload = {
      action: 'open',
      targetId,

      source: 'auxiliary-fetch' as const,
      ...payloadFields,
    };
    return {
      stdout: JSON.stringify(payload, null, 2) + '\n',
      stderr: browseShWarning ? `${browseShWarning}\n` : '',
      exitCode: 0,
    };
  }

  return {
    stdout: `Opened ${url} in new tab [targetId: ${targetId}]\n`,
    stderr: '',
    exitCode: 0,
  };
};

export const tabListHandler: PlaywrightHandler = async ({ browser, state }) => {
  const pages = await getActionablePages(browser, state);
  if (pages.length === 0) {
    return { stdout: 'No tabs open\n', stderr: '', exitCode: 0 };
  }
  const lines = pages.map((p) => {
    const isActive = !!p.active;
    const isRemote = p.targetId.includes(':');
    const activeMarker = isActive ? ' (active)' : '';
    const remoteSuffix = isRemote
      ? ` [remote:${p.targetId.substring(0, p.targetId.indexOf(':'))}]`
      : '';
    return `[${p.targetId}] ${p.url} "${p.title}"${activeMarker}${remoteSuffix}`;
  });
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
};

export const tabCloseHandler: PlaywrightHandler = async ({ browser, state, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  await browser.closePage(tab.targetId);
  state.snapshots.delete(tab.targetId);
  state.teleportWatchers.delete(tab.targetId);
  state.consoleMessages.delete(tab.targetId);
  const consoleCleanup = state.consoleCleanup.get(tab.targetId);
  if (consoleCleanup) {
    consoleCleanup();
    state.consoleCleanup.delete(tab.targetId);
  }
  state.networkRequests.delete(tab.targetId);
  const networkCleanup = state.networkCleanup.get(tab.targetId);
  if (networkCleanup) {
    networkCleanup();
    state.networkCleanup.delete(tab.targetId);
  }
  const routeCleanup = state.routeCleanup.get(tab.targetId);
  if (routeCleanup) {
    routeCleanup();
    state.routeCleanup.delete(tab.targetId);
  }
  state.routes.delete(tab.targetId);
  state.lastMousePosition.delete(tab.targetId);
  return { stdout: `Closed tab ${tab.targetId}\n`, stderr: '', exitCode: 0 };
};

export const tabSelectHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'tab-select requires a tab index\n', exitCode: 1 };
  }
  const indexStr = positional[0];
  if (!/^[0-9]+$/.test(indexStr)) {
    return { stdout: '', stderr: 'tab-select index must be a positive integer\n', exitCode: 1 };
  }
  const index = parseInt(indexStr, 10);
  if (index < 1) {
    return { stdout: '', stderr: 'tab-select index must be a positive integer\n', exitCode: 1 };
  }
  const pages = await getActionablePages(browser, state);
  if (index > pages.length) {
    return {
      stdout: '',
      stderr: `tab-select index ${index} out of range (${pages.length} tab${pages.length === 1 ? '' : 's'} open)\n`,
      exitCode: 1,
    };
  }
  const targetId = pages[index - 1].targetId;

  await onTab(targetId, (page) => page.bringToFront());
  return { stdout: `Selected tab ${index} [targetId: ${targetId}]\n`, stderr: '', exitCode: 0 };
};

export const resizeHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'resize requires <width> <height>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const w = parseInt(positional[0], 10);
  const h = parseInt(positional[1], 10);
  if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) {
    return {
      stdout: '',
      stderr: 'resize requires positive integer width and height\n',
      exitCode: 1,
    };
  }

  await onTab(tab.targetId, (page) => page.setViewportOverride(w, h));
  state.snapshots.delete(tab.targetId);
  return { stdout: `Resized viewport to ${w}x${h}\n`, stderr: '', exitCode: 0 };
};
