import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';

describe('bridge control messages', () => {
  it('constructs bridge and durable preview-state messages', () => {
    const connected: WorkerToLeaderControlMessage = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 'tray.secret',
      origin: 'https://x.sliccy.now',
      userAgent: 'UA',
      connectedAt: new Date().toISOString(),
    };
    const req: LeaderToWorkerControlMessage = {
      type: 'bridge.cdp.request',
      connId: 'c1',
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    };
    const restored: WorkerToLeaderControlMessage = {
      type: 'preview.state',
      previewToken: 'tray.secret',
      quiet: true,
      announced: false,
    };
    const update: LeaderToWorkerControlMessage = {
      type: 'preview.state.update',
      previewToken: 'tray.secret',
      announced: true,
    };
    expect(connected.type).toBe('bridge.connected');
    expect(req.method).toBe('Runtime.evaluate');
    expect(restored.quiet).toBe(true);
    expect(update.announced).toBe(true);
  });
});
