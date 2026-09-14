import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';

export type SyncDialogTabId = 'status' | 'browser' | 'iphone' | 'terminal';

export interface SyncDialogTab {
  id: SyncDialogTabId;
  label: string;

  badge?: number;
}

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

export function defaultSyncDialogTab(followerCount: number): SyncDialogTabId {
  return followerCount > 0 ? 'status' : 'browser';
}

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

  return `${parsed.origin}${segments.join('/')}${parsed.search}${parsed.hash}`;
}

export function cliFollowCommand(joinUrl: string): string {
  return `slicc ${joinUrl} follow bash -c`;
}

const DEFAULT_TRAY_ORIGIN = SLICC_HOSTED_ORIGIN;

export function trayOriginFor(joinUrl: string): string {
  try {
    return new URL(joinUrl).origin;
  } catch {
    return DEFAULT_TRAY_ORIGIN;
  }
}

export function cliInstallCommand(joinUrl: string): string {
  return `curl -fsSL ${trayOriginFor(joinUrl)}/install-cli | sh`;
}

export function cliInstallCommandWindows(joinUrl: string): string {
  return `irm ${trayOriginFor(joinUrl)}/install-cli.ps1 | iex`;
}

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

export function sharingSummary(followerCount: number): string {
  if (followerCount === 0) return 'Nothing connected yet.';
  return `${followerCount} ${followerCount === 1 ? 'device is' : 'devices are'} connected.`;
}

export function revokeConfirmLabel(followerCount: number): string {
  if (followerCount === 0) return 'Revoke link? The old link stops working.';
  return `Revoke link? ${followerCount} connected ${
    followerCount === 1 ? 'device' : 'devices'
  } will be disconnected.`;
}
