import type { LeaderToWorkerControlMessage } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import { PreviewBridgeCdpTransport } from '../../src/cdp/preview-bridge-cdp-transport.js';

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

      const first = transport.send('Runtime.evaluate', { expression: '1' });
      const second = transport.send('Runtime.evaluate', { expression: '2' });

      const requests = sent.filter((m) => m.type === 'bridge.cdp.request') as Array<
        LeaderToWorkerControlMessage & { id: number }
      >;
      expect(requests).toHaveLength(2);
      expect(requests[0].id).toBeLessThan(requests[1].id);

      // Settle the pending sends so they are not floating promises.
      transport.deliverResponse(requests[0].id, { result: { value: 1 } });
      transport.deliverResponse(requests[1].id, { result: { value: 2 } });
      await Promise.all([first, second]);
    });
  });

  describe('closeTarget', () => {
    it('sends bridge.close so a preview close really tears down the connection', async () => {
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (msg) => sent.push(msg),
      });
      await transport.connect();

      const res = await transport.send('Target.closeTarget', { targetId: 'preview-target' });
      expect(res).toEqual({ success: true });
      expect(sent).toContainEqual({ type: 'bridge.close', connId: 'c1' });
    });
  });

  describe('synthetic IDs', () => {
    it('uses preview-* synthetic IDs by default', async () => {
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: () => {},
      });

      await transport.connect();

      const targets = (await transport.send('Target.getTargets', {})) as {
        targetInfos: Array<Record<string, unknown>>;
      };
      expect(targets.targetInfos).toHaveLength(1);
      expect(targets.targetInfos[0].targetId).toMatch(/^preview-/);
    });

    it('gets a frame snapshot through the synthetic preview isolated world', async () => {
      const sent: LeaderToWorkerControlMessage[] = [];
      const transport = new PreviewBridgeCdpTransport({
        ...defaultOpts,
        send: (message) => sent.push(message),
      });
      const api = new BrowserAPI(transport);
      await api.connect();
      await api.attachToPage('preview-target');

      const snapshot = api.getAccessibilityTreeForFrame('preview-frame');
      await vi.waitFor(() => {
        expect(sent.some((message) => message.type === 'bridge.cdp.request')).toBe(true);
      });
      const requests = sent.filter((message) => message.type === 'bridge.cdp.request');
      expect(requests.map((request) => request.method)).toEqual(['Runtime.evaluate']);
      expect(requests[0].params).toMatchObject({
        contextId: 1,
        awaitPromise: false,
        returnByValue: true,
      });
      transport.deliverResponse(requests[0].id, {
        result: {
          result: {
            type: 'object',
            value: { role: 'RootWebArea', name: 'Preview frame' },
          },
        },
      });

      await expect(snapshot).resolves.toMatchObject({ role: 'RootWebArea', name: 'Preview frame' });
      api.disconnect();
    });
  });
});
