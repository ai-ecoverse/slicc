import { describe, expect, it } from 'vitest';
import { ScoopPresentation } from '../../../src/kernel/facade/scoop-presentation.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';

const trayRuntimeStatus = {
  leader: { state: 'inactive', session: null, error: null, reconnectAttempts: 0 },
  follower: {
    state: 'inactive',
    joinUrl: null,
    trayId: null,
    error: null,
    lastError: null,
    reconnectAttempts: 0,
    attachAttempts: 0,
    lastAttachCode: null,
    connectingSince: null,
    lastPingTime: null,
  },
} as const;

function scoop(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone-1',
    name: 'Cone',
    folder: 'cone',
    isCone: true,
    parentJid: null,
    type: 'cone',
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ScoopPresentation', () => {
  it('tracks status and falls back to the cone for active scoop', () => {
    const presentation = new ScoopPresentation();
    presentation.setStatus('cone-1', 'processing');

    const snapshot = presentation.buildStateSnapshot([scoop()], trayRuntimeStatus);

    expect(snapshot.activeScoopJid).toBe('cone-1');
    expect(snapshot.scoops[0].status).toBe('processing');
  });

  it('prefers the cached active scoop and falls back after it is cleared', () => {
    const presentation = new ScoopPresentation();
    presentation.setActiveScoopJid('scoop-2');
    expect(presentation.buildStateSnapshot([scoop()], trayRuntimeStatus).activeScoopJid).toBe(
      'scoop-2'
    );
    presentation.setActiveScoopJid(null);
    expect(presentation.buildStateSnapshot([scoop()], trayRuntimeStatus).activeScoopJid).toBe(
      'cone-1'
    );
  });

  it('projects only modelId and thinkingLevel from config', () => {
    const presentation = new ScoopPresentation();
    const projected = presentation.projectScoop(
      scoop({
        config: {
          modelId: 'model-1',
          thinkingLevel: 'high',
          systemPromptAppend: 'private projection detail',
          writablePaths: ['/tmp'],
        },
      })
    );

    expect(projected.config).toEqual({ modelId: 'model-1', thinkingLevel: 'high' });
  });
});
