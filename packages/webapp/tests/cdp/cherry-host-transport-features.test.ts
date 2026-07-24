import { describe, expect, it } from 'vitest';
import { CHERRY_PROTOCOL_VERSION } from '../../src/cdp/cherry-host-protocol.js';
import { CherryHostTransport } from '../../src/cdp/cherry-host-transport.js';
import type { CDPConnectOptions } from '../../src/cdp/types.js';

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
    transport.testReceive({
      origin: 'https://host.example',
      source: parent as unknown as MessageEventSource,
      data,
    } as MessageEvent);
  return { transport, posted, inbound };
}

describe('CherryHostTransport features', () => {
  it('exposes features from the handshake welcome', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect({ timeout: 5000 } as CDPConnectOptions);

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
        modelPicker: true,
        history: true,
        nav: true,
        newSprinkle: true,
        monitor: true,
      },
    });

    await connectPromise;
    expect(h.transport.features).toEqual({
      terminal: false,
      files: true,
      memory: true,
      browser: true,
      modelPicker: true,
      history: true,
      nav: true,
      newSprinkle: true,
      monitor: true,
    });
  });

  it('defaults all features to true when welcome has no features field', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect({ timeout: 5000 } as CDPConnectOptions);
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
      modelPicker: true,
      history: true,
      nav: true,
      newSprinkle: true,
      monitor: true,
    });
  });

  it('exposes theme from handshake welcome', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect({ timeout: 5000 } as CDPConnectOptions);
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');

    const themeJson = JSON.stringify({
      id: 'cherry-custom',
      name: 'Cherry Custom',
      base: 'dark',
      tokens: { '--s2-gray-25': '#111' },
    });

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://host.example/join?t=X',
      theme: themeJson,
    });

    await connectPromise;
    expect(h.transport.theme).toBe(themeJson);
  });

  it('theme defaults to null when welcome has no theme field', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect({ timeout: 5000 } as CDPConnectOptions);
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://host.example/join?t=X',
    });

    await connectPromise;
    expect(h.transport.theme).toBeNull();
  });
});
