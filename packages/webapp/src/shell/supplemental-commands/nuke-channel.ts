export const NUKE_CONTROL_CHANNEL = 'slicc-nuke-control';

export interface NukeReloadMsg {
  type: 'nuke-reload';

  keysToRemove?: string[];
}

export const NUKE_LOCAL_STORAGE_KEYS: readonly string[] = [
  'slicc:welcome-flow-fired',

  'slicc.trayJoinUrl',
  'slicc.trayWorkerBaseUrl',
];

export function installNukeReloadListener(
  onReload: () => void = () => location.reload()
): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
  const handler = (event: MessageEvent): void => {
    const data = event.data as NukeReloadMsg | undefined;
    if (data?.type !== 'nuke-reload') return;
    if (Array.isArray(data.keysToRemove)) {
      for (const key of data.keysToRemove) {
        if (typeof key !== 'string') continue;
        try {
          localStorage.removeItem(key);
        } catch {}
      }
    }
    onReload();
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
