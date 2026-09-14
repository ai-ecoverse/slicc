export const LEADER_STATUS_STORAGE_KEY = 'slicc.leaderTrayStatus';

export const FOLLOWER_STATUS_STORAGE_KEY = 'slicc.followerTrayStatus';

export type TrayRole = 'leader' | 'follower' | 'standalone';

function shimState(key: string): string | null {
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(key);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { state?: unknown };
    return typeof parsed?.state === 'string' ? parsed.state : null;
  } catch {
    return null;
  }
}

export function readTrayRole(): TrayRole {
  const follower = shimState(FOLLOWER_STATUS_STORAGE_KEY);
  if (follower !== null && follower !== 'inactive') return 'follower';
  return shimState(LEADER_STATUS_STORAGE_KEY) === 'leader' ? 'leader' : 'standalone';
}

export type FloatType = 'standalone' | 'extension' | 'electron' | 'ios' | 'unknown';
