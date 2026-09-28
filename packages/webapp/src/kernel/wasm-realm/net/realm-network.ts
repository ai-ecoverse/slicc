import type { ProcessManager, ProcessOwner } from '../../process-manager.js';
import type { LoopbackNet } from '../socket.js';
import { proxiedFetchTransport } from './fetch-transport.js';
import { REALM_PROXY_PORT, RealmProxy, type RealmProxyOptions } from './proxy-service.js';
import type { RealmTransport } from './transport.js';

const PROXY_URL = `http://127.0.0.1:${REALM_PROXY_PORT}`;

const NO_PROXY = 'localhost,.localhost,127.0.0.1,127.0.0.0/8';

export function realmNetworkEnv(): Record<string, string> {
  return {
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    no_proxy: NO_PROXY,
    NO_PROXY: NO_PROXY,
  };
}

export interface RealmNetworkProcess {
  processManager: ProcessManager;
  owner: ProcessOwner;
}

export interface RealmNetworkOptions {
  process?: RealmNetworkProcess;

  transport?: () => RealmTransport;

  proxy?: Pick<RealmProxyOptions, 'tunnel' | 'limits'>;
}

const running = new WeakMap<LoopbackNet, { proxy: RealmProxy | undefined }>();

export function realmProxy(net: LoopbackNet): RealmProxy | undefined {
  return running.get(net)?.proxy;
}

export function enableRealmNetwork(net: LoopbackNet, options: RealmNetworkOptions = {}): void {
  if (running.has(net)) return;
  const state: { proxy: RealmProxy | undefined } = { proxy: undefined };
  running.set(net, state);
  let transport: RealmTransport | undefined;
  net.activate({ family: 'inet', host: '127.0.0.1', port: REALM_PROXY_PORT }, () => {
    transport ??= (options.transport ?? proxiedFetchTransport)();
    const proxy = new RealmProxy({ net, transport, ...options.proxy });
    state.proxy = proxy;
    const done = supervise(proxy, options.process);
    void done.then(() => {
      if (state.proxy === proxy) state.proxy = undefined;
    });
  });
}

async function supervise(proxy: RealmProxy, table: RealmNetworkProcess | undefined): Promise<void> {
  if (!table) {
    await proxy.closed;
    return;
  }
  const pm = table.processManager;
  const record = pm.spawn({
    kind: 'net',
    argv: ['http-proxy', `127.0.0.1:${proxy.port}`],
    cwd: '/',
    owner: table.owner,
  });
  const stop = () => proxy.close();
  record.abort.signal.addEventListener('abort', stop, { once: true });
  await proxy.closed;
  record.abort.signal.removeEventListener('abort', stop);
  pm.exit(record.pid, record.abort.signal.aborted ? null : 0);
}
