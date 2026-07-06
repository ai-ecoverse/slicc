import type { LeaderToWorkerControlMessage, WorkerToLeaderControlMessage } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';

describe('bridge control messages', () => {
  it('constructs a bridge.connected + bridge.cdp.request', () => {
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
    expect(connected.type).toBe('bridge.connected');
    expect(req.method).toBe('Runtime.evaluate');
  });
});
