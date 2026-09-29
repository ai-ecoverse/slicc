/**
 * The realm-proxy case of `extension-raw-fetch-check.ts` (#3571): the
 * extension float end to end. A page on the dev leader origin
 * (`http://localhost:8787/?slicc=leader`, cross-origin isolated) runs the
 * production kernel pieces (`extension-realm-proxy-page.ts`): a real wasm
 * program (`socktest pipe`, the committed fixture) sends HTTP/1.x to the realm
 * proxy on its loopback, which forwards over the raw mode of the extension's
 * pinned `fetch-proxy.fetch` Port to the check's upstream.
 *
 * The upstream is addressed as `upstream.test` (Chrome's host-resolver maps it
 * to 127.0.0.1), since the proxy refuses the realm's own loopback by name.
 * With `SLICC_WASM_CURL_TLS` pointing at a TLS-enabled wasm curl, it also runs
 * HTTPS: CONNECT, TLS terminated in the page with the Mbed TLS engine and a
 * realm CA the program trusts, the request forwarded to an HTTPS upstream.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import type puppeteer from 'puppeteer-core';
import { RealmCa } from '../../webapp/src/kernel/wasm-realm/net/realm-ca.js';

type Browser = Awaited<ReturnType<typeof puppeteer.connect>>;
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The dev build's leader origin (`leader-tab-sw.ts`): the SW self-adopts a
 * `?slicc=leader` page there on its first Port. The page is served on an
 * ephemeral port that Chrome's host resolver puts behind this origin, so the
 * check never needs 8787 itself (a local dev harness usually holds it).
 */
const LEADER_PORT = 8787;
const REALM_TOKEN = 'ghp_realmCheckToken0123456789ab';

export interface RealmCaseDeps {
  repoRoot: string;
  browser: Browser;
  extensionId: string;
  /** The options page (extension origin), for the secret store messages. */
  optionsPage: Awaited<ReturnType<Browser['newPage']>>;
  upstreamPort: number;
  /** The upstream's request handler, served again over TLS for the HTTPS case. */
  handler: Handler;
  /** What the upstream saw, newest last. */
  seen: Array<{ path: string; headers: IncomingMessage['headers'] }>;
  rangeBody: Buffer;
  check: (name: string, ok: boolean, detail: unknown) => void;
}

export interface RealmCase {
  /** Chrome flags: the upstream's name, the leader origin's port, trust in the TLS upstream's leaf. */
  chromeArgs: string[];
  run(deps: RealmCaseDeps): Promise<void>;
  close(): void;
}

async function bundle(entry: string, repoRoot: string): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    absWorkingDir: repoRoot,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    // The webapp's own build constants (packages/webapp/vite.config.ts).
    define: { __DEV__: 'false', global: 'globalThis' },
    write: false,
    logLevel: 'silent',
  });
  return out.outputFiles[0]!.text;
}

const ISOLATED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
};

/** The leader origin: the page, its bundles, and the programs it runs (on an ephemeral port). */
async function startLeader(
  files: Map<string, { type: string; body: string | Buffer }>
): Promise<Server> {
  const server = createHttpServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = files.get(path);
    if (!file) {
      res.writeHead(404, ISOLATED).end();
      return;
    }
    res.writeHead(200, { ...ISOLATED, 'Content-Type': file.type }).end(file.body);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  return server;
}

/** An HTTPS upstream with a leaf for `upstream.test` (Chrome runs with certificate errors ignored). */
async function startTlsUpstream(handler: Handler): Promise<{ server: Server; port: number }> {
  const ca = await RealmCa.open('tls-upstream', {
    get: async () => undefined,
    put: async () => undefined,
  });
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const der = await ca.issue('upstream.test', spki);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = (label: string, b: Buffer) =>
    `-----BEGIN ${label}-----\n${b
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n')}\n-----END ${label}-----\n`;
  const server = createHttpsServer(
    { key: pem('PRIVATE KEY', pkcs8), cert: pem('CERTIFICATE', Buffer.from(der)) + ca.pem },
    handler
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

/** Status line, fields and body of an HTTP/1.x response a program printed. */
function parse(raw: string) {
  const end = raw.indexOf('\r\n\r\n');
  const lines = raw.slice(0, end).split('\r\n');
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '')?.[1]);
  const fields = lines
    .slice(1)
    .map(
      (l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const
    );
  const field = (n: string) => fields.filter(([k]) => k === n).map(([, v]) => v);
  return { status, field, body: end < 0 ? '' : raw.slice(end + 4) };
}

/**
 * A session secret scoped to the bare hostname `upstream.test`, and its mask:
 * every float matches a secret's domains against the URL's hostname, so it
 * covers the upstream's `upstream.test:<port>` URLs too (#3606).
 */
async function maskedSecret(
  deps: RealmCaseDeps,
  name: string,
  token: string,
  domains: string[]
): Promise<string> {
  return deps.optionsPage.evaluate(
    async (name, token, domains) => {
      const runtime = (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
        }
      ).chrome.runtime;
      await runtime.sendMessage({ type: 'secrets.session.set', name, value: token, domains });
      const list = (await runtime.sendMessage({ type: 'secrets.list-masked-entries' })) as
        | { entries?: { name: string; maskedValue: string }[] }
        | { name: string; maskedValue: string }[];
      const entries = Array.isArray(list) ? list : (list.entries ?? []);
      return entries.find((e) => e.name === name)?.maskedValue ?? '';
    },
    name,
    token,
    domains
  );
}

/** Serve the leader origin and the TLS upstream before Chrome starts (it needs their ports). */
export async function prepareRealmCase(repoRoot: string, handler: Handler): Promise<RealmCase> {
  const fixture = join(repoRoot, 'packages/webapp/tests/fixtures/wasm-sockets/socktest');
  const engineDir = dirname(
    resolve(repoRoot, 'node_modules/@ai-ecoverse/wasm-tls-engine/dist/slicc-tls-engine.mjs')
  );
  const curlTls = process.env.SLICC_WASM_CURL_TLS;
  const files = new Map<string, { type: string; body: string | Buffer }>([
    [
      '/',
      {
        type: 'text/html',
        body: '<!doctype html><title>realm leader</title><script type="module" src="/realm-page.js"></script>',
      },
    ],
    [
      '/realm-page.js',
      {
        type: 'text/javascript',
        body: await bundle('packages/dev-tools/tools/extension-realm-proxy-page.ts', repoRoot),
      },
    ],
    [
      '/process-worker.js',
      {
        type: 'text/javascript',
        body: await bundle('packages/webapp/src/kernel/wasm-realm/process-worker.ts', repoRoot),
      },
    ],
    ['/socktest', { type: 'text/javascript', body: readFileSync(fixture) }],
    ['/socktest.wasm', { type: 'application/wasm', body: readFileSync(`${fixture}.wasm`) }],
    [
      '/tls/engine.mjs',
      { type: 'text/javascript', body: readFileSync(join(engineDir, 'slicc-tls-engine.mjs')) },
    ],
    [
      '/tls/engine.wasm',
      { type: 'application/wasm', body: readFileSync(join(engineDir, 'slicc-tls-engine.wasm')) },
    ],
  ]);
  const https = Boolean(curlTls && existsSync(curlTls));
  if (curlTls && https) {
    files.set('/curl.js', { type: 'text/javascript', body: readFileSync(curlTls) });
    files.set('/curl.wasm', {
      type: 'application/wasm',
      body: readFileSync(curlTls.replace(/\.js$/, '.wasm')),
    });
  }
  const leader = await startLeader(files);
  const address = leader.address();
  const leaderPort = typeof address === 'object' && address ? address.port : 0;
  const tlsUpstream = https ? await startTlsUpstream(handler) : undefined;
  return {
    chromeArgs: [
      `--host-resolver-rules=MAP upstream.test 127.0.0.1, MAP localhost:${LEADER_PORT} 127.0.0.1:${leaderPort}`,
      '--ignore-certificate-errors',
    ],
    run: (deps) => realmProxyChecks(deps, tlsUpstream?.port),
    close: () => {
      leader.close();
      tlsUpstream?.server.close();
    },
  };
}

async function realmProxyChecks(deps: RealmCaseDeps, tlsPort: number | undefined): Promise<void> {
  const { check } = deps;
  const page = await deps.browser.newPage();
  try {
    page.on('pageerror', (e) => console.log(`INFO leader page error: ${e}`));
    await page.goto(`http://localhost:${LEADER_PORT}/?slicc=leader`);
    await page.waitForFunction('typeof globalThis.setupRealm === "function"', { timeout: 30_000 });
    const isolated = await page.evaluate('globalThis.crossOriginIsolated');
    check(
      'realm proxy: the leader page is cross-origin isolated (SharedArrayBuffer)',
      isolated === true,
      isolated
    );
    await page.evaluate(async (extensionId) => {
      const g = globalThis as unknown as {
        setupRealm: (s: unknown) => Promise<unknown>;
        realm: unknown;
      };
      g.realm = await g.setupRealm({
        extensionId,
        engine: { glue: '/tls/engine.mjs', wasm: '/tls/engine.wasm' },
      });
    }, deps.extensionId);
    const masked = await maskedSecret(deps, 'REALM_CHECK_TOKEN', REALM_TOKEN, ['upstream.test']);
    await httpChecks(deps, page, masked);
    if (tlsPort !== undefined) await httpsChecks(deps, page, masked, tlsPort);
    else
      console.log(
        'INFO realm proxy HTTPS skipped: set SLICC_WASM_CURL_TLS to a TLS-enabled wasm curl'
      );
  } finally {
    await page.close().catch(() => undefined);
  }
}

type Page = Awaited<ReturnType<Browser['newPage']>>;
interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function pipe(page: Page, request: string): Promise<Run> {
  return page.evaluate(
    (r) => (globalThis as unknown as { realm: { pipe(r: string): Promise<Run> } }).realm.pipe(r),
    request
  );
}

async function httpChecks(deps: RealmCaseDeps, page: Page, masked: string): Promise<void> {
  const { check, upstreamPort, seen } = deps;
  const base = `http://upstream.test:${upstreamPort}`;

  const redirect = await pipe(page, `GET ${base}/redirect HTTP/1.0\r\n\r\n`);
  const r = parse(redirect.stdout);
  check(
    'realm proxy: a program gets the 302 with its Location and each Set-Cookie on its own line',
    redirect.code === 0 &&
      r.status === 302 &&
      r.field('location').length === 1 &&
      r.field('set-cookie').join('|') === 'a=1|b=2; HttpOnly',
    { code: redirect.code, stderr: redirect.stderr, head: redirect.stdout.slice(0, 400) }
  );

  const ranged = await pipe(page, `GET ${base}/range HTTP/1.0\r\nRange: bytes=10-29\r\n\r\n`);
  const g = parse(ranged.stdout);
  check(
    'realm proxy: a ranged read reaches the program as a byte-exact 206',
    g.status === 206 &&
      g.field('content-range')[0] === `bytes 10-29/${deps.rangeBody.length}` &&
      g.field('content-encoding').length === 0 &&
      g.body === deps.rangeBody.subarray(10, 30).toString('latin1'),
    { status: g.status, range: g.field('content-range'), body: g.body, stderr: ranged.stderr }
  );

  const body = `{"t":"${masked}"}`;
  const echo = await pipe(
    page,
    `POST ${base}/echo HTTP/1.0\r\nAuthorization: Bearer ${masked}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
  );
  const echoReq = seen.filter((s) => s.path === '/echo').at(-1);
  check(
    'realm proxy: a masked secret header reaches the upstream unmasked',
    !!masked && echoReq?.headers.authorization === `Bearer ${REALM_TOKEN}`,
    { masked: !!masked, unmasked: echoReq?.headers.authorization === `Bearer ${REALM_TOKEN}` }
  );
  check(
    'realm proxy: the program sees only the mask in the echoed response',
    !echo.stdout.includes(REALM_TOKEN) &&
      !echo.stderr.includes(REALM_TOKEN) &&
      echo.stdout.includes(`auth=Bearer ${masked}`),
    { leaks: echo.stdout.includes(REALM_TOKEN), echoed: parse(echo.stdout).body.slice(0, 120) }
  );
}

async function httpsChecks(
  deps: RealmCaseDeps,
  page: Page,
  masked: string,
  tlsPort: number
): Promise<void> {
  const { check } = deps;
  const base = `https://upstream.test:${tlsPort}`;
  const curl = (args: string[]) =>
    page.evaluate(
      (a) =>
        (
          globalThis as unknown as { realm: { curl(g: string, a: string[]): Promise<Run> } }
        ).realm.curl('/curl.js', a),
      args
    );
  const redirect = await curl(['-i', `${base}/redirect`]);
  const r = parse(redirect.stdout.replace(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/, ''));
  check(
    'realm proxy HTTPS: through CONNECT and TLS termination the program gets the 302 and both cookies',
    redirect.code === 0 &&
      r.status === 302 &&
      r.field('set-cookie').join('|') === 'a=1|b=2; HttpOnly',
    { code: redirect.code, stderr: redirect.stderr, head: redirect.stdout.slice(0, 300) }
  );
  const ranged = await curl(['-r', '10-29', `${base}/range`]);
  check(
    'realm proxy HTTPS: a ranged read is byte-exact',
    ranged.code === 0 && ranged.stdout === deps.rangeBody.subarray(10, 30).toString('latin1'),
    { code: ranged.code, out: ranged.stdout, stderr: ranged.stderr }
  );
  const echo = await curl(['-H', `Authorization: Bearer ${masked}`, `${base}/echo`]);
  const echoReq = deps.seen.filter((s) => s.path === '/echo').at(-1);
  check(
    'realm proxy HTTPS: the secret is unmasked upstream and masked in the program output',
    echoReq?.headers.authorization === `Bearer ${REALM_TOKEN}` &&
      !echo.stdout.includes(REALM_TOKEN) &&
      echo.stdout.includes(`auth=Bearer ${masked}`),
    { code: echo.code, out: echo.stdout.slice(0, 120), stderr: echo.stderr }
  );
}
