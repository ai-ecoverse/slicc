import { describe, expect, it } from 'vitest';
import { CHERRY_PROTOCOL_VERSION } from '../../src/cdp/cherry-host-protocol.js';
import { CherryHostTransport } from '../../src/cdp/cherry-host-transport.js';

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
  return { transport, posted, inbound };
}

describe('CherryHostTransport features', () => {
  it('exposes features from the handshake welcome', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect({ timeout: 5000 });

    // Grab the hello that was posted to extract the channelId
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');

    // Simulate host responding with welcome + features
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://host.example/join?t=X',
      features: {
        terminal: false,
        files: true,
        memory: true,
        browser: true,
        modelSelector: true,
        thinkingMode: true,
        history: true,
        nav: true,
        newSprinkle: true,
      },
    });

    await connectPromise;
    expect(h.transport.features).toEqual({
      terminal: false,
      files: true,
      memory: true,
      browser: true,
      modelSelector: true,
      thinkingMode: true,
      history: true,
      nav: true,
      newSprinkle: true,
    });
  });

  it('defaults all features to true when welcome has no features field', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect({ timeout: 5000 });
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://host.example/join?t=X',
      // no features field — old SDK
    });

    await connectPromise;
    expect(h.transport.features).toEqual({
      terminal: true,
      files: true,
      memory: true,
      browser: true,
      modelSelector: true,
      thinkingMode: true,
      history: true,
      nav: true,
      newSprinkle: true,
    });
  });
});
