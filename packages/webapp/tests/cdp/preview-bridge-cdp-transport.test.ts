import { describe, expect, it, vi } from 'vitest';
import { PreviewBridgeCdpTransport } from '../../src/cdp/preview-bridge-cdp-transport.js';
import type { LeaderToWorkerControlMessage } from '../../src/scoops/tray-types.js';

describe('PreviewBridgeCdpTransport', () => {
  const defaultOpts = {
    connId: 'c1',
    targetUrl: 'https://x.sliccy.now/',
    targetOrigin: 'https://x.sliccy.now',
    title: 'Preview',
  };

  describe('forward over WS backhaul', () => {
    it('forwards CDP requests and resolves on deliverResponse', async () => {
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (msg) => sent.push(msg),
      });

      await transport.connect();
      const promise = transport.send('Runtime.evaluate', { expression: '1' });

      // Should have sent a bridge.cdp.request
      const req = sent.find((m) => m.type === 'bridge.cdp.request');
      expect(req).toBeDefined();
      expect(req).toMatchObject({
        type: 'bridge.cdp.request',
        connId: 'c1',
        method: 'Runtime.evaluate',
        params: { expression: '1' },
      });

      // Deliver response with UNWRAPPED result
      transport.deliverResponse(req!.id, { result: { value: 1 } });

      // The send() promise should resolve to the unwrapped result
      expect(await promise).toEqual({ value: 1 });
    });

    it('resolves with empty object when result is missing', async () => {
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (msg) => sent.push(msg),
      });

      await transport.connect();
      // Use a non-synthetic method so it goes through forward()
      const promise = transport.send('Runtime.callFunctionOn', { functionDeclaration: 'return 1' });

      const req = sent.find((m) => m.type === 'bridge.cdp.request');
      expect(req).toBeDefined();

      // Deliver response with no result field
      transport.deliverResponse(req!.id, {});

      expect(await promise).toEqual({});
    });

    it('rejects on error in deliverResponse', async () => {
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (msg) => sent.push(msg),
      });

      await transport.connect();
      const promise = transport.send('Runtime.evaluate', { expression: 'throw new Error("oops")' });

      const req = sent.find((m) => m.type === 'bridge.cdp.request');
      expect(req).toBeDefined();

      // Deliver error
      transport.deliverResponse(req!.id, {
        error: { code: -32000, message: 'Evaluation failed' },
      });

      await expect(promise).rejects.toThrow(/Evaluation failed/);
    });

    it('rejects a pending call on timeout', async () => {
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: () => {},
      });

      await transport.connect();

      // 10ms timeout, never deliver a response
      await expect(
        transport.send('Runtime.evaluate', { expression: '1' }, undefined, 10)
      ).rejects.toThrow(/timed out/i);
    });

    it('does not leak timers on successful response', async () => {
      vi.useFakeTimers();
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (msg) => sent.push(msg),
      });

      await transport.connect();
      const promise = transport.send('Runtime.evaluate', { expression: '1' }, undefined, 1000);

      const req = sent.find((m) => m.type === 'bridge.cdp.request');
      transport.deliverResponse(req!.id, { result: { value: 1 } });

      await promise;

      // Fast-forward past the timeout; should not trigger anything
      vi.advanceTimersByTime(2000);

      vi.useRealTimers();
    });

    it('increments request IDs', async () => {
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (msg) => sent.push(msg),
      });

      await transport.connect();

      transport.send('Runtime.evaluate', { expression: '1' });
      transport.send('Runtime.evaluate', { expression: '2' });

      const requests = sent.filter((m) => m.type === 'bridge.cdp.request') as Array<
        LeaderToWorkerControlMessage & { id: number }
      >;
      expect(requests).toHaveLength(2);
      expect(requests[0].id).toBeLessThan(requests[1].id);
    });
  });

  describe('deliverEvent', () => {
    it('emits CDP events', async () => {
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: () => {},
      });

      await transport.connect();

      const events: Array<{ method: string; params: unknown }> = [];
      transport.on('Page.loadEventFired', (params) => {
        events.push({ method: 'Page.loadEventFired', params });
      });

      transport.deliverEvent('Page.loadEventFired', { timestamp: 123456 });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        method: 'Page.loadEventFired',
        params: { timestamp: 123456 },
      });
    });
  });

  describe('synthetic IDs', () => {
    it('uses preview-* synthetic IDs by default', async () => {
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: () => {},
      });

      await transport.connect();

      const targets = await transport.send('Target.getTargets', {});
      expect(targets.targetInfos).toHaveLength(1);
      expect(targets.targetInfos[0].targetId).toMatch(/^preview-/);
    });
  });
});
