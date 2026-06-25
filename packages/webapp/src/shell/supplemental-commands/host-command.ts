import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  type FollowerTrayRuntimeStatus,
  getFollowerStatusWithFallback,
  getFollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import { joinTray as defaultJoinTray } from '../../scoops/tray-join.js';
import {
  getLeaderStatusWithFallback,
  type LeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import { leaveTray as defaultLeaveTray, type TrayLeaveResult } from '../../scoops/tray-leave.js';
import {
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrlValue,
} from '../../scoops/tray-runtime-config.js';

export interface ConnectedFollowerInfo {
  runtimeId: string;
  runtime?: string;
  connectedAt?: string;
}

/**
 * Module-level callback for retrieving connected followers.
 * Set by main.ts once the LeaderSyncManager is created.
 */
let connectedFollowersGetter: (() => ConnectedFollowerInfo[]) | null = null;

export function setConnectedFollowersGetter(getter: (() => ConnectedFollowerInfo[]) | null): void {
  connectedFollowersGetter = getter;
}

export function getConnectedFollowers(): ConnectedFollowerInfo[] {
  return connectedFollowersGetter?.() ?? [];
}

/**
 * Module-level callback for resetting the tray session.
 * Set by main.ts once the LeaderTrayManager is created.
 */
let trayResetter: (() => Promise<LeaderTrayRuntimeStatus>) | null = null;

export function setTrayResetter(resetter: (() => Promise<LeaderTrayRuntimeStatus>) | null): void {
  trayResetter = resetter;
}

export function getTrayResetter(): (() => Promise<LeaderTrayRuntimeStatus>) | undefined {
  return trayResetter ?? undefined;
}

// localStorage key written by page-side subscriptions in main.ts and
// propagated to the kernel worker's Map-backed shim via installPageStorageSync.
// The leader-status counterpart lives in `tray-leader.ts` next to the
// shared `getLeaderStatusWithFallback` helper.
const LEADER_FOLLOWERS_STORAGE_KEY = 'slicc.leaderTrayFollowers';

/**
 * Fallback-aware connected-follower list, exported for the `cherry-emit`
 * command's default registry. Unlike `getConnectedFollowers` (page-thread
 * getter only), this also reads the `slicc.leaderTrayFollowers` localStorage
 * shim that `main.ts` keeps current, so the kernel-worker shell sees the
 * leader's followers too.
 */
export function getConnectedFollowersWithFallback(): ConnectedFollowerInfo[] {
  return getFollowersWithFallback();
}

// Same reason: the module-level getter is only set on the page thread.
// Fall back to the localStorage shim value written by writeConnectedFollowersToShim.
function getFollowersWithFallback(): ConnectedFollowerInfo[] {
  if (connectedFollowersGetter) return connectedFollowersGetter();
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_FOLLOWERS_STORAGE_KEY
    );
    if (stored) return JSON.parse(stored) as ConnectedFollowerInfo[];
  } catch {
    // ignore parse errors
  }
  return [];
}

/**
 * Mirror the leader's connected-follower list into the
 * `slicc.leaderTrayFollowers` shim so the standalone kernel-worker `host`
 * command — which has no live `connectedFollowersGetter` — sees it via
 * `getFollowersWithFallback`. The page calls this on every follower-count
 * change, on boot (to clear a stale value), and when the leader stops;
 * `installPageStorageSync` forwards the write into the worker's Map-backed
 * shim. Symmetric with the `slicc.leaderTrayStatus` mirror written in
 * `wc-tray.ts`. Best-effort: a missing `localStorage` (Node/tests without an
 * override) or a quota/serialization error is swallowed.
 */
export function writeConnectedFollowersToShim(
  followers: ConnectedFollowerInfo[],
  storage: Pick<Storage, 'setItem'> | undefined = (globalThis as { localStorage?: Storage })
    .localStorage
): void {
  try {
    storage?.setItem(LEADER_FOLLOWERS_STORAGE_KEY, JSON.stringify(followers));
  } catch {
    // best-effort mirror — ignore quota / serialization failures
  }
}

// When `host reset` runs from the kernel-worker's terminal, the worker's
// module-level `trayResetter` is null (the page is the only side that
// calls `setTrayResetter`). Bridge to the page via panel-RPC so the
// `tray-reset` handler installed in `mainStandaloneWorker` can drive
// `pageLeaderTray.reset()`. Returns `undefined` when no panel-RPC client
// is published (e.g. in tests, or in extension mode where the offscreen
// document has its own DOM and doesn't need the bridge).
function buildPanelRpcResetter(): (() => Promise<LeaderTrayRuntimeStatus>) | undefined {
  const client = getPanelRpcClient();
  if (!client) return undefined;
  return async () => await client.call('tray-reset', undefined);
}

/** Re-exported for the test surface — same shape as panel-RPC `tray-leave`. */
export type { TrayLeaveResult } from '../../scoops/tray-leave.js';

export interface HostCommandOptions {
  getStatus?: () => LeaderTrayRuntimeStatus;
  getFollowerStatus?: () => FollowerTrayRuntimeStatus;
  getFollowers?: () => ConnectedFollowerInfo[];
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;
  /**
   * Drive a tray leave (or follower → leader role switch). Defaults to
   * the float-detecting helper in `scoops/tray-leave.ts`; tests inject a
   * fake. The return shape matches the panel-RPC `tray-leave` result so
   * the shell can surface a useful confirmation message.
   */
  leaveTray?: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<TrayLeaveResult>;
  /**
   * Start following a tray as a follower. Defaults to the float-detecting
   * `buildDefaultJoiner` (panel-RPC `tray-join` in the standalone worker;
   * the ambient `joinTray` helper in the extension offscreen / side panel
   * / standalone page). Tests inject a fake to assert the parsed join URL.
   */
  joinTray?: (opts: { joinUrl: string; requestId?: string }) => Promise<void>;
}

function hostHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `host - display or manage the current tray host status

Usage: host [join <join-url> | reset | leave [--leader <worker-url>]]

Shows the current tray state (leader or follower) and, when available, the join URL and connected followers.

Subcommands:
  join <join-url>             Follow another browser's tray as a follower (paste its https://…/join/<token> URL)
  reset                       Disconnect all followers and create a fresh tray session with a new join URL
  leave                       Leave the current tray (drops follower or stops leader; clears stored URLs)
  leave --leader <worker-url> Leave the current role and immediately become a leader on <worker-url>
`,
    stderr: '',
    exitCode: 0,
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h ago`;
  return `${hours}h ${remainingMinutes}m ago`;
}

export function formatLeaderOutput(
  status: LeaderTrayRuntimeStatus,
  followers: ConnectedFollowerInfo[]
): string {
  const lines = [`status: ${status.state}`];

  if (status.session) {
    lines.push(`join_url: ${status.session.joinUrl}`);
  } else {
    lines.push('join_url: unavailable');
  }

  if (status.error) {
    lines.push(`error: ${status.error}`);
  }

  // Only surface followers when there's an active tray session. The followers
  // shim persists across sessions, so without this gate a leftover entry would
  // be shown under an `inactive` leader as if it were still connected.
  if (status.session && followers.length > 0) {
    lines.push('followers:');
    for (const f of followers) {
      const parts = [f.runtimeId];
      if (f.runtime) {
        parts.push(`(${f.runtime})`);
      }
      if (f.connectedAt) {
        const ago = Math.round((Date.now() - new Date(f.connectedAt).getTime()) / 1000);
        parts.push(`connected ${formatDuration(ago)}`);
      }
      lines.push(`  - ${parts.join(' ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatFollowerOutput(status: FollowerTrayRuntimeStatus): string {
  const lines = [`status: follower (${status.state})`];

  if (status.joinUrl) {
    lines.push(`join_url: ${status.joinUrl}`);
  }
  if (status.state === 'connecting') {
    if (status.connectingSince != null) {
      const elapsedSec = Math.round((Date.now() - status.connectingSince) / 1000);
      lines.push(`connecting_for: ${formatDuration(elapsedSec).replace(' ago', '')}`);
    }
    if (status.attachAttempts > 0) {
      lines.push(`attach_attempts: ${status.attachAttempts}`);
    }
    if (status.lastAttachCode) {
      lines.push(`last_code: ${status.lastAttachCode}`);
    }
  }
  if (status.state === 'connected' && status.lastPingTime != null) {
    const ago = Math.round((Date.now() - status.lastPingTime) / 1000);
    lines.push(`last_ping: ${ago}s ago`);
  }
  if (status.state === 'reconnecting' && status.reconnectAttempts > 0) {
    lines.push(`reconnect_attempts: ${status.reconnectAttempts}`);
  }
  if (status.lastError) {
    lines.push(`last_error: ${status.lastError}`);
  }
  if (status.error) {
    lines.push(`error: ${status.error}`);
  }

  return `${lines.join('\n')}\n`;
}

export function createHostCommand(options: HostCommandOptions = {}): Command {
  const getStatus = options.getStatus ?? getLeaderStatusWithFallback;
  // Default to the fallback-aware reader so the standalone kernel-worker `host`
  // sees a page-side follower via the `slicc.followerTrayStatus` shim. Without
  // it the worker's module global is permanently inactive and `host` reports
  // `status: inactive` while the follower is connected (the b268 symptom).
  const getFollowerSt = options.getFollowerStatus ?? getFollowerStatusWithFallback;
  const getFollowers = options.getFollowers ?? getFollowersWithFallback;

  return defineCommand('host', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return hostHelp();
    }

    if (args[0] === 'reset') {
      // Resolution order for the resetter:
      //   1. options.resetTray — explicit override for tests / future callers.
      //   2. getTrayResetter() — page-thread path; the page sets this via
      //      setTrayResetter after starting pageLeaderTray.
      //   3. Panel-RPC `tray-reset` — worker-thread path. Standalone runs
      //      the host shell command inside the kernel worker, where the
      //      module-level trayResetter is null; bridge to the page so it
      //      can drive pageLeaderTray.reset(). Returns the new
      //      LeaderTrayRuntimeStatus.
      const resetter = options.resetTray ?? getTrayResetter() ?? buildPanelRpcResetter();
      return handleReset(getFollowerSt, getStatus, resetter);
    }

    if (args[0] === 'join') {
      // Parse `host join <join-url>`. Restores the follow-a-leader entry
      // point the WC migration dropped from the extension UI — the shell
      // is the only place an extension user can paste a join URL.
      const joiner = options.joinTray ?? buildDefaultJoiner();
      return handleJoin(args.slice(1), joiner);
    }

    if (args[0] === 'leave') {
      // Parse `host leave [--leader <worker-url>]`. Anything else after
      // `leave` is rejected so a typo doesn't silently leave the tray
      // without honoring the user's intended switch-to-leader argument.
      const leaver = options.leaveTray ?? buildDefaultLeaver();
      return handleLeave(args.slice(1), getStatus, getFollowerSt, leaver);
    }

    if (args.length > 0) {
      return {
        stdout: '',
        stderr: 'host: unsupported arguments\n',
        exitCode: 1,
      };
    }

    // Show follower status if follower is active (connecting, connected, or error)
    const followerStatus = getFollowerSt();
    if (followerStatus.state !== 'inactive') {
      return {
        stdout: formatFollowerOutput(followerStatus),
        stderr: '',
        exitCode: 0,
      };
    }

    return {
      stdout: formatLeaderOutput(getStatus(), getFollowers()),
      stderr: '',
      exitCode: 0,
    };
  });
}

/**
 * Build the default `host leave` driver. The shell runs in either the
 * standalone kernel worker (no DOM, talks to the page via panel-RPC) or
 * the extension offscreen document (has DOM + a `__slicc_setTrayRuntime`
 * hook on `globalThis`). When a panel-RPC client is available we use
 * it — the page returns the authoritative `TrayLeaveResult`. Without a
 * panel-RPC client we fall through to the ambient helper and synthesize
 * a result from local status snapshots (the offscreen path).
 *
 * Mirroring `buildPanelRpcResetter` above, the discriminator is
 * "is there a panel-RPC client published?" — NOT a `typeof window`
 * check. `isNodeRuntime()` returns true only under Node.js (vitest),
 * so it would silently skip the panel-RPC branch in production
 * standalone worker (`process.versions.node` is undefined there).
 */
function buildDefaultLeaver(): (opts: {
  workerBaseUrl: string | null;
  requestId?: string;
}) => Promise<TrayLeaveResult> {
  return async ({ workerBaseUrl, requestId }) => {
    const panelRpcClient = getPanelRpcClient();

    if (panelRpcClient) {
      return await panelRpcClient.call('tray-leave', { workerBaseUrl, requestId });
    }

    // Offscreen path. Snapshot the mode before the leave so we can
    // synthesize a `TrayLeaveResult` — the ambient `leaveTray()` helper
    // returns `void`. NOTE: this synthesis is best-effort: the offscreen
    // dispatches `__slicc_setTrayRuntime` which drives `syncTrayRuntime`,
    // and the underlying `activeHandle.leader.start()` is fire-and-forget
    // in `offscreen.ts`. So a `{kind: 'switched'}` result here reflects
    // the leave succeeded + the start was initiated — not that the new
    // leader actually came up. The user should check `host` to verify.
    const followerSt = getFollowerTrayRuntimeStatus();
    const leaderSt = getLeaderStatusWithFallback();
    const previousMode: 'leader' | 'follower' | 'inactive' =
      followerSt.state !== 'inactive'
        ? 'follower'
        : leaderSt.state !== 'inactive'
          ? 'leader'
          : 'inactive';

    await defaultLeaveTray({ workerBaseUrl, requestId });

    if (workerBaseUrl !== null) {
      return { kind: 'switched', previousMode, workerBaseUrl };
    }
    if (previousMode === 'inactive') {
      return { kind: 'noop' };
    }
    return { kind: 'left', previousMode };
  };
}

/**
 * Generate a correlation id for `host leave` runs so the page-side
 * dispatcher can match logs across rapid retries. Mirrors the
 * `tray-join` request-id format.
 */
function newLeaveRequestId(): string {
  return `host-leave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Correlation id for `host join` runs. Symmetric to `newLeaveRequestId`. */
function newJoinRequestId(): string {
  return `host-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the default `host join` driver. Symmetric to `buildDefaultLeaver`:
 * a published panel-RPC client (standalone kernel worker) routes through
 * the page-side `tray-join` op; otherwise the ambient `joinTray` helper
 * drives the extension offscreen hook / side-panel relay / standalone
 * page event directly.
 */
function buildDefaultJoiner(): (opts: { joinUrl: string; requestId?: string }) => Promise<void> {
  return async ({ joinUrl, requestId }) => {
    const panelRpcClient = getPanelRpcClient();
    if (panelRpcClient) {
      await panelRpcClient.call('tray-join', { joinUrl, requestId });
      return;
    }
    await defaultJoinTray(joinUrl, { requestId });
  };
}

async function handleJoin(
  args: string[],
  joinTrayImpl: (opts: { joinUrl: string; requestId?: string }) => Promise<void>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // `host join` takes exactly one positional (the join URL) and no flags.
  // Reject unknown flags / extra positionals explicitly — symmetric to
  // `handleLeave` — so a typo'd flag (`host join --typo <url>`) surfaces an
  // error instead of being silently dropped.
  let rawUrl: string | undefined;
  for (const arg of args) {
    if (arg.startsWith('-') || rawUrl !== undefined) {
      return {
        stdout: '',
        stderr: `host join: unexpected argument: ${arg}\n`,
        exitCode: 1,
      };
    }
    rawUrl = arg;
  }
  if (!rawUrl) {
    return {
      stdout: '',
      stderr: 'host join: missing join URL\nUsage: host join <join-url>\n',
      exitCode: 1,
    };
  }

  const parsed = parseTrayJoinUrlValue(rawUrl);
  if (!parsed) {
    return {
      stdout: '',
      stderr:
        `host join: invalid join URL: ${rawUrl}\n` +
        'Expected an https://…/join/<token> link from the leader’s "Copy tray join URL".\n',
      exitCode: 1,
    };
  }

  try {
    await joinTrayImpl({ joinUrl: parsed.joinUrl, requestId: newJoinRequestId() });
    return {
      stdout:
        `Joining tray as follower: ${parsed.joinUrl}\n` +
        'Run `host` to check connection status.\n',
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `host join: ${message}\n`, exitCode: 1 };
  }
}

async function handleLeave(
  args: string[],
  getLeaderStatus: () => LeaderTrayRuntimeStatus,
  getFollowerStatus: () => FollowerTrayRuntimeStatus,
  leaveTrayImpl: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<TrayLeaveResult>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let workerBaseUrl: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--leader' || arg === '--as-leader') {
      const value = args[i + 1];
      if (!value) {
        return {
          stdout: '',
          stderr: `host leave: ${arg} requires a worker base URL argument\n`,
          exitCode: 1,
        };
      }
      const normalized = normalizeTrayWorkerBaseUrl(value);
      if (!normalized) {
        return {
          stdout: '',
          stderr: `host leave: invalid worker base URL: ${value}\n`,
          exitCode: 1,
        };
      }
      workerBaseUrl = normalized;
      i += 1;
      continue;
    }
    return {
      stdout: '',
      stderr: `host leave: unexpected argument: ${arg}\n`,
      exitCode: 1,
    };
  }

  // Dormant + no leader requested → informational no-op. Exit 0 so
  // script chains (`host leave || something`) don't treat an already-
  // dormant runtime as a failure. The stderr message keeps the no-op
  // visible to interactive users.
  if (workerBaseUrl === null) {
    const leaderStatus = getLeaderStatus();
    const followerStatus = getFollowerStatus();
    if (leaderStatus.state === 'inactive' && followerStatus.state === 'inactive') {
      return {
        stdout: '',
        stderr: 'host leave: no active tray session\n',
        exitCode: 0,
      };
    }
  }

  try {
    const result = await leaveTrayImpl({ workerBaseUrl, requestId: newLeaveRequestId() });
    return { stdout: formatLeaveResult(result), stderr: '', exitCode: 0 };
  } catch (error) {
    // Distinguish "leave succeeded but join failed" from "leave failed
    // entirely" when the caller asked for a role switch. The page-side
    // `performTrayLeave` throws ONLY when `startLeader` rejects — at
    // that point the previous tray is already stopped and storage is
    // rolled back to "fully dormant", so the leave half is complete.
    const message = error instanceof Error ? error.message : String(error);
    if (workerBaseUrl !== null) {
      return {
        stdout: '',
        stderr:
          `host leave: left the tray, but failed to become leader on ${workerBaseUrl}: ${message}\n` +
          'Tray runtime is now dormant.\n',
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `host leave: ${message}\n`,
      exitCode: 1,
    };
  }
}

function formatLeaveResult(result: TrayLeaveResult): string {
  switch (result.kind) {
    case 'noop':
      return 'No active tray session.\n';
    case 'left': {
      const mode = result.previousMode;
      switch (mode) {
        case 'leader':
          return 'Stopped leader. Tray runtime is now dormant.\n';
        case 'follower':
          return 'Disconnected from leader. Tray runtime is now dormant.\n';
        default:
          return assertUnreachable(mode);
      }
    }
    case 'switched': {
      const mode = result.previousMode;
      switch (mode) {
        case 'leader':
          return `Stopped leader. Now leader on ${result.workerBaseUrl}\n`;
        case 'follower':
          return `Disconnected from leader. Now leader on ${result.workerBaseUrl}\n`;
        case 'inactive':
          return `Now leader on ${result.workerBaseUrl}\n`;
        default:
          return assertUnreachable(mode);
      }
    }
    default:
      return assertUnreachable(result);
  }
}

/**
 * Compile-time exhaustiveness guard. Adding a new variant to
 * `TrayLeaveResult` (or a new `previousMode`) without updating
 * `formatLeaveResult` becomes a typecheck error at the matching
 * `default` branch — the unmatched value is no longer `never`.
 */
function assertUnreachable(value: never): never {
  throw new Error(`formatLeaveResult: unhandled variant ${JSON.stringify(value)}`);
}

async function handleReset(
  getFollowerStatus: () => FollowerTrayRuntimeStatus,
  getLeaderStatus: () => LeaderTrayRuntimeStatus,
  resetTray: (() => Promise<LeaderTrayRuntimeStatus>) | undefined
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Only leaders can reset
  const followerStatus = getFollowerStatus();
  if (followerStatus.state !== 'inactive') {
    return {
      stdout: '',
      stderr: 'host reset: only the leader can reset the tray session\n',
      exitCode: 1,
    };
  }

  const leaderStatus = getLeaderStatus();
  if (leaderStatus.state !== 'leader' && leaderStatus.state !== 'error') {
    return {
      stdout: '',
      stderr: 'host reset: no active tray session to reset\n',
      exitCode: 1,
    };
  }

  if (!resetTray) {
    return {
      stdout: '',
      stderr: 'host reset: tray reset is not available in this environment\n',
      exitCode: 1,
    };
  }

  try {
    const newStatus = await resetTray();
    const output =
      'Tray session reset. All followers disconnected.\n' + formatLeaderOutput(newStatus, []);
    return { stdout: output, stderr: '', exitCode: 0 };
  } catch (error) {
    return {
      stdout: '',
      stderr: `host reset: ${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
    };
  }
}
