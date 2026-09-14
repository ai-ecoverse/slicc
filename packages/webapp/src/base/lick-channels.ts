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
