/**
 * Pure model + copy for the session-sharing dialog (`sync-dialog.ts`).
 *
 * The dialog predates the iOS app and the `slicc` CLI: it used to be a
 * browser-only numbered list ("open SLICC in another browser…"). It is now one
 * tab per follower kind, plus a Status tab that appears as soon as something
 * is actually attached. Kept DOM-free so every string a user reads is covered
 * by a unit test, the same way `tray-join-url.ts` covers the avatar popover.
 */

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';

export type SyncDialogTabId = 'status' | 'browser' | 'iphone' | 'terminal';

export interface SyncDialogTab {
  id: SyncDialogTabId;
  label: string;
  /** Live follower count, rendered as a pill on the Status tab. */
  badge?: number;
}

/**
 * Tabs for a given follower count. Status leads when anything is connected —
 * "who is on this session?" is the question you have once sharing works, and
 * the how-to tabs are the question you have before that.
 */
export function buildSyncDialogTabs(followerCount: number): SyncDialogTab[] {
  const tabs: SyncDialogTab[] = [
    { id: 'browser', label: 'Browser' },
    { id: 'iphone', label: 'iPhone' },
    { id: 'terminal', label: 'Terminal' },
  ];
  if (followerCount > 0) {
    tabs.unshift({ id: 'status', label: 'Status', badge: followerCount });
  }
  return tabs;
}

/** Which tab opens by default: Status when connected, Browser otherwise. */
export function defaultSyncDialogTab(followerCount: number): SyncDialogTabId {
  return followerCount > 0 ? 'status' : 'browser';
}

/**
 * The join link is a bearer secret — anyone holding it can drive the session.
 * Show its shape, not its token, until the user asks. Returns the input
 * unchanged when it isn't a parseable `/join/<token>` URL (the invalid-URL
 * copy in `tray-join-url.ts` owns that failure mode).
 */
export function maskJoinUrl(joinUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(joinUrl);
  } catch {
    return joinUrl;
  }
  const segments = parsed.pathname.split('/');
  const tokenIndex = segments.lastIndexOf('join') + 1;
  if (tokenIndex === 0 || tokenIndex >= segments.length || !segments[tokenIndex]) return joinUrl;
  segments[tokenIndex] = '\u2022'.repeat(8);
  // Assembled by hand, not via `parsed.pathname = …`: assigning back through
  // the URL parser percent-encodes the bullets into `%E2%80%A2` noise.
  return `${parsed.origin}${segments.join('/')}${parsed.search}${parsed.hash}`;
}

/**
 * The ready-to-paste CLI line. `follow bash -c` (not a bare `follow`) is the
 * useful form — without a runner the leader can't run anything — so the
 * dialog hands over the one that works and warns about what it grants.
 */
export function cliFollowCommand(joinUrl: string): string {
  return `slicc ${joinUrl} follow bash -c`;
}

/** Where the CLI installers live when the join link can't be parsed. */
const DEFAULT_TRAY_ORIGIN = SLICC_HOSTED_ORIGIN;

/**
 * The origin serving this session — which is also the origin serving
 * `/install-cli`. Deriving the installer from the join link rather than
 * hardcoding production means a staging leader hands out the staging
 * installer, so the CLI you install can actually talk to the leader you got
 * it from.
 */
export function trayOriginFor(joinUrl: string): string {
  try {
    return new URL(joinUrl).origin;
  } catch {
    return DEFAULT_TRAY_ORIGIN;
  }
}

/** One-line POSIX install (macOS, Linux, WSL, Git Bash) → `~/.local/bin`. */
export function cliInstallCommand(joinUrl: string): string {
  return `curl -fsSL ${trayOriginFor(joinUrl)}/install-cli | sh`;
}

/** Native-Windows install, for the same binary. */
export function cliInstallCommandWindows(joinUrl: string): string {
  return `irm ${trayOriginFor(joinUrl)}/install-cli.ps1 | iex`;
}

/** Per-tab body copy. Two sentences maximum: the button below does the work. */
export function syncDialogCopy(tab: Exclude<SyncDialogTabId, 'status'>): string[] {
  switch (tab) {
    case 'browser':
      return [
        'Open Sliccy in the other browser, click the avatar, and choose “Connect to another browser”.',
        'Paste the join link there.',
      ];
    case 'iphone':
      return [
        'In the Sliccy app, paste the join link into Settings → Join link.',
        'Signed in to the same iCloud account? The session is already listed under iCloud Sessions — no link needed.',
      ];
    case 'terminal':
      return [
        'Lend a machine to this session — run these in its terminal:',
        'The agent can then run commands on that machine as you.',
      ];
  }
}

/** Footer summary above the actions. */
export function sharingSummary(followerCount: number): string {
  if (followerCount === 0) return 'Nothing connected yet.';
  return `${followerCount} ${followerCount === 1 ? 'device is' : 'devices are'} connected.`;
}

/**
 * Confirmation copy for revoking the link. Names the blast radius: the number
 * of devices this is about to drop.
 */
export function revokeConfirmLabel(followerCount: number): string {
  if (followerCount === 0) return 'Revoke link? The old link stops working.';
  return `Revoke link? ${followerCount} connected ${
    followerCount === 1 ? 'device' : 'devices'
  } will be disconnected.`;
}
