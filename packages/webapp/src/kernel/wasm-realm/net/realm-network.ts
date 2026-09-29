import type { ProcessManager, ProcessOwner } from '../../process-manager.js';
import type { LoopbackNet } from '../socket.js';
import { REALM_PROXY_PORT, RealmProxy, type RealmProxyOptions } from './proxy-service.js';
import { realmFetchTransport } from './raw-transport.js';
import { realmCa } from './realm-ca.js';
import { loadTlsEngine } from './tls-engine.js';
import { TlsTerminator, type TlsTerminatorOptions } from './tls-tunnel.js';
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

  proxy?: Pick<RealmProxyOptions, 'limits'>;

  tls?: { owner: string } | TlsTerminatorOptions | false;
}

function terminator(tls: RealmNetworkOptions['tls']): TlsTerminator | undefined {
  if (!tls) return undefined;
  if ('ca' in tls) return new TlsTerminator(tls);
  return new TlsTerminator({ ca: () => realmCa(tls.owner), engine: () => loadTlsEngine() });
}

const running = new WeakMap<LoopbackNet, { proxy: RealmProxy | undefined }>();

export function realmProxy(net: LoopbackNet): RealmProxy | undefined {
  return running.get(net)?.proxy;
}

const CA_FILE_MARK = '/.config/slicc/realm-ca-';

function fileSafe(owner: string): string {
  return owner.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+$/, '');
}

export function realmCaPath(home: string, owner: string): string {
  return `${home.replace(/\/+$/, '')}${CA_FILE_MARK}${fileSafe(owner)}.pem`;
}

export function realmCaEnv(path: string): Record<string, string> {
  return { SSL_CERT_FILE: path, CURL_CA_BUNDLE: path, GIT_SSL_CAINFO: path };
}

const GIT_CONFIG_MARK = '/.config/slicc/gitconfig';

export function realmGitConfigPath(home: string): string {
  return `${home.replace(/\/+$/, '')}${GIT_CONFIG_MARK}`;
}

export interface GitIdentity {
  name: string;
  email: string;
}

function gitValue(value: string): string {
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export function realmGitConfig(identity?: GitIdentity): string {
  const lines = ['[credential]', '\thelper = slicc'];
  if (identity) {
    lines.push(
      '[user]',
      `\tname = ${gitValue(identity.name)}`,
      `\temail = ${gitValue(identity.email)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function ensureRealmGitConfig(
  fs: CaFileSystem,
  path: string,
  identity?: GitIdentity
): Promise<Record<string, string>> {
  try {
    const content = realmGitConfig(identity);
    const current = (await fs.exists(path)) ? await fs.readFile(path) : undefined;
    if (current !== content) {
      await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(path, content);
    }
    return { GIT_CONFIG_SYSTEM: path };
  } catch {
    return {};
  }
}

export function isRealmDefault(name: string, value: string): boolean {
  const proxy = realmNetworkEnv();
  if (name in proxy) return proxy[name] === value;
  if (name === 'GIT_CONFIG_SYSTEM') return value.endsWith(GIT_CONFIG_MARK);
  return name in realmCaEnv('') && value.includes(CA_FILE_MARK);
}

export interface CaFileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
}

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

export function enableRealmNetwork(net: LoopbackNet, options: RealmNetworkOptions = {}): void {
  if (running.has(net)) return;
  const state: { proxy: RealmProxy | undefined } = { proxy: undefined };
  running.set(net, state);
  let transport: RealmTransport | undefined;
  net.activate({ family: 'inet', host: '127.0.0.1', port: REALM_PROXY_PORT }, () => {
    transport ??= (options.transport ?? realmFetchTransport)();
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
