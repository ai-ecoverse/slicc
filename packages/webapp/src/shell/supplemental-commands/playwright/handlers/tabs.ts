/**
 * Tab lifecycle subcommands: open/tab-new, tab-list, tab-close/close, resize.
 */

import { createLogger } from '../../../../core/logger.js';
import { fetchAndDiscover } from '../discover.js';
import { getActionablePages, resolveAppTabId } from '../snapshot.js';
import { requireTab } from '../state.js';
import { armTeleportWatcher, cleanupTeleportWatcher } from '../teleport.js';
import type { PlaywrightHandler } from '../types.js';

const log = createLogger('playwright');

export const openHandler: PlaywrightHandler = async ({ browser, fs, state, positional, flags }) => {
  const url = positional[0] || 'about:blank';
  const runtimeFlag = flags['runtime'];
  await resolveAppTabId(browser, state);

  let targetId: string;
  if (runtimeFlag) {
    // Open a tab on a remote runtime within the tray
    targetId = await browser.createRemotePage(runtimeFlag, url);
  } else {
    targetId = await browser.createPage(url);
  }

  // Arm teleport watcher if --teleport-start and --teleport-return are set
  const teleStartStr = flags['teleport-start'];
  const teleReturnStr = flags['teleport-return'];
  if (teleStartStr && teleReturnStr) {
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
  }

  // --discover triggers an auxiliary proxied fetch on the URL so we
  // can parse RFC 8288 Link headers and (optionally) run P0 discovery.
  // Default off — the navigation itself doesn't carry headers we can
  // see from CDP without extra plumbing, and the extra fetch is
  // multi-request overhead the caller has to opt into.
  if (flags['discover'] === 'true') {
    const discoveryResult = await fetchAndDiscover(url, { discover: true, fs });
    // Strip browseShWarning before serializing — it's a stderr-only
    // signal, not part of the JSON payload scoops parse.
    const { browseShWarning, ...payloadFields } = discoveryResult;
    const payload = {
      action: 'open',
      targetId,
      // Marks `links[]`/`handoff`/`discovery` as coming from an
      // auxiliary proxied fetch separate from the CDP navigation —
      // may differ in auth state, cookies, redirects.
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
  return { stdout: `Closed tab ${tab.targetId}\n`, stderr: '', exitCode: 0 };
};

export const tabSelectHandler: PlaywrightHandler = async ({ browser, state, positional }) => {
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
  await browser.withTab(targetId, async () => {
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send('Page.bringToFront', {}, sessionId!);
  });
  return { stdout: `Selected tab ${index} [targetId: ${targetId}]\n`, stderr: '', exitCode: 0 };
};

export const resizeHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
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
  await browser.withTab(tab.targetId, async () => {
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId!
    );
  });
  state.snapshots.delete(tab.targetId);
  return { stdout: `Resized viewport to ${w}x${h}\n`, stderr: '', exitCode: 0 };
};
