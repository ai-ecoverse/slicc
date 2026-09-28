/**
 * `realm-network.ts` — how a wasm realm owner (the cone, each scoop) reaches
 * the outside world (#3571): its loopback namespace gets an HTTP proxy on
 * `127.0.0.1:3128`, started by the first connection to it (socket
 * activation), and native programs get the proxy environment by default.
 *
 * The proxy lives as long as the namespace (the kernel worker), not a `wasm`
 * invocation. It shows in `ps` as a `net` process of its owner; a signal to it
 * stops it, and the next connection starts it again.
 */
import type { ProcessManager, ProcessOwner } from '../../process-manager.js';
import type { LoopbackNet } from '../socket.js';
import { proxiedFetchTransport } from './fetch-transport.js';
import { REALM_PROXY_PORT, RealmProxy, type RealmProxyOptions } from './proxy-service.js';
import type { RealmTransport } from './transport.js';

const PROXY_URL = `http://127.0.0.1:${REALM_PROXY_PORT}`;

/**
 * Names a program reaches without the proxy: the realm's own loopback (curl
 * understands the CIDR; `127.0.0.1` spells it out for clients that do not).
 */
const NO_PROXY = 'localhost,.localhost,127.0.0.1,127.0.0.0/8';

/**
 * The environment a native program starts with, under whatever the caller
 * exports (so an exported `http_proxy`, even an empty one, wins). curl reads
 * the lower-case names (it ignores `HTTP_PROXY`, see httpoxy); other clients
 * read either.
 */
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

/** The process table the proxy registers in (`ps`, `kill`). */
export interface RealmNetworkProcess {
  processManager: ProcessManager;
  owner: ProcessOwner;
}

export interface RealmNetworkOptions {
  /** Registers the running proxy as a `net` process of its owner. */
  process?: RealmNetworkProcess;
  /** The way out; the float's fetch path by default. */
  transport?: () => RealmTransport;
  /** Extra proxy options (CONNECT handling, limits). */
  proxy?: Pick<RealmProxyOptions, 'tunnel' | 'limits'>;
}

/** The namespaces whose proxy is set up, and the proxy running in each. */
const running = new WeakMap<LoopbackNet, { proxy: RealmProxy | undefined }>();

/** The proxy running in `net`, if any (tests, diagnostics). */
export function realmProxy(net: LoopbackNet): RealmProxy | undefined {
  return running.get(net)?.proxy;
}

/**
 * Set up `net`'s proxy: it starts on the first connection to
 * `127.0.0.1:3128`. Idempotent: the first caller's options hold.
 */
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

/** A `net` process for the proxy: its signals stop it, its end exits the record. */
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
