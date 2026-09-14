import type { ExtensionMessage } from '../../webapp/src/kernel/messages.js';

export async function sendServiceWorkerMessage(
  payload: ExtensionMessage['payload']
): Promise<void> {
  await chrome.runtime.sendMessage({
    source: 'service-worker' as const,
    payload,
  });
}

export function postServiceWorkerMessage(payload: ExtensionMessage['payload']): void {
  sendServiceWorkerMessage(payload).catch(() => {});
}
