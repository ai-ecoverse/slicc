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

export function routeSwMessage(
  handlers: readonly SwMessageHandler[],
  message: unknown,
  sender: ChromeMessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  for (const handler of handlers) {
    const outcome = handler(message, sender, sendResponse);
    if (outcome === 'not-handled') continue;
    return outcome === 'handled-async';
  }
  return false;
}
