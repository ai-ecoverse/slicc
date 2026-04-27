/**
 * Single source of truth for channels that render with the compact,
 * collapsible "lick" UI treatment.
 *
 * This set is a SUPERSET of `LickEvent.type` in
 * `scoops/lick-manager.ts`: it covers the external-event types emitted
 * by the LickManager (webhook, cron, sprinkle, fswatch, session-reload,
 * navigate) AND the synthetic scoop-lifecycle channels
 * (`scoop-notify`, `scoop-idle`) the Orchestrator fires when a scoop
 * completes or stays idle. We render both with the same widget so the
 * cone's chat history stays visually coherent across "something
 * external happened" and "a scoop finished" events.
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
  | 'scoop-notify'
  | 'scoop-idle';

export const LICK_CHANNELS: ReadonlySet<LickChannel> = new Set<LickChannel>([
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'scoop-notify',
  'scoop-idle',
]);

export function isLickChannel(channel: string | null | undefined): channel is LickChannel {
  return channel != null && LICK_CHANNELS.has(channel as LickChannel);
}
