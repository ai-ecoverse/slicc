import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../../../../src/kernel/process-manager.js';
import {
  enableRealmNetwork,
  realmNetworkEnv,
  realmProxy,
} from '../../../../src/kernel/wasm-realm/net/realm-network.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { Client, reply, scripted, tick } from './proxy-helpers.js';

const owner = { kind: 'scoop' as const, scoopJid: 'scoop-a' };

describe('enableRealmNetwork', () => {
  it('starts the proxy on the first connection to 127.0.0.1:3128, not before', async () => {
    const net = new LoopbackNet();
    const t = scripted(() => reply(200, [], 'from outside'));
    enableRealmNetwork(net, { transport: () => t.transport });
    expect(realmProxy(net)).toBeUndefined();
    const c = Client.open(net);
    expect(realmProxy(net)?.port).toBe(3128);
    await c.send('GET http://example.com/ HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect((await c.response()).body).toBe('from outside');
    // Other ports stay refused.
    expect(() => net.connect({ family: 'inet', host: '127.0.0.1', port: 3129 })).toThrow(
      'ECONNREFUSED'
    );
    realmProxy(net)?.close();
  });

  it('lets a program that bound 3128 first keep it', () => {
    const net = new LoopbackNet();
    enableRealmNetwork(net, { transport: () => scripted(() => reply(200, [])).transport });
    const own = net.listen({ family: 'inet', host: '127.0.0.1', port: 3128 });
    net.connect({ family: 'inet', host: '127.0.0.1', port: 3128 });
    expect(realmProxy(net)).toBeUndefined();
    own.close();
  });

  it('runs as a net process of its owner; a kill stops it and the next connection restarts it', async () => {
    const net = new LoopbackNet();
    const pm = new ProcessManager();
    const t = scripted(() => reply(200, [], 'ok'));
    enableRealmNetwork(net, {
      transport: () => t.transport,
      process: { processManager: pm, owner },
    });
    // A second call (another invocation of the same owner) changes nothing.
    enableRealmNetwork(net, { transport: () => scripted(() => reply(500, [])).transport });
    Client.open(net).close();
    const first = pm.list().find((p) => p.kind === 'net');
    expect(first?.argv).toEqual(['http-proxy', '127.0.0.1:3128']);
    expect(first?.owner).toEqual(owner);
    expect(first?.status).toBe('running');

    const proxy = realmProxy(net);
    pm.signal(first?.pid ?? 0, 'SIGTERM');
    await proxy?.closed;
    await tick();
    expect(pm.get(first?.pid ?? 0)?.status).toBe('killed');
    expect(realmProxy(net)).toBeUndefined();

    const c = Client.open(net);
    await c.send('GET http://example.com/ HTTP/1.1\r\n\r\n');
    expect((await c.response()).body).toBe('ok');
    const again = pm.list().filter((p) => p.kind === 'net' && p.status === 'running');
    expect(again).toHaveLength(1);
    expect(again[0].pid).not.toBe(first?.pid);
    realmProxy(net)?.close();
  });
});

describe('realmNetworkEnv', () => {
  it('points every client at the proxy and keeps the realm loopback direct', () => {
    expect(realmNetworkEnv()).toEqual({
      http_proxy: 'http://127.0.0.1:3128',
      https_proxy: 'http://127.0.0.1:3128',
      HTTP_PROXY: 'http://127.0.0.1:3128',
      HTTPS_PROXY: 'http://127.0.0.1:3128',
      no_proxy: 'localhost,.localhost,127.0.0.1,127.0.0.0/8',
      NO_PROXY: 'localhost,.localhost,127.0.0.1,127.0.0.0/8',
    });
  });
});
