/**
 * Single source of truth for channels that render with the compact,
 * collapsible "lick" UI treatment.
 *
 * This set overlaps `LickEvent.type` in `scoops/lick-manager.ts` but is
 * neither a subset nor a superset of it: it covers most external-event
 * types emitted by the LickManager (webhook, cron, sprinkle, fswatch,
 * session-reload, navigate, discovery, upgrade, workflow, bash) AND the synthetic
 * scoop-lifecycle channels (`scoop-notify`, `scoop-idle`, `scoop-wait`)
 * the Orchestrator fires when a scoop completes, stays idle, or when a
 * previously scheduled `scoop_wait` resolves. `'preview'` is included because
 * its persisted lifecycle announcement must use this guard to render as a
 * compact chip both live and on replay. It deliberately omits `'cherry'` —
 * that `LickEvent['type']` renders through its dedicated Cherry event path,
 * not through the inline collapsible lick widget this set drives.
 * We render everything in this set with the same widget so the cone's
 * chat history stays visually coherent across "something external
 * happened" and "a scoop finished" events.
 *
 * Anything rendering lick messages (chat panel, main.ts history
 * replay, persistence paths) must import from here rather than
 * redeclaring a local set — the duplicated lists used to drift and
 * silently suppressed newly-added channels.
 */
export type LickChannel =
  | 'webhook'
  | 'cron'
  | 'sprinkle'
  | 'fswatch'
  | 'session-reload'
  | 'navigate'
  | 'discovery'
  | 'upgrade'
  | 'workflow'
  | 'bash'
  | 'preview'
  | 'scoop-notify'
  | 'scoop-idle'
  | 'scoop-wait'
  | 'sudo-request';

export const LICK_CHANNELS: ReadonlySet<LickChannel> = new Set<LickChannel>([
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'discovery',
  'upgrade',
  'workflow',
  'bash',
  'preview',
  'scoop-notify',
  'scoop-idle',
  'scoop-wait',
  'sudo-request',
]);

export function isLickChannel(channel: string | null | undefined): channel is LickChannel {
  return channel != null && LICK_CHANNELS.has(channel as LickChannel);
}
