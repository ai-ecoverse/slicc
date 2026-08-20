import { describe, expect, it, vi } from 'vitest';
import { defaultLickEventHandler } from '../../src/kernel/host.js';

const cone = {
  jid: 'cone-jid',
  name: 'Cone',
  folder: 'cone',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: 't',
} as const;

const scoop = {
  jid: 'scoop-jid',
  name: 'builder',
  folder: 'builder-scoop',
  isCone: false,
  type: 'scoop',
  requiresTrigger: true,
  assistantLabel: 'builder-scoop',
  addedAt: 't',
} as const;

function bashLick(targetScoop?: string) {
  return {
    type: 'bash' as const,
    ...(targetScoop ? { targetScoop } : {}),
    bashJobId: 'bg-1',
    bashCommand: 'npm run build',
    bashExitCode: 0,
    resultPath: '/tmp/bash-bg-1.txt',
    preview: 'built',
    timestamp: 't',
    body: {},
  };
}

function routingCtx(handleMessage: ReturnType<typeof vi.fn>) {
  return {
    orchestrator: { getScoops: () => [cone, scoop], handleMessage } as never,
    lickManager: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
}

describe('backgrounded-bash lick routing', () => {
  it('routes an untargeted job completion to the cone', () => {
    const handleMessage = vi.fn(async () => undefined);
    defaultLickEventHandler(bashLick(), routingCtx(handleMessage));

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'cone-jid',
        channel: 'bash',
        senderName: 'bash:bg-1',
        id: expect.stringContaining('bash-bash-bg-1-'),
        content: expect.stringContaining('npm run build'),
      })
    );
  });

  it('routes a targeted job completion back to the scoop that started it', () => {
    const handleMessage = vi.fn(async () => undefined);
    // The scoop's folder is what the bash tool stamps as targetScoop.
    defaultLickEventHandler(bashLick('builder-scoop'), routingCtx(handleMessage));

    expect(handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'scoop-jid', channel: 'bash' })
    );
  });

  it('drops the lick when its target scoop is gone (dropped mid-run)', () => {
    const handleMessage = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    defaultLickEventHandler(bashLick('ghost-scoop'), {
      orchestrator: { getScoops: () => [cone], handleMessage } as never,
      lickManager: {} as never,
      log,
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
