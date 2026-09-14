import type { DeviceCodePrompter, DeviceCodePromptInput } from './types.js';

type Decision = 'continue' | 'cancel';

export type DipBroadcaster = (payload: { type: string; [k: string]: unknown }) => void;

let pendingResolver: ((decision: Decision) => void) | null = null;

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

export function resolveDeviceCodeDecision(decision: Decision): boolean {
  if (!pendingResolver) return false;
  const resolver = pendingResolver;
  pendingResolver = null;
  resolver(decision);
  return true;
}

export function isDeviceCodeFlowPending(): boolean {
  return pendingResolver !== null;
}
