/**
 * Broadcast helper for `{ source: 'service-worker', payload }` envelopes.
 *
 * `chrome.runtime.sendMessage` fans out to every extension context except the
 * sender, so the side panel and offscreen document receive each other's traffic
 * directly — the SW only broadcasts its own replies (OAuth results, CDP
 * responses/events, tray-socket frames).
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

// `import type` only — see the import-boundary note in
// packages/chrome-extension/CLAUDE.md.
import type { ExtensionMessage } from '../../webapp/src/kernel/messages.js';

/** Broadcast a SW-sourced payload. Rejects when no context is listening. */
export async function sendServiceWorkerMessage(
  payload: ExtensionMessage['payload']
): Promise<void> {
  await chrome.runtime.sendMessage({
    source: 'service-worker' as const,
    payload,
  });
}

/** Fire-and-forget variant: no context listening is the normal case. */
export function postServiceWorkerMessage(payload: ExtensionMessage['payload']): void {
  sendServiceWorkerMessage(payload).catch(() => {
    // No listener in this context yet — best effort.
  });
}
