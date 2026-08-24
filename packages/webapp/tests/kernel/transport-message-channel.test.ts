/**
 * Unit tests for the MessageChannel-based KernelTransport adapter.
 *
 * Pins:
 *  - bidirectional round-trip across a `MessageChannel` pair
 *  - structured-clone for object payloads
 *  - `start()` is called on first subscribe so queued pre-subscribe
 *    messages are delivered (via tightening the subscribe order)
 *  - unsubscribe stops further deliveries to that handler
 *  - multiple subscribers each get every message
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../src/kernel/facade.js';
import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from '../../src/kernel/messages.js';
import {
  createBridgeMessageChannelTransport,
  createMessageChannelTransport,
  createPanelMessageChannelTransport,
} from '../../src/kernel/transport-message-channel.js';
import { runAgenticMemoryPass } from '../../src/scoops/agentic-memory.js';
import { OffscreenClient } from '../../src/ui/offscreen-client.js';

interface UpMsg {
  type: 'up';
  n: number;
  payload?: { nested: boolean };
}
interface DownMsg {
  type: 'down';
  n: number;
}

function tick(ms = 5): Promise<void> {
  // MessageChannel delivery in Node hops the event loop; setTimeout
  // gives it room to flush across both ports before assertions run.
  return new Promise((r) => setTimeout(r, ms));
}

describe('createMessageChannelTransport', () => {
  it('delivers messages in both directions across a MessageChannel pair', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<DownMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, DownMsg>(channel.port2);

    const aIn: DownMsg[] = [];
    const bIn: UpMsg[] = [];
    a.onMessage((m) => aIn.push(m));
    b.onMessage((m) => bIn.push(m));

    a.send({ type: 'up', n: 1 });
    a.send({ type: 'up', n: 2, payload: { nested: true } });
    b.send({ type: 'down', n: 99 });

    await tick();

    expect(bIn).toEqual([
      { type: 'up', n: 1 },
      { type: 'up', n: 2, payload: { nested: true } },
    ]);
    expect(aIn).toEqual([{ type: 'down', n: 99 }]);

    channel.port1.close();
    channel.port2.close();
  });

  it('unsubscribe stops further deliveries', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<UpMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, UpMsg>(channel.port2);

    const seen: UpMsg[] = [];
    const off = b.onMessage((m) => seen.push(m));

    a.send({ type: 'up', n: 1 });
    await tick();
    expect(seen).toHaveLength(1);

    off();
    a.send({ type: 'up', n: 2 });
    await tick();
    expect(seen).toHaveLength(1);

    channel.port1.close();
    channel.port2.close();
  });

  it('multiple subscribers each receive every message', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<UpMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, UpMsg>(channel.port2);

    const seenA: UpMsg[] = [];
    const seenB: UpMsg[] = [];
    b.onMessage((m) => seenA.push(m));
    b.onMessage((m) => seenB.push(m));

    a.send({ type: 'up', n: 7 });
    a.send({ type: 'up', n: 8 });
    await tick();

    expect(seenA).toEqual([
      { type: 'up', n: 7 },
      { type: 'up', n: 8 },
    ]);
    expect(seenB).toEqual([
      { type: 'up', n: 7 },
      { type: 'up', n: 8 },
    ]);

    channel.port1.close();
    channel.port2.close();
  });

  it('messages sent before any subscriber are queued and delivered after start()', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<UpMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, UpMsg>(channel.port2);

    a.send({ type: 'up', n: 100 });
    a.send({ type: 'up', n: 101 });

    // Subscriber attaches AFTER messages were sent. The transport calls
    // port.start() on first subscribe, which flushes the queue.
    const seen: UpMsg[] = [];
    b.onMessage((m) => seen.push(m));
    await tick();

    expect(seen).toEqual([
      { type: 'up', n: 100 },
      { type: 'up', n: 101 },
    ]);

    channel.port1.close();
    channel.port2.close();
  });
});

// ---------------------------------------------------------------------------
// Bridge-shaped helpers — wrap payloads in source-tagged envelopes so
// `Bridge` and `OffscreenClient` can filter inbound messages
// by `source` exactly like they do over chrome.runtime.
// ---------------------------------------------------------------------------

describe('createBridgeMessageChannelTransport / createPanelMessageChannelTransport', () => {
  it('panel→bridge: panel-side send wraps payload with source: panel', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);

    const inboundOnBridge: ExtensionMessage[] = [];
    bridgeTransport.onMessage((env) => inboundOnBridge.push(env));

    const payload: PanelToOffscreenMessage = {
      type: 'request-state',
    };
    panelTransport.send(payload);
    await tick();

    expect(inboundOnBridge).toHaveLength(1);
    expect(inboundOnBridge[0]).toEqual({ source: 'panel', payload });

    channel.port1.close();
    channel.port2.close();
  });

  it('round-trips an agent spawn through the real OffscreenClient and Bridge seam', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);
    const bridge = new Bridge(bridgeTransport);
    await bridge.bind({} as never);

    const spawn = vi.fn(async () => ({ finalText: 'curated', exitCode: 0 }));
    (globalThis as Record<string, unknown>).__slicc_agent = { spawn };
    const client = new OffscreenClient(
      {
        onStatusChange: vi.fn(),
        onScoopCreated: vi.fn(),
        onScoopListUpdate: vi.fn(),
        onIncomingMessage: vi.fn(),
      },
      panelTransport
    );
    const result = await runAgenticMemoryPass({
      spawn: (options) => client.spawnAgent(options),
      vfs: {
        readFile: async () => Promise.reject(new Error('MEMORY.md absent')),
        writeFile: async () => {},
        mkdir: async () => {},
      },
      sessionArchivePath: '/sessions/frozen.md',
      sessionCount: 1,
    });

    expect(result).toEqual({ ok: true, report: 'curated' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace',
        // The curator writes a staged per-archive draft; the bridge merges
        // it onto /workspace/CLAUDE.md on exit 0 (mergeOnSuccess).
        writablePaths: ['/sessions/.curation/frozen.md/draft.md'],
        visiblePaths: ['/sessions/', '/shared/', '/workspace/', '/sessions/.curation/frozen.md/'],
        notifyOnComplete: true,
      })
    );

    channel.port1.close();
    channel.port2.close();
    delete (globalThis as Record<string, unknown>).__slicc_agent;
  });

  it('bridge→panel: bridge-side send wraps payload with source: offscreen', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);

    const inboundOnPanel: ExtensionMessage[] = [];
    panelTransport.onMessage((env) => inboundOnPanel.push(env));

    const payload: OffscreenToPanelMessage = {
      type: 'state-snapshot',
      scoops: [],
      activeScoopJid: null,
    };
    bridgeTransport.send(payload);
    await tick();

    expect(inboundOnPanel).toHaveLength(1);
    expect(inboundOnPanel[0]).toEqual({ source: 'offscreen', payload });

    channel.port1.close();
    channel.port2.close();
  });

  it('bidirectional roundtrip: panel sends request-state, bridge replies state-snapshot', async () => {
    const channel = new MessageChannel();
    const panelTransport = createPanelMessageChannelTransport(channel.port1);
    const bridgeTransport = createBridgeMessageChannelTransport(channel.port2);

    const inboundOnBridge: ExtensionMessage[] = [];
    const inboundOnPanel: ExtensionMessage[] = [];
    bridgeTransport.onMessage((env) => inboundOnBridge.push(env));
    panelTransport.onMessage((env) => inboundOnPanel.push(env));

    panelTransport.send({ type: 'request-state' });
    await tick();
    expect(inboundOnBridge).toEqual([{ source: 'panel', payload: { type: 'request-state' } }]);

    bridgeTransport.send({
      type: 'state-snapshot',
      scoops: [],
      activeScoopJid: null,
    });
    await tick();
    expect(inboundOnPanel).toEqual([
      {
        source: 'offscreen',
        payload: { type: 'state-snapshot', scoops: [], activeScoopJid: null },
      },
    ]);

    channel.port1.close();
    channel.port2.close();
  });
});
