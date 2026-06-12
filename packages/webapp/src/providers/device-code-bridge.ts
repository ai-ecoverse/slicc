/**
 * Bridge that lets the welcome-flow sprinkle ("connect-llm") render the
 * GitHub Copilot device-code prompt inline, instead of falling back to
 * the provider's default floating overlay.
 *
 * Wire-up:
 *   1. `main.ts` calls `createSprinkleDeviceCodePrompter({ broadcastToDip })`
 *      and passes the returned {@link DeviceCodePrompter} into
 *      `onOAuthLoginIntercepted`'s options. The provider awaits it before
 *      opening any auth tab.
 *   2. The prompter broadcasts a `slicc-device-code` message into the
 *      sprinkle iframe and stores its resolver in a module-local slot.
 *   3. The sprinkle renders code + Cancel / Copy & Continue buttons and
 *      emits a `device-code-decision` lick when the user picks one.
 *   4. The welcome-lick interceptor in `main.ts` intercepts the lick and
 *      calls {@link resolveDeviceCodeDecision}, which fires the stored
 *      resolver.
 *
 * Only one device-code flow can be in flight per page; if a new
 * prompter starts while a previous one is still pending, the previous
 * one is cancelled defensively so the resolver chain stays sane.
 */

import type { DeviceCodePrompter, DeviceCodePromptInput } from './types.js';

type Decision = 'continue' | 'cancel';

/**
 * Shape of host-side dip broadcasters. Matches `broadcastToDips` in
 * `ui/dip.ts` — payload MUST carry a `type` field starting with `slicc-`
 * (the runtime in dip.ts asserts this).
 */
export type DipBroadcaster = (payload: { type: string; [k: string]: unknown }) => void;

let pendingResolver: ((decision: Decision) => void) | null = null;

/**
 * Build a {@link DeviceCodePrompter} that drives the welcome sprinkle.
 *
 * @param opts.broadcastToDip - The host's sprinkle-bridge broadcaster.
 *                              Same signature as `broadcastToDips` in
 *                              `main.ts`; called with a JSON-serializable
 *                              payload that the sprinkle's
 *                              `slicc-message` listener receives.
 */
export function createSprinkleDeviceCodePrompter(opts: {
  broadcastToDip: DipBroadcaster;
}): DeviceCodePrompter {
  return (input: DeviceCodePromptInput) =>
    new Promise<Decision>((resolve) => {
      if (pendingResolver) {
        const stale = pendingResolver;
        pendingResolver = null;
        stale('cancel');
      }
      pendingResolver = resolve;
      opts.broadcastToDip({
        type: 'slicc-device-code',
        userCode: input.userCode,
        verificationUrl: input.verificationUrl,
        expiresInSeconds: input.expiresInSeconds,
      });
    });
}

/**
 * Resolve the pending device-code prompter, if any. Returns true when a
 * prompter was waiting (so the caller can mark the lick as intercepted).
 */
export function resolveDeviceCodeDecision(decision: Decision): boolean {
  if (!pendingResolver) return false;
  const resolver = pendingResolver;
  pendingResolver = null;
  resolver(decision);
  return true;
}

/** Whether a sprinkle prompter is currently awaiting a decision. */
export function isDeviceCodeFlowPending(): boolean {
  return pendingResolver !== null;
}
