export interface TrayMenuLeaderInput {
  state: string;
  session?: { joinUrl: string } | null;
  error?: string | null;
}

export interface TrayMenuFollowerInput {
  state: string;
  error?: string | null;
  lastError?: string | null;
}

export type TrayMenuModel =
  | { kind: 'leader-offer'; label: string; caption: string }
  | { kind: 'leader-copy'; joinUrl: string; label: string; caption: string }
  | { kind: 'leader-pending'; label: string; caption: string }
  | { kind: 'follower'; label: string; caption: string };

export function computeTrayMenuModel(
  leader: TrayMenuLeaderInput,
  follower: TrayMenuFollowerInput
): TrayMenuModel {
  if (leader.state === 'inactive' && follower.state === 'inactive') {
    return {
      kind: 'leader-offer',
      label: 'Enable multi-browser sync',
      caption: 'Connect another browser to this session.',
    };
  }
  if (leader.state === 'leader' && leader.session?.joinUrl) {
    return {
      kind: 'leader-copy',
      joinUrl: leader.session.joinUrl,
      label: 'Enable multi-browser sync',
      caption: 'Share this URL to connect more browsers.',
    };
  }
  if (leader.state !== 'inactive') {
    const fallback =
      leader.state === 'connecting'
        ? 'Setting up multi-browser sync\u2026'
        : leader.state === 'reconnecting'
          ? 'Reconnecting\u2026'
          : 'Sync service unreachable.';
    return {
      kind: 'leader-pending',
      label: 'Multi-browser sync',
      caption: leader.error ?? fallback,
    };
  }
  return {
    kind: 'follower',
    label: 'Multi-browser sync',
    caption:
      follower.error ??
      follower.lastError ??
      describeFollowerState(follower.state) ??
      'Mirroring another browser.',
  };
}

function describeFollowerState(state: string): string | null {
  switch (state) {
    case 'connected':
      return 'Connected — mirroring another browser.';
    case 'connecting':
      return 'Connecting to the other browser\u2026';
    case 'reconnecting':
      return 'Reconnecting\u2026';
    case 'disconnected':
      return 'Disconnected from the other browser.';
    default:
      return null;
  }
}

export function describeInvalidJoinUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Paste a sync URL to continue.';
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'That doesn\u2019t look like a URL. Paste the full https://\u2026 link from the other browser.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Sync URLs must start with https://.';
  }
  if (!parsed.pathname.includes('/join/')) {
    return 'This URL is missing the /join/\u2026 capability. Use \u201cEnable multi-browser sync\u201d on the other browser.';
  }
  return 'That sync URL is malformed. Re-copy it from the other browser and try again.';
}
