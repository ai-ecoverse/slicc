/**
 * Sprinkle-op response routing.
 *
 * The kernel bridge (`kernel/facade.ts`) receives `sprinkle-op-response`
 * payloads and hands them to `handleSprinkleOpResponse`, which resolves
 * the matching pending request by ID. Requests are registered in
 * `pendingRequests`; live sprinkle traffic flows over the same-origin
 * BroadcastChannel bridge (`createSprinkleManagerProxyOverChannel` in
 * `sprinkle-bridge-channel.ts`).
 */

/** Pending request callbacks, keyed by request ID. */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Called by the kernel bridge when it receives a sprinkle-op-response
 * from the side panel. This must be wired in kernel/facade.ts.
 */
export function handleSprinkleOpResponse(payload: {
  id: string;
  result?: unknown;
  error?: string;
}): void {
  const pending = pendingRequests.get(payload.id);
  if (!pending) return;
  pendingRequests.delete(payload.id);
  clearTimeout(pending.timer);
  if (payload.error) pending.reject(new Error(payload.error));
  else pending.resolve(payload.result);
}
