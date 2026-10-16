export function getMsgType(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return undefined;
  const t = (msg as { type: unknown }).type;
  return typeof t === 'string' ? t : undefined;
}

export type SwMessageOutcome = 'not-handled' | 'handled' | 'handled-async';

export type SwMessageHandler = (
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
) => SwMessageOutcome;

function isTrustedInternalSender(sender: ChromeMessageSender): boolean {
  if (typeof sender.id !== 'string' || sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

  const senderOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  return senderOrigin === extensionOrigin;
}

export function routeSwMessage(
  handlers: readonly SwMessageHandler[],
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  if (!isTrustedInternalSender(sender)) {
    return false;
  }
  for (const handler of handlers) {
    const outcome = handler(message, sender, sendResponse);
    if (outcome === 'not-handled') continue;
    return outcome === 'handled-async';
  }
  return false;
}
