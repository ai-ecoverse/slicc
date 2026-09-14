import { installNukeReloadListener } from '../../shell/supplemental-commands/nuke-channel.js';

let dispose: (() => void) | null = null;

export function setupNukeReloadListener(): () => void {
  if (dispose) return dispose;
  dispose = installNukeReloadListener();
  return dispose;
}

export function __resetNukeReloadListenerForTest(): void {
  if (dispose) dispose();
  dispose = null;
}
