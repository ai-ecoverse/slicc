/**
 * Teleport subcommand dispatcher: --list, --off, and arming. The watcher
 * state machine itself lives in `../teleport.ts`.
 */

import { createLogger } from '../../../../core/logger.js';
import { CHERRY_RUNTIME_TAG } from '../../../../scoops/tray-sync-protocol.js';
import { requireTab } from '../state.js';
import {
  armTeleportWatcher,
  cleanupTeleportWatcher,
  resolveConnectedFollowers,
} from '../teleport.js';
import type { PlaywrightHandler } from '../types.js';

const log = createLogger('playwright-teleport');

export const teleportHandler: PlaywrightHandler = async ({ browser, state, flags }) => {
  // --list: list available follower runtimes
  if (flags['list'] === 'true') {
    log.info('Listing available follower runtimes');
    const getFollowers = resolveConnectedFollowers();
    if (!getFollowers) {
      return { stdout: '', stderr: 'teleport: not connected to a tray\n', exitCode: 1 };
    }
    const followers = getFollowers();
    if (followers.length === 0) {
      return { stdout: 'No followers connected to the tray.\n', stderr: '', exitCode: 0 };
    }
    const lines = ['Available runtimes for teleport:'];
    for (const f of followers) {
      const parts = [f.runtimeId];
      if (f.floatType) parts.push(`[${f.floatType}]`);
      if (f.runtime) parts.push(`(${f.runtime})`);
      if (f.lastActivity) {
        const ago = Math.round((Date.now() - f.lastActivity) / 1000);
        parts.push(`active ${ago}s ago`);
      }
      lines.push(`  ${parts.join(' ')}`);
    }
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  // --off: disarm (requires --tab)
  if (flags['off'] === 'true') {
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    log.info('Disarming teleport watcher via --off', { targetId: tab.targetId });
    const watcher = state.teleportWatchers.get(tab.targetId);
    if (watcher) {
      cleanupTeleportWatcher(watcher);
      state.teleportWatchers.delete(tab.targetId);
    }
    return { stdout: 'Teleport watcher disarmed\n', stderr: '', exitCode: 0 };
  }

  // Arm teleport watcher (requires --tab)
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }

  const startPatternStr = flags['start'] || flags['teleport-start'];
  const returnPatternStr = flags['return'] || flags['teleport-return'];
  if (!startPatternStr || !returnPatternStr) {
    return {
      stdout: '',
      stderr: 'teleport requires --start <regex> and --return <regex>\n',
      exitCode: 1,
    };
  }
  let startPattern: RegExp;
  let returnPattern: RegExp;
  try {
    startPattern = new RegExp(startPatternStr);
  } catch {
    return {
      stdout: '',
      stderr: `Invalid regex for --start: ${startPatternStr}\n`,
      exitCode: 1,
    };
  }
  try {
    returnPattern = new RegExp(returnPatternStr);
  } catch {
    return {
      stdout: '',
      stderr: `Invalid regex for --return: ${returnPatternStr}\n`,
      exitCode: 1,
    };
  }
  const timeoutSec = flags['timeout'] ? parseInt(flags['timeout'], 10) : 300;
  if (isNaN(timeoutSec) || timeoutSec <= 0) {
    return { stdout: '', stderr: '--timeout must be a positive number\n', exitCode: 1 };
  }
  const runtimeId = flags['runtime'];

  // Explicit --runtime bypasses getBestFollowerForTeleport's auto-select
  // exclusion, so re-gate it here against the same connected-follower
  // surface: a cherry host can never serve `Network.*` and must not be a
  // teleport target. Fail closed with a clear error rather than letting
  // the leader hit a -32601 mid-flow.
  if (runtimeId) {
    const followers = resolveConnectedFollowers()?.() ?? [];
    const match = followers.find((f) => f.runtimeId === runtimeId);
    if (match?.runtime === CHERRY_RUNTIME_TAG) {
      return {
        stdout: '',
        stderr: `teleport: runtime ${runtimeId} is a cherry host and cannot serve a cookie teleport (no Network.* access)\n`,
        exitCode: 1,
      };
    }
  }

  // Disarm any existing watcher on this tab
  const existingWatcher = state.teleportWatchers.get(tab.targetId);
  if (existingWatcher) {
    log.info('Disarming existing teleport watcher before re-arming', {
      targetId: tab.targetId,
    });
    cleanupTeleportWatcher(existingWatcher);
    state.teleportWatchers.delete(tab.targetId);
  }

  // Capture the leader's current URL before the SSO redirect for post-teleport navigation
  let leaderUrl: string | undefined;
  try {
    await browser.attachToPage(tab.targetId);
    const raw = await browser.evaluate('window.location.href');
    leaderUrl = typeof raw === 'string' ? raw : String(raw);
  } catch {
    /* best-effort */
  }

  log.info('Arming teleport via explicit subcommand', {
    targetId: tab.targetId,
    timeoutSec,
    runtimeSelection: runtimeId ? 'explicit' : 'auto',
  });
  log.debug('Arming teleport via explicit subcommand details', {
    targetId: tab.targetId,
    startPattern: startPatternStr,
    returnPattern: returnPatternStr,
    timeoutSec,
    runtimeId: runtimeId ?? 'auto',
    leaderUrl,
  });
  armTeleportWatcher(
    browser,
    state,
    startPattern,
    returnPattern,
    timeoutSec * 1000,
    runtimeId,
    leaderUrl,
    tab.targetId
  );
  return {
    stdout: `Teleport armed on tab ${tab.targetId}. Will trigger when URL matches ${startPatternStr}\n`,
    stderr: '',
    exitCode: 0,
  };
};
