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
import { realmCa } from './realm-ca.js';
import { loadTlsEngine } from './tls-engine.js';
import { TlsTerminator, type TlsTerminatorOptions } from './tls-tunnel.js';
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
  /** Extra proxy options (limits). */
  proxy?: Pick<RealmProxyOptions, 'limits'>;
  /**
   * TLS termination of CONNECT tunnels: the owner (an `ownerKey`) whose CA
   * issues the leaves, or the CA and engine themselves (tests). `false`:
   * CONNECT is refused (501).
   */
  tls?: { owner: string } | TlsTerminatorOptions | false;
}

function terminator(tls: RealmNetworkOptions['tls']): TlsTerminator | undefined {
  if (!tls) return undefined;
  if ('ca' in tls) return new TlsTerminator(tls);
  return new TlsTerminator({ ca: () => realmCa(tls.owner), engine: () => loadTlsEngine() });
}

/** The namespaces whose proxy is set up, and the proxy running in each. */
const running = new WeakMap<LoopbackNet, { proxy: RealmProxy | undefined }>();

/** The proxy running in `net`, if any (tests, diagnostics). */
export function realmProxy(net: LoopbackNet): RealmProxy | undefined {
  return running.get(net)?.proxy;
}

/** Where every owner's CA file lives, whatever the home: how its variables are recognized. */
const CA_FILE_MARK = '/.config/slicc/realm-ca-';

/** Characters an owner key may keep in a file name. */
function fileSafe(owner: string): string {
  return owner.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+$/, '');
}

/** Where an owner's CA certificate lives on the VFS: under its home, named for it. */
export function realmCaPath(home: string, owner: string): string {
  return `${home.replace(/\/+$/, '')}${CA_FILE_MARK}${fileSafe(owner)}.pem`;
}

/** The certificate-bundle variables curl, libcurl, OpenSSL and git read. */
export function realmCaEnv(path: string): Record<string, string> {
  return { SSL_CERT_FILE: path, CURL_CA_BUNDLE: path, GIT_SSL_CAINFO: path };
}

/**
 * Whether `name=value` is one of the defaults a program gets from the realm
 * (the proxy, the CA bundle), as opposed to something exported on purpose.
 */
export function isRealmDefault(name: string, value: string): boolean {
  const proxy = realmNetworkEnv();
  if (name in proxy) return proxy[name] === value;
  return name in realmCaEnv('') && value.includes(CA_FILE_MARK);
}

/** The filesystem the certificate is written through (the invoking shell's). */
export interface CaFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
}

/**
 * Write `owner`'s CA certificate (public; the key never leaves WebCrypto) to
 * `path` unless it is there already, and answer the variables that point at
 * it; none when the CA or the file cannot be had (HTTPS then fails
 * verification, which says why).
 */
export async function ensureRealmCaFile(
  fs: CaFileSystem,
  path: string,
  owner: string,
  ca = realmCa
): Promise<Record<string, string>> {
  try {
    const { pem } = await ca(owner);
    const current = (await fs.exists(path)) ? await fs.readFile(path) : undefined;
    if (current !== pem) {
      await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(path, pem);
    }
    return realmCaEnv(path);
  } catch {
    return {};
  }
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
    const tls = terminator(options.tls);
    const proxy = new RealmProxy({ net, transport, tunnel: tls?.handler, ...options.proxy });
    state.proxy = proxy;
    const done = supervise(proxy, options.process);
    void done.then(async () => {
      if (state.proxy === proxy) state.proxy = undefined;
      await tls?.close();
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
