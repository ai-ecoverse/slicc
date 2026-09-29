import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { findChromeExecutable } from '../../node-server/src/chrome-launch.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TOKEN = 'ghp_rawCheckToken0123456789abcd';
const BIG = Buffer.alloc(20 * 1024 * 1024);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 13 + (i >> 9)) & 0xff;

interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  len: number;
  te: string | null;
  text: string;
}

const seen: Seen[] = [];
const RANGE_BODY = Buffer.from('0123456789abcdefghij'.repeat(50));
let bigWritten = 0;

function respond(path: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (path === '/redirect') {
    res.writeHead(302, [
      ['Location', `/next?t=${TOKEN}`],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2; HttpOnly'],
      ['X-Rep', 'x'],
      ['X-Rep', 'y'],
    ]);
    res.end('moved');
  } else if (path === '/tagged') {
    const id = Math.random().toString(36).slice(2);
    res.writeHead(200, { 'X-Id': id, 'Content-Type': 'text/plain' });
    setTimeout(() => res.end(id), Math.random() * 50);
  } else if (path === '/gzip' || path === '/zstd') {
    const plain = `${path.slice(1)} body `.repeat(100);
    const b = path === '/gzip' ? gzipSync(plain) : zstdCompressSync(plain);
    res.writeHead(200, {
      'Content-Encoding': path.slice(1),
      'Content-Length': b.length,
      'Content-Type': 'application/octet-stream',
    });
    res.end(b);
  } else if (path === '/big') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': BIG.length,
    });
    let off = 0;
    const pump = () => {
      while (off < BIG.length) {
        const slice = BIG.subarray(off, off + 64 * 1024);
        off += slice.length;
        bigWritten = off;
        if (!res.write(slice)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  } else if (path === '/range') {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range)) ?? [];
    const gzip = /gzip/.test(String(req.headers['accept-encoding']));
    const representation = gzip ? gzipSync(RANGE_BODY) : RANGE_BODY;
    const slice = representation.subarray(Number(from), Number(to) + 1);
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${from}-${to}/${representation.length}`,
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(slice);
  } else if (path === '/echo') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`auth=${req.headers.authorization ?? ''} body=${body.toString()}`);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ len: body.length }));
  }
}

async function startUpstream(): Promise<{ origin: string; close: () => void }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({
        path,
        headers: req.headers,
        len: body.length,
        te: (req.headers['transfer-encoding'] as string | undefined) ?? null,
        text: body.subarray(0, 200).toString(),
      });
      respond(path, req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function bundleClient(): Promise<string> {
  const out = await build({
    stdin: {
      contents:
        "import { rawFetchViaPort } from './packages/webapp/src/shell/proxied-fetch-raw-port.ts';\n" +
        'globalThis.rawFetchViaPort = rawFetchViaPort;\n',
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  return out.outputFiles[0]!.text;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

declare const rawFetchViaPort: (
  connect: () => unknown,
  url: string,
  init?: {
    method?: string;
    headers?: [string, string][];
    body?: Uint8Array | ReadableStream<Uint8Array>;
  }
) => Promise<{
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream<Uint8Array> | null;
}>;

interface BigDownloadState {
  bigReader: ReadableStreamDefaultReader<Uint8Array>;
  bigHeaders: [string, string][];
  bigParts: Uint8Array[];
}
declare const chrome: {
  runtime: {
    connect(info: { name: string }): unknown;
    sendMessage(msg: unknown): Promise<unknown>;
  };
};

async function main(): Promise<void> {
  const extSrc = join(repoRoot, 'dist/extension');
  const chromePath = findChromeExecutable({ executablePreference: 'chrome-for-testing' });
  if (!existsSync(join(extSrc, 'manifest.json')) || !chromePath) {
    console.error('setup: build the extension (SLICC_EXT_DEV=1) and install Chrome for Testing');
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), 'slicc-raw-fetch-check-'));
  const ext = join(work, 'ext');
  cpSync(extSrc, ext, { recursive: true });
  const profile = join(work, 'profile');
  const upstream = await startUpstream();
  const client = await bundleClient();
  const chromeProc = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const hardStop = setTimeout(() => {
    console.error('setup: timed out');
    chromeProc.kill('SIGKILL');
    process.exit(2);
  }, 180_000);
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++)
      await new Promise((r) => setTimeout(r, 100));
    const cdpPort = readFileSync(portFile, 'utf8').split('\n')[0];
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}` });
    const sw = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'),
      { timeout: 60_000 }
    );
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/secrets.html`);

    await page.evaluate('globalThis.__name = (f) => f');
    await page.evaluate(client);
    await runChecks(page, upstream.origin);
    await browser.disconnect();
  } finally {
    clearTimeout(hardStop);
    chromeProc.kill('SIGKILL');
    upstream.close();
    rmSync(work, { recursive: true, force: true });
  }
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.connect>>['newPage']>>;

async function runChecks(page: Page, origin: string): Promise<void> {
  const redirect = await page.evaluate(async (o) => {
    const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
    const r = await rawFetchViaPort(connect, `${o}/redirect`);
    return { status: r.status, statusText: r.statusText, headers: r.headers, noBody: !r.body };
  }, origin);
  const named = (n: string) =>
    redirect.headers.filter(([h]) => h.toLowerCase() === n).map(([, v]) => v);
  check(
    'manual redirect keeps 302, Location, every Set-Cookie and repeated headers',
    redirect.status === 302 &&
      redirect.statusText === 'Found' &&
      named('location').length === 1 &&
      named('set-cookie').join('|') === 'a=1|b=2; HttpOnly' &&
      named('x-rep').join('|') === 'x|y',
    redirect
  );

  const matched = await page.evaluate(async (o) => {
    const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const r = await rawFetchViaPort(connect, `${o}/tagged`);
        const id = r.headers.find(([n]) => n.toLowerCase() === 'x-id')?.[1];
        return id === (await new Response(r.body).text());
      })
    );
    return results.filter(Boolean).length;
  }, origin);
  check('12 concurrent same-URL fetches keep their own heads', matched === 12, matched);

  const encodings = await page.evaluate(async (o) => {
    const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
    const out: Record<string, { coding: number; text: string }> = {};
    for (const p of ['gzip', 'zstd']) {
      const r = await rawFetchViaPort(connect, `${o}/${p}`);
      out[p] = {
        coding: r.headers.filter(([n]) => /^content-(encoding|length)$/i.test(n)).length,
        text: (await new Response(r.body).text()).slice(0, 9),
      };
    }
    return out;
  }, origin);
  check(
    'gzip and zstd arrive decoded without coding headers',
    encodings.gzip?.coding === 0 &&
      encodings.gzip.text === 'gzip body' &&
      encodings.zstd?.coding === 0 &&
      encodings.zstd.text === 'zstd body',
    encodings
  );

  await page.evaluate(async (o) => {
    const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
    const r = await rawFetchViaPort(connect, `${o}/big`);
    const g = globalThis as unknown as BigDownloadState;
    g.bigReader = r.body!.getReader();
    g.bigHeaders = r.headers;
    g.bigParts = [(await g.bigReader.read()).value!];
  }, origin);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(
    `INFO Chrome read ${(bigWritten / 1048576).toFixed(1)} of ${BIG.length / 1048576} MiB ahead of a stalled reader`
  );
  const big = await page.evaluate(async () => {
    const g = globalThis as unknown as BigDownloadState;
    const reader = g.bigReader;
    const parts = g.bigParts;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const all = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', all);
    const sha = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const length = g.bigHeaders.find(([n]) => n.toLowerCase() === 'content-length')?.[1];
    return { sha, length };
  });
  check(
    '20 MiB binary download is byte-exact and keeps Content-Length',
    big.sha === createHash('sha256').update(BIG).digest('hex') && big.length === String(BIG.length),
    big
  );

  const upload = await page.evaluate(async (o) => {
    const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (n === 12) {
          c.close();
          return;
        }
        if (n % 4 === 0) await new Promise((r) => setTimeout(r, 300));
        c.enqueue(new Uint8Array(1024 * 1024).fill(n));
        n++;
      },
    });
    const r = await rawFetchViaPort(connect, `${o}/upload`, {
      method: 'POST',
      headers: [['Content-Type', 'application/x-git-receive-pack-request']],
      body,
    });
    return new Response(r.body).text();
  }, origin);
  const up = seen.find((s) => s.path === '/upload');
  check(
    '12 MiB binary upload is streamed (chunked) and complete',
    up?.len === 12 * 1024 * 1024 && up.te === 'chunked' && upload === `{"len":${12 * 1024 * 1024}}`,
    { up: up && { len: up.len, te: up.te }, upload }
  );

  const ranged = await page.evaluate(async (o) => {
    const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
    try {
      const r = await rawFetchViaPort(connect, `${o}/range`, {
        headers: [['Range', 'bytes=10-29']],
      });
      const body = new TextDecoder().decode(await new Response(r.body).arrayBuffer());
      const range = r.headers.find(([n]) => n.toLowerCase() === 'content-range')?.[1];
      return { status: r.status, range, body };
    } catch (e) {
      return { error: (e as { code?: string }).code ?? String(e) };
    }
  }, origin);
  const rangeReq = seen.filter((s) => s.path === '/range').at(-1);
  console.log(
    `INFO Chrome sent Accept-Encoding "${rangeReq?.headers['accept-encoding']}" with Range`
  );
  check(
    'a ranged read gets bytes that match its Content-Range, or a clean upstream error',
    ('error' in ranged && ranged.error === 'upstream') ||
      ('body' in ranged &&
        ranged.status === 206 &&
        ranged.body === RANGE_BODY.subarray(10, 30).toString() &&
        ranged.range === `bytes 10-29/${RANGE_BODY.length}`),
    ranged
  );

  await secretChecks(page, origin);
}

async function secretChecks(page: Page, origin: string): Promise<void> {
  const out = await page.evaluate(
    async (o, token) => {
      await chrome.runtime.sendMessage({
        type: 'secrets.session.set',
        name: 'RAW_CHECK_TOKEN',
        value: token,
        domains: [new URL(o).host, '127.0.0.1'],
      });
      const list = (await chrome.runtime.sendMessage({ type: 'secrets.list-masked-entries' })) as
        | { entries?: { name: string; maskedValue: string }[] }
        | { name: string; maskedValue: string }[];
      const entries = Array.isArray(list) ? list : (list.entries ?? []);
      const masked = entries.find((e) => e.name === 'RAW_CHECK_TOKEN')?.maskedValue ?? '';
      const connect = () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
      const r = await rawFetchViaPort(connect, `${o}/echo`, {
        method: 'POST',
        headers: [
          ['Authorization', `Bearer ${masked}`],
          ['Content-Type', 'application/json'],
          ['User-Agent', 'curl/8.22.0'],
          ['Cookie', 'mine=1'],
        ],
        body: new TextEncoder().encode(`{"t":"${masked}"}`),
      });
      const echo = await new Response(r.body).text();
      const redirect = await rawFetchViaPort(connect, `${o}/redirect`);
      const location = redirect.headers.find(([n]) => n.toLowerCase() === 'location')?.[1];
      let foreign = 'no error';
      try {
        await rawFetchViaPort(connect, 'http://localhost:9/x', {
          headers: [['Authorization', `Bearer ${masked}`]],
        });
      } catch (e) {
        foreign = (e as { code?: string }).code ?? String(e);
      }
      return { masked, echo, location, foreign };
    },
    origin,
    TOKEN
  );
  const echoReq = seen.filter((s) => s.path === '/echo').at(-1);
  check(
    'masked secret is unmasked upstream in the header and the text body',
    !!out.masked &&
      echoReq?.headers.authorization === `Bearer ${TOKEN}` &&
      !!echoReq.text.includes(TOKEN),
    {
      auth: echoReq?.headers.authorization === `Bearer ${TOKEN}`,
    }
  );
  check(
    'the real secret is scrubbed from the echoed body and from Location',
    !out.echo.includes(TOKEN) &&
      out.echo.includes(out.masked) &&
      out.location === `/next?t=${out.masked}`,
    { echoLeaks: out.echo.includes(TOKEN), location: out.location === `/next?t=${out.masked}` }
  );
  check(
    'a masked secret on a foreign domain is refused',
    out.foreign === 'forbidden-secret',
    out.foreign
  );
  check(
    'User-Agent and Cookie go upstream as given, without Chrome cookie-jar entries',
    echoReq?.headers['user-agent'] === 'curl/8.22.0' && echoReq.headers.cookie === 'mine=1',
    { ua: echoReq?.headers['user-agent'], cookie: echoReq?.headers.cookie }
  );
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`${failures.length} check(s) failed`);
      process.exit(1);
    }
    console.log('all raw fetch checks passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
