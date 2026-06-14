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
import type { CmdResult, PlaywrightHandler, PlaywrightHandlerCtx } from '../types.js';

const log = createLogger('playwright-teleport');

/** `teleport --list`: enumerate connected follower runtimes. */
function teleportList(): CmdResult {
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

/** `teleport --off`: disarm the watcher on the given tab. */
function teleportOff({ state, flags }: PlaywrightHandlerCtx): CmdResult {
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

/** Compile the --start/--return regexes, returning an error message on failure. */
function compileTeleportPatterns(
  startStr: string,
  returnStr: string
): { startPattern: RegExp; returnPattern: RegExp } | { error: string } {
  let startPattern: RegExp;
  let returnPattern: RegExp;
  try {
    startPattern = new RegExp(startStr);
  } catch {
    return { error: `Invalid regex for --start: ${startStr}\n` };
  }
  try {
    returnPattern = new RegExp(returnStr);
  } catch {
    return { error: `Invalid regex for --return: ${returnStr}\n` };
  }
  return { startPattern, returnPattern };
}

/**
 * Re-gate an explicit `--runtime <id>`: a cherry host can never serve
 * `Network.*` and must not be a teleport target. Returns an error message when
 * the runtime is a cherry host, else null. Mirrors the auto-select exclusion.
 */
function cherryRuntimeRejection(runtimeId: string): string | null {
  const followers = resolveConnectedFollowers()?.() ?? [];
  const match = followers.find((f) => f.runtimeId === runtimeId);
  if (match?.runtime === CHERRY_RUNTIME_TAG) {
    return `teleport: runtime ${runtimeId} is a cherry host and cannot serve a cookie teleport (no Network.* access)\n`;
  }
  return null;
}

/** `teleport --start <regex> --return <regex> [...]`: arm a watcher on a tab. */
async function teleportArm({ browser, state, flags }: PlaywrightHandlerCtx): Promise<CmdResult> {
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
  const patterns = compileTeleportPatterns(startPatternStr, returnPatternStr);
  if ('error' in patterns) {
    return { stdout: '', stderr: patterns.error, exitCode: 1 };
  }
  const timeoutSec = flags['timeout'] ? parseInt(flags['timeout'], 10) : 300;
  if (isNaN(timeoutSec) || timeoutSec <= 0) {
    return { stdout: '', stderr: '--timeout must be a positive number\n', exitCode: 1 };
  }
  const runtimeId = flags['runtime'];
  if (runtimeId) {
    const rejection = cherryRuntimeRejection(runtimeId);
    if (rejection) {
      return { stdout: '', stderr: rejection, exitCode: 1 };
    }
  }

  // Disarm any existing watcher on this tab
  const existingWatcher = state.teleportWatchers.get(tab.targetId);
  if (existingWatcher) {
    log.info('Disarming existing teleport watcher before re-arming', { targetId: tab.targetId });
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
    patterns.startPattern,
    patterns.returnPattern,
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
}

export const teleportHandler: PlaywrightHandler = async (ctx) => {
  if (ctx.flags['list'] === 'true') return teleportList();
  if (ctx.flags['off'] === 'true') return teleportOff(ctx);
  return teleportArm(ctx);
};
