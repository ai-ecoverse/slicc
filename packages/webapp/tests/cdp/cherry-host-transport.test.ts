import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CherryHostTransport } from '../../src/cdp/cherry-host-transport.js';
import { CHERRY_PROTOCOL_VERSION } from '../../src/cdp/cherry-host-protocol.js';

function makeTransport() {
  const posted: any[] = [];
  const parent = { postMessage: (m: any) => posted.push(m) } as unknown as Window;
  const transport = new CherryHostTransport({
    counterpart: parent,
    allowOrigins: ['https://host.example'],
    targetOrigin: 'https://host.example',
  });
  // Drive inbound messages as if from the host.
  const inbound = (data: any) =>
    transport.__test_receive({
      origin: 'https://host.example',
      source: parent as unknown as MessageEventSource,
      data,
    } as MessageEvent);
  return { transport, posted, parent, inbound };
}

describe('CherryHostTransport', () => {
  let h: ReturnType<typeof makeTransport>;
  beforeEach(() => {
    h = makeTransport();
  });

  it('handshakes: sends hello, resolves connect on welcome', async () => {
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');
    expect(hello).toBeTruthy();
    expect(hello.cherry).toBe(CHERRY_PROTOCOL_VERSION);
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://app.example/join?t=Z',
    });
    await expect(p).resolves.toBeUndefined();
    expect(h.transport.state).toBe('connected');
    expect(h.transport.joinUrl).toBe('https://app.example/join?t=Z');
  });

  it('synthesizes Target.getTargets locally without a host round-trip', async () => {
    await connectHelper(h);
    const res = await h.transport.send('Target.getTargets');
    expect(Array.isArray((res as any).targetInfos)).toBe(true);
    expect((res as any).targetInfos[0].type).toBe('page');
  });

  it('forwards leaf methods and resolves on cdp.response', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const p = h.transport.send('Runtime.evaluate', { expression: '1+1' });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Runtime.evaluate');
    expect(req).toBeTruthy();
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { result: { type: 'number', value: 2 } },
    });
    await expect(p).resolves.toEqual({ result: { type: 'number', value: 2 } });
  });

  it('emits frameNavigated + loadEventFired after Page.navigate resolves', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const events: string[] = [];
    h.transport.on('Page.frameNavigated', () => events.push('frameNavigated'));
    h.transport.on('Page.loadEventFired', () => events.push('loadEventFired'));
    const p = h.transport.send('Page.navigate', { url: 'https://host.example/next' });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Page.navigate');
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { frameId: 'cherry-frame' },
    });
    await p;
    expect(events).toEqual(['frameNavigated', 'loadEventFired']);
  });

  it('rejects inbound from a foreign origin', async () => {
    await connectHelper(h);
    const before = h.posted.length;
    h.transport.__test_receive({
      origin: 'https://evil.example',
      source: h.parent as unknown as MessageEventSource,
      data: { cherry: CHERRY_PROTOCOL_VERSION, channelId: 'x', kind: 'cdp.event', method: 'X' },
    } as MessageEvent);
    expect(h.posted.length).toBe(before); // no reaction
  });
});

async function connectHelper(h: ReturnType<typeof makeTransport>) {
  const p = h.transport.connect();
  const hello = h.posted.find((m) => m.kind === 'handshake.hello');
  h.inbound({
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: hello.channelId,
    kind: 'handshake.welcome',
  });
  await p;
}
function lastChannelId(h: ReturnType<typeof makeTransport>) {
  return h.posted.find((m) => m.kind === 'handshake.hello').channelId as string;
}
