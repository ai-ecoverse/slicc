/**
 * Tests for `sendLickStream` — the streaming consumer half of the lick
 * WebSocket bridge. The browser side (Task 5) already emits
 * `{type:'shell-chunk', requestId, frame}` per frame and a terminal
 * `{type:'shell-done', requestId}`. These tests verify the node-server
 * receives them correctly.
 *
 * Standalone-only: extension has no node-server (spec §11).
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createLickBridge } from '../../src/routes/lick-bridge.js';

/** Minimal stand-in for a connected `ws` client (mirrors the FakeClient in lick.test.ts). */
class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function makeBridge() {
  const bridge = createLickBridge();
  const client = new FakeClient();
  bridge.lickWss.emit('connection', client);
  return { bridge, client };
}

/** Simulate the browser sending a message back to the node-server. */
function sendFromBrowser(client: FakeClient, payload: unknown): void {
  client.emit('message', Buffer.from(JSON.stringify(payload)));
}

describe('sendLickStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects when no browser is connected', async () => {
    const bridge = createLickBridge();
    await expect(bridge.sendLickStream('shell-exec', {}, () => {})).rejects.toThrow(
      'No browser connected'
    );
  });

  it('delivers two shell-chunk frames in order then resolves on shell-done', async () => {
    const { bridge, client } = makeBridge();
    const frames: unknown[] = [];
    const onFrame = (f: unknown) => frames.push(f);

    const pending = bridge.sendLickStream('shell-exec', { command: 'ls' }, onFrame);

    // Grab the requestId from the message the bridge sent to the browser
    expect(client.sent).toHaveLength(1);
    const { requestId } = JSON.parse(client.sent[0]) as { requestId: string };

    const frame1 = { t: 'stdout', d: 'hello\n' };
    const frame2 = { t: 'exit', code: 0, pid: 42 };

    sendFromBrowser(client, { type: 'shell-chunk', requestId, frame: frame1 });
    sendFromBrowser(client, { type: 'shell-chunk', requestId, frame: frame2 });
    sendFromBrowser(client, { type: 'shell-done', requestId });

    // shell-done clears the timer — just await the promise directly
    await expect(pending).resolves.toBeUndefined();
    expect(frames).toEqual([frame1, frame2]);
  });

  it('resolves without frames when shell-done arrives immediately', async () => {
    const { bridge, client } = makeBridge();
    const onFrame = vi.fn();

    const pending = bridge.sendLickStream('shell-exec', {}, onFrame);
    const { requestId } = JSON.parse(client.sent[0]) as { requestId: string };

    sendFromBrowser(client, { type: 'shell-done', requestId });
    await expect(pending).resolves.toBeUndefined();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('rejects when inactivity timeout fires (no shell-done within timeout window)', async () => {
    const { bridge, client } = makeBridge();

    const pending = bridge.sendLickStream('shell-exec', {}, () => {}, 100);
    const { requestId } = JSON.parse(client.sent[0]) as { requestId: string };
    // requestId captured for completeness but the timer fires before any message
    void requestId;

    const assertion = expect(pending).rejects.toThrow('Request timeout');
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it('timeout resets on each frame so a slow-but-active stream stays alive', async () => {
    const { bridge, client } = makeBridge();
    const frames: unknown[] = [];

    const pending = bridge.sendLickStream('shell-exec', {}, (f) => frames.push(f), 200);
    const { requestId } = JSON.parse(client.sent[0]) as { requestId: string };

    // Send a frame at 150ms — inside the window; timeout should reset
    await vi.advanceTimersByTimeAsync(150);
    sendFromBrowser(client, { type: 'shell-chunk', requestId, frame: { t: 'stdout', d: 'hi' } });

    // Advance another 150ms from the reset point (total 300ms from start,
    // but only 150ms since the last frame)
    await vi.advanceTimersByTimeAsync(150);
    // Stream is still alive — send done
    sendFromBrowser(client, { type: 'shell-done', requestId });

    // shell-done resolves and clears the timer; await directly
    await expect(pending).resolves.toBeUndefined();
    expect(frames).toHaveLength(1);
  });

  it('does not interfere with a concurrent sendLickRequest (pendingRequests kept separate)', async () => {
    const { bridge, client } = makeBridge();

    // Start a stream request
    const streamFrames: unknown[] = [];
    const streamPending = bridge.sendLickStream('shell-exec', {}, (f) => streamFrames.push(f));
    const streamReqId = (JSON.parse(client.sent[0]) as { requestId: string }).requestId;

    // Start a plain request/response
    const reqPending = bridge.sendLickRequest('tray_status', {});
    const reqReqId = (JSON.parse(client.sent[1]) as { requestId: string }).requestId;

    // Reply to the plain request — should not affect the stream.
    // The response message is processed synchronously; avoid runAllTimersAsync
    // here because the stream's 10-min timer is still pending and would trip.
    sendFromBrowser(client, { type: 'response', requestId: reqReqId, data: { state: 'leader' } });
    await expect(reqPending).resolves.toEqual({ state: 'leader' });

    // Stream still pending — deliver a frame and done
    sendFromBrowser(client, {
      type: 'shell-chunk',
      requestId: streamReqId,
      frame: { t: 'exit', code: 0, pid: 1 },
    });
    sendFromBrowser(client, { type: 'shell-done', requestId: streamReqId });
    // shell-done clears the timer; await directly
    await expect(streamPending).resolves.toBeUndefined();
    expect(streamFrames).toHaveLength(1);
  });

  it('shell-chunk for an unknown requestId is silently ignored', () => {
    const { bridge, client } = makeBridge();
    // No streams registered — should not throw
    expect(() =>
      sendFromBrowser(client, { type: 'shell-chunk', requestId: 'unknown-999', frame: {} })
    ).not.toThrow();
    expect(() =>
      sendFromBrowser(client, { type: 'shell-done', requestId: 'unknown-999' })
    ).not.toThrow();
    void bridge; // satisfy linter
  });
});
