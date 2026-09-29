/**
 * Page side of the realm-proxy case in `extension-raw-fetch-check.ts`
 * (#3571): what a hosted leader tab runs, with the production modules. A real
 * wasm program (a wasm-realm process in a DedicatedWorker) connects to the
 * realm proxy on its owner's loopback; the proxy forwards over the raw mode
 * of the extension's pinned `fetch-proxy.fetch` Port (`rawFetchViaPort`), and
 * terminates TLS for CONNECT with the Mbed TLS engine and a realm CA.
 *
 * The check bundles this with esbuild and serves it from the dev leader origin
 * (`http://localhost:8787/?slicc=leader`), cross-origin isolated so the
 * process's SharedArrayBuffer bridge works.
 */
import {
  bytesSource,
  FdTable,
  type FdTable as FdTableType,
  sinkFile,
} from '../../webapp/src/kernel/wasm-realm/fd-table.js';
import {
  type SpawnWasmOptions,
  spawnWasmProcess,
} from '../../webapp/src/kernel/wasm-realm/host.js';
import { RealmProxy } from '../../webapp/src/kernel/wasm-realm/net/proxy-service.js';
import { rawFetchTransport } from '../../webapp/src/kernel/wasm-realm/net/raw-transport.js';
import { RealmCa } from '../../webapp/src/kernel/wasm-realm/net/realm-ca.js';
import {
  realmCaEnv,
  realmNetworkEnv,
} from '../../webapp/src/kernel/wasm-realm/net/realm-network.js';
import { TlsEngine } from '../../webapp/src/kernel/wasm-realm/net/tls-engine.js';
import { TlsTerminator } from '../../webapp/src/kernel/wasm-realm/net/tls-tunnel.js';
import { LoopbackNet } from '../../webapp/src/kernel/wasm-realm/socket.js';
import { rawFetchViaPort } from '../../webapp/src/shell/proxied-fetch-raw-port.js';

declare const chrome: {
  runtime: { connect(extensionId: string, info: { name: string }): unknown };
};

export interface RealmRun {
  code: number;
  /** stdout as latin1 (one char per byte). */
  stdout: string;
  stderr: string;
}

export interface RealmSetup {
  /** The extension whose `fetch-proxy.fetch` Port carries the requests. */
  extensionId: string;
  /** The TLS engine's glue and wasm, as served (HTTPS case only). */
  engine?: { glue: string; wasm: string };
}

const CA_FILE = '/home/user/.config/slicc/realm-ca-cone.pem';

/** A read-only filesystem of `files`: what the program may read (the CA bundle). */
function memoryFs(files: Record<string, string>): SpawnWasmOptions['fs'] {
  const bytes = new Map(Object.entries(files).map(([p, c]) => [p, new TextEncoder().encode(c)]));
  const dirs = new Set(['/']);
  for (const p of bytes.keys()) {
    const parts = p.split('/');
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const stat = async (p: string) => {
    const file = bytes.get(p);
    if (!file && !dirs.has(p)) throw enoent(p);
    return {
      isFile: Boolean(file),
      isDirectory: !file,
      isSymbolicLink: false,
      size: file?.length ?? 0,
      mode: file ? 0o100644 : 0o40755,
      mtime: new Date(0),
    };
  };
  return {
    resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
    exists: async (p: string) => bytes.has(p) || dirs.has(p),
    stat,
    lstat: stat,
    readFileBuffer: async (p: string) => {
      const file = bytes.get(p);
      if (!file) throw enoent(p);
      return file;
    },
    readdir: async (p: string) => {
      const prefix = p === '/' ? '/' : `${p}/`;
      const names = [...bytes.keys(), ...dirs]
        .filter((q) => q.startsWith(prefix) && q !== p)
        .map((q) => q.slice(prefix.length).split('/')[0]);
      return [...new Set(names)];
    },
  } as unknown as SpawnWasmOptions['fs'];
}

async function program(glueUrl: string): Promise<{ glue: string; module: WebAssembly.Module }> {
  const wasmUrl = glueUrl.endsWith('.js') ? `${glueUrl.slice(0, -3)}.wasm` : `${glueUrl}.wasm`;
  const [glue, wasm] = await Promise.all([
    fetch(glueUrl).then((r) => r.text()),
    fetch(wasmUrl).then((r) => r.arrayBuffer()),
  ]);
  return { glue, module: await WebAssembly.compile(wasm) };
}

let nextPid = 5000;

/** Run a program to completion with `stdin` on the realm's network. */
function run(
  net: LoopbackNet,
  prog: { glue: string; module: WebAssembly.Module },
  argv0: string,
  args: string[],
  env: Record<string, string>,
  files: Record<string, string>,
  stdin: Uint8Array
): Promise<RealmRun> {
  const out: Uint8Array[] = [];
  const err: string[] = [];
  const fds: FdTableType = new FdTable();
  fds.install(bytesSource(stdin));
  fds.install(sinkFile((b) => out.push(b.slice())));
  fds.install(sinkFile((b) => err.push(new TextDecoder().decode(b))));
  const handle = spawnWasmProcess({
    pid: nextPid++,
    program: prog,
    argv0,
    args,
    env,
    cwd: '/',
    fds,
    fs: memoryFs(files),
    net,
    createWorker: () => new Worker('/process-worker.js'),
    onError: (m) => err.push(m),
  });
  return handle.exited.then((code) => {
    let stdout = '';
    for (const chunk of out) for (const b of chunk) stdout += String.fromCharCode(b);
    return { code, stdout, stderr: err.join('') };
  });
}

/** The leader-side network: one namespace, its proxy over the extension's raw Port. */
export async function setupRealm(setup: RealmSetup) {
  const connect = () => chrome.runtime.connect(setup.extensionId, { name: 'fetch-proxy.fetch' });
  const transport = rawFetchTransport(
    (url, init) => rawFetchViaPort(connect as Parameters<typeof rawFetchViaPort>[0], url, init),
    { supported: true, requestBodyStreaming: true, maxRequestBodyBytes: 64 * 1024 * 1024 }
  );
  const records = new Map();
  const ca = await RealmCa.open('cone:', {
    get: async (o) => records.get(o),
    put: async (o, r) => void records.set(o, r),
  });
  let engine: Promise<TlsEngine> | undefined;
  const tls = new TlsTerminator({
    ca: async () => ca,
    engine: () => {
      const e = setup.engine;
      if (!e) return Promise.reject(new Error('no TLS engine served'));
      engine ??= (async () => {
        const { default: create } = await import(/* @vite-ignore */ e.glue);
        const wasmBinary = await (await fetch(e.wasm)).arrayBuffer();
        return new TlsEngine(await create({ wasmBinary }));
      })();
      return engine;
    },
  });
  const net = new LoopbackNet();
  const proxy = new RealmProxy({ net, transport, tunnel: tls.handler });
  const programs = new Map<string, Promise<{ glue: string; module: WebAssembly.Module }>>();
  const load = (url: string) => {
    let p = programs.get(url);
    if (!p) programs.set(url, (p = program(url)));
    return p;
  };
  return {
    port: proxy.port,
    caPem: ca.pem,
    /** `socktest pipe <host> <port>` with `request` on stdin, through the proxy. */
    async pipe(request: string): Promise<RealmRun> {
      const bytes = Uint8Array.from(request, (c) => c.charCodeAt(0) & 0xff);
      return run(
        net,
        await load('/socktest'),
        'socktest',
        ['pipe', '127.0.0.1', String(proxy.port)],
        {},
        {},
        bytes
      );
    },
    /** A curl with the realm's proxy and CA env (the HTTPS case). */
    async curl(glue: string, args: string[]): Promise<RealmRun> {
      const env = { ...realmNetworkEnv(), ...realmCaEnv(CA_FILE) };
      env.http_proxy = env.https_proxy = `http://127.0.0.1:${proxy.port}`;
      return run(
        net,
        await load(glue),
        'curl',
        ['-q', '-sS', ...args],
        env,
        { [CA_FILE]: ca.pem },
        new Uint8Array(0)
      );
    },
    close: () => proxy.close(),
  };
}

(globalThis as { setupRealm?: typeof setupRealm }).setupRealm = setupRealm;
