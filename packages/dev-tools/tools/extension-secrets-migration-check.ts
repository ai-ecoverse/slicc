/**
 * Real-browser check of the extension's encrypted secret storage (#3980) and
 * the secrets page's Re-enter flow (#3994), through public surfaces only:
 * the `secrets.html` page UI, its `chrome.runtime` messages, the
 * `fetch-proxy.fetch` Port, and an upstream server that sees what the
 * extension actually sends.
 *
 * Flow, in one throwaway Chrome for Testing profile:
 *  A. Install the released 6.248.11 build (same extension id, same key),
 *     store a custom secret and an S3 profile through its secrets page.
 *     Control: storage holds plaintext; the fetch proxy unmasks upstream;
 *     S3 mount signing produces a SigV4 signature the upstream verifies.
 *  B. Update in place to the current build (`dist/extension`, production
 *     build so the key and id match) and reload the extension. The service
 *     worker must run the new code; every secret is ciphertext; no plaintext
 *     anywhere in `chrome.storage.local`; the fetch proxy and mount signing
 *     still work; a secret added after the update is ciphertext from the
 *     first write.
 *  C. Restart the browser: the same checks hold (the key persisted).
 *  D. Re-enter: an unreadable entry shows the exact copy and a Re-enter
 *     button (readable rows, the control, have none); Re-enter opens the
 *     Custom secret tab with name and domains prefilled and the value empty;
 *     saving a value makes the secret readable and injectable again.
 *
 * Usage:
 *   npm run build -w @slicc/chrome-extension        # production build
 *   npm run test:secrets-migration -w @slicc/chrome-extension
 *
 * Environment: CHROME_PATH overrides the browser; SECRETS_OLD_EXT points at an
 * unpacked old build (default: download the v6.248.11 release asset);
 * SECRETS_CDP_PORT the DevTools port (default 9463; never 9222-9229).
 * Exit codes: 0 all checks passed; 1 a check failed; 2 setup failed.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { findChromeExecutable } from '../../node-server/src/chrome-launch.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OLD_RELEASE =
  'https://github.com/ai-ecoverse/slicc/releases/download/v6.248.11/sliccy-extension-v6.248.11.zip';
const TOKEN = 'ghp_migrationCheckToken0123456789ab';
const AKID = 'AKIAMIGRATIONCHECK01';
const SAK = 'migrationCheckSecretAccessKey/0123456789';
const NEW_TOKEN = 'ghp_addedAfterTheUpdate98765432100';
const REENTERED = 'ghp_reenteredAfterKeyLoss1234567890';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}
const seen: Seen[] = [];
/** Every Chrome this check started, killed on exit. */
const live = new Set<ChildProcess>();

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    res.writeHead(200, { 'content-type': 'text/plain', ...cors });
    res.end(`auth=${req.headers.authorization ?? ''}`);
  });
}

/** Verify an S3 SigV4 Authorization header against the known secret key. */
function sigv4Valid(r: Seen): { ok: boolean; why: string } {
  const auth = String(r.headers.authorization ?? '');
  const m =
    /AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})/.exec(
      auth
    );
  if (!m) return { ok: false, why: `no SigV4: ${auth}` };
  const [, akid, date, region, signedHeaders, signature] = m as unknown as string[];
  const u = new URL(r.url, 'http://x');
  const query = [...u.searchParams]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const names = (signedHeaders ?? '').split(';');
  const canonHeaders = names
    .map(
      (n) =>
        `${n}:${String(r.headers[n] ?? '')
          .trim()
          .replace(/\s+/g, ' ')}\n`
    )
    .join('');
  const payload = String(
    r.headers['x-amz-content-sha256'] ?? createHash('sha256').update(r.body).digest('hex')
  );
  const canonical = [r.method, u.pathname, query, canonHeaders, signedHeaders, payload].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const sts = [
    'AWS4-HMAC-SHA256',
    String(r.headers['x-amz-date']),
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const h = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
  const kSign = h(h(h(h(`AWS4${SAK}`, date ?? ''), region ?? ''), 's3'), 'aws4_request');
  const expected = createHmac('sha256', kSign).update(sts).digest('hex');
  return {
    ok: akid === AKID && expected === signature,
    why: `akid=${akid} signatureMatches=${expected === signature}`,
  };
}

async function bundleRawFetchClient(): Promise<string> {
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
  return out.outputFiles[0]?.text ?? '';
}

interface Session {
  browser: Browser;
  proc: ChildProcess;
  page: Page;
  extId: string;
  close: () => Promise<void>;
}

async function launch(
  chromePath: string,
  profile: string,
  ext: string,
  port: number,
  extId: string
): Promise<Session> {
  // Never attach to a stray browser that already owns the port.
  const taken = await fetch(`http://127.0.0.1:${port}/json/version`).then(
    () => true,
    () => false
  );
  if (taken) throw new Error(`DevTools port ${port} is already in use`);
  const proc = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--ignore-certificate-errors',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      'about:blank',
    ],
    { stdio: process.env['SECRETS_DEBUG'] ? 'inherit' : 'ignore' }
  );
  live.add(proc);
  let browser: Browser | undefined;
  for (let i = 0; i < 300 && !browser; i++) {
    browser = await puppeteer
      .connect({ browserURL: `http://127.0.0.1:${port}` })
      .catch(() => undefined);
    if (!browser) await sleep(200);
  }
  if (!browser) throw new Error('could not reach Chrome');
  if (process.env['SECRETS_DEBUG']) console.log('info connected');
  const isWorker = (t: { type(): string; url(): string }) =>
    t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`);
  // A fresh install starts the worker on its own; after an update it may stay
  // lazy until a page wakes it, so don't insist on it before opening the page.
  await browser.waitForTarget(isWorker, { timeout: 15_000 }).catch(() => undefined);
  const page = await browser.newPage();
  // Right after start-up the extension may not be registered yet.
  for (let i = 0; ; i++) {
    const ok = await page.goto(`chrome-extension://${extId}/secrets.html`).then(
      () => true,
      () => false
    );
    if (ok) break;
    if (i >= 50) {
      const diag = await browser.newPage();
      await diag.goto('chrome://extensions').catch(() => {});
      const info = await diag
        .evaluate(
          () =>
            new Promise((r) =>
              (globalThis as any).chrome.developerPrivate.getExtensionsInfo(
                { includeDisabled: true, includeTerminated: true },
                r
              )
            )
        )
        .catch((e) => String(e));
      throw new Error(`the extension never loaded: ${JSON.stringify(info).slice(0, 1500)}`);
    }
    await sleep(300);
  }
  await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`),
    { timeout: 60_000 }
  );
  await sleep(800);
  const b = browser;
  return {
    browser: b,
    proc,
    page,
    extId,
    close: async () => {
      await b.disconnect().catch(() => {});
      await stopChrome(proc);
    },
  };
}

/** Does the running service worker carry the encrypted-storage code? */
async function workerHasEncryptedStorage(browser: Browser): Promise<boolean> {
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/service-worker.js')
  );
  const session = await sw.createCDPSession();
  const scripts: Array<{ url: string; scriptId: string }> = [];
  session.on('Debugger.scriptParsed', (e) => scripts.push(e));
  await session.send('Debugger.enable');
  await sleep(300);
  const main = scripts.find((e) => e.url.endsWith('service-worker.js'));
  const src = main
    ? (await session.send('Debugger.getScriptSource', { scriptId: main.scriptId })).scriptSource
    : '';
  await session.detach().catch(() => {});
  return src.includes('aes-gcm-secrets');
}

/** What `chrome.storage.local` holds: secret name → plaintext (old) or `{ ct, iv }` (new). */
interface StoredItems {
  [key: string]: string | { ct: string; iv: string } | undefined;
}

declare const chrome: {
  storage: {
    local: { get(k: null): Promise<StoredItems>; set(v: object): Promise<void> };
  };
  runtime: {
    sendMessage(m: unknown): Promise<any>;
    connect(i: { name: string }): unknown;
    reload(): void;
  };
};
declare const rawFetchViaPort: (
  connect: () => unknown,
  url: string,
  init?: { headers?: [string, string][] }
) => Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;

const dump = (page: Page) => page.evaluate(() => chrome.storage.local.get(null));

async function fillAndSave(
  page: Page,
  values: Record<string, string>,
  button: string
): Promise<void> {
  await page.evaluate(
    (v, btn) => {
      for (const [id, value] of Object.entries(v)) {
        const el = document.getElementById(id) as HTMLInputElement;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      (document.getElementById(btn) as HTMLButtonElement).click();
    },
    values,
    button
  );
  await sleep(800);
}

/** Fetch-proxy injection + S3 signing, through the extension's public surfaces. */
async function functional(
  label: string,
  page: Page,
  client: string,
  up: string,
  name: string,
  real: string
): Promise<void> {
  await page.evaluate('globalThis.__name = (f) => f');
  await page.evaluate(client);
  const out = await page.evaluate(
    async (upstream, secretName) => {
      const list = await chrome.runtime.sendMessage({ type: 'secrets.list-masked-entries' });
      const entries = (Array.isArray(list) ? list : (list?.entries ?? [])) as Array<{
        name: string;
        maskedValue: string;
      }>;
      const masked = entries.find((e) => e.name === secretName)?.maskedValue ?? '';
      const r = await rawFetchViaPort(
        () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' }),
        `${upstream}/echo?n=${secretName}`,
        { headers: [['Authorization', `Bearer ${masked}`]] }
      );
      const text = r.body ? await new Response(r.body).text() : '';
      return { masked, status: r.status, text };
    },
    up,
    name
  );
  const echo = seen.filter((r) => r.url === `/echo?n=${name}`).at(-1);
  check(
    `${label}: fetch proxy injects the real ${name} upstream`,
    !!out.masked && out.masked !== real && echo?.headers.authorization === `Bearer ${real}`,
    `status=${out.status}`
  );
  check(`${label}: the response is re-masked`, !out.text.includes(real));
}

async function s3Signing(label: string, page: Page): Promise<void> {
  const before = seen.length;
  const reply = await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'mount.s3-sign-and-forward',
      envelope: { profile: 'mig', method: 'GET', bucket: 'bkt', key: 'some/key.txt' },
    })
  );
  const req = seen.slice(before).find((r) => r.url.includes('/bkt/some/key.txt'));
  const v = req
    ? sigv4Valid(req)
    : { ok: false, why: `no upstream request: ${JSON.stringify(reply).slice(0, 200)}` };
  check(`${label}: S3 mount signing uses the stored key (SigV4 verified upstream)`, v.ok, v.why);
}

async function noPlaintext(label: string, page: Page): Promise<void> {
  const d = await dump(page);
  const json = JSON.stringify(d);
  const isCipher = (v: unknown) =>
    !!v && typeof v === 'object' && 'ct' in (v as object) && 'iv' in (v as object);
  check(`${label}: MIG_TOKEN is ciphertext`, isCipher(d['MIG_TOKEN']));
  check(`${label}: the S3 secret key is ciphertext`, isCipher(d['s3.mig.secret_access_key']));
  for (const [what, plain] of [
    ['MIG_TOKEN', TOKEN],
    ['the S3 secret key', SAK],
    ['the S3 key id', AKID],
    ['MIG_NEW', NEW_TOKEN],
  ] as const) {
    check(`${label}: no plaintext ${what} anywhere in chrome.storage.local`, !json.includes(plain));
  }
  check(`${label}: _DOMAINS stay plaintext`, d['MIG_TOKEN_DOMAINS'] === '127.0.0.1');
}

async function reenter(page: Page, client: string, up: string): Promise<void> {
  // An entry whose ciphertext no key can decrypt (as after the key was lost).
  await page.evaluate(() =>
    chrome.storage.local.set({
      LOST_TOKEN: { ct: 'AAAAAAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAA' },
      LOST_TOKEN_DOMAINS: '127.0.0.1',
    })
  );
  await page.reload();
  await sleep(800);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.secret-row')].map((r) => ({
      name: r.dataset['name'],
      note: r.querySelector('.secret-unreadable')?.textContent ?? null,
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent),
    }))
  );
  const normal = rows.find((r) => r.name === 'MIG_TOKEN');
  const lost = rows.find((r) => r.name === 'LOST_TOKEN');
  check(
    'D control: a readable row has no Re-enter and no warning',
    !!normal && normal.note === null && !normal.buttons.includes('Re-enter'),
    JSON.stringify(normal)
  );
  check(
    'D: the unreadable row shows the exact copy',
    lost?.note === "This value can't be read any more. Enter it again.",
    String(lost?.note)
  );
  check(
    'D: the unreadable row has Re-enter, Copy name, Delete',
    JSON.stringify(lost?.buttons) === '["Re-enter","Copy name","Delete"]',
    JSON.stringify(lost?.buttons)
  );
  await page.evaluate(() =>
    [...document.querySelectorAll<HTMLButtonElement>('.secret-row-unreadable button')]
      .find((b) => b.textContent === 'Re-enter')
      ?.click()
  );
  const form = await page.evaluate(() => ({
    pane: document.querySelector('.pane.active')?.id,
    name: (document.getElementById('c-name') as HTMLInputElement).value,
    domains: (document.getElementById('c-domains') as HTMLInputElement).value,
    value: (document.getElementById('c-value') as HTMLInputElement).value,
  }));
  check(
    'D: Re-enter opens Custom secret with name + domains, value empty',
    form.pane === 'pane-custom' &&
      form.name === 'LOST_TOKEN' &&
      form.domains === '127.0.0.1' &&
      form.value === '',
    JSON.stringify(form)
  );
  await fillAndSave(page, { 'c-value': REENTERED }, 'c-save');
  const after = await page.evaluate(() => document.getElementById('list')?.innerText ?? '');
  check(
    'D: after saving, the row is readable again',
    after.includes('LOST_TOKEN') && !/can't be read/.test(after)
  );
  await functional('D', page, client, up, 'LOST_TOKEN', REENTERED);
}

/** Stop a Chrome and wait until it has exited (so the profile and port are free). */
async function stopChrome(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 8000);
  await exited;
  clearTimeout(timer);
  live.delete(proc);
  await sleep(500);
}

/** Start once, let the (cached) old worker call chrome.runtime.reload(), stop. */
async function reloadFromOldWorker(
  chromePath: string,
  profile: string,
  ext: string,
  port: number,
  extId: string
): Promise<void> {
  const proc = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--headless=new',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      'about:blank',
    ],
    { stdio: process.env['SECRETS_DEBUG'] ? 'inherit' : 'ignore' }
  );
  live.add(proc);
  let browser: Browser | undefined;
  for (let i = 0; i < 300 && !browser; i++) {
    browser = await puppeteer
      .connect({ browserURL: `http://127.0.0.1:${port}` })
      .catch(() => undefined);
    if (!browser) await sleep(200);
  }
  if (!browser) throw new Error('could not reach Chrome');
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`),
    { timeout: 60_000 }
  );
  void sw;
  // chrome://extensions' own reload: re-reads the unpacked files and
  // re-registers the service worker from them (a plain restart keeps the
  // previously registered worker script).
  const page = await browser.newPage();
  await page.goto('chrome://extensions');
  // A reloaded unpacked extension counts as a developer extension.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        (globalThis as any).chrome.developerPrivate.updateProfileConfiguration(
          { inDeveloperMode: true },
          () => resolve()
        )
      )
  );
  const reloaded = await page
    .evaluate(
      (id) =>
        new Promise<string>((resolve) => {
          const dp = (
            globalThis as unknown as {
              chrome: { developerPrivate: { reload(i: string, o: object, cb: () => void): void } };
            }
          ).chrome.developerPrivate;
          dp.reload(id, { failQuietly: false }, () => resolve('reloaded'));
        }),
      extId
    )
    .catch((err) => String(err));
  if (process.env['SECRETS_DEBUG']) console.log('info reload:', reloaded);
  await sleep(3000);
  await browser.disconnect().catch(() => {});
  await stopChrome(proc);
}

async function oldBuild(work: string): Promise<string> {
  const given = process.env['SECRETS_OLD_EXT'];
  if (given) return given;
  const zip = join(work, 'old.zip');
  const res = await fetch(OLD_RELEASE);
  if (!res.ok) throw new Error(`download ${OLD_RELEASE}: ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const dir = join(work, 'old');
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
  return dir;
}

async function main(): Promise<void> {
  const newBuild = join(repoRoot, 'dist/extension');
  const chromePath =
    process.env['CHROME_PATH'] ??
    findChromeExecutable({ executablePreference: 'chrome-for-testing' });
  const newManifest = existsSync(join(newBuild, 'manifest.json'))
    ? JSON.parse(readFileSync(join(newBuild, 'manifest.json'), 'utf8'))
    : undefined;
  if (!chromePath || !newManifest?.key) {
    console.error('setup: needs Chrome for Testing and a PRODUCTION extension build (with "key")');
    process.exit(2);
  }
  const cdpPort = Number(process.env['SECRETS_CDP_PORT'] ?? 9463);
  if (cdpPort >= 9222 && cdpPort <= 9229) throw new Error('refusing a DevTools port in 9222-9229');
  const work = mkdtempSync(join(tmpdir(), 'slicc-secrets-migration-'));
  const ext = join(work, 'ext');
  const profile = join(work, 'profile');
  const plainServer = createServer(handler);
  await new Promise<void>((r) => plainServer.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${(plainServer.address() as AddressInfo).port}`;
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      join(work, 'key.pem'),
      '-out',
      join(work, 'cert.pem'),
    ],
    { stdio: 'ignore' }
  );
  const tls = createHttpsServer(
    { key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) },
    handler
  );
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  const s3 = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
  const hardStop = setTimeout(() => {
    console.error('setup: timed out');
    process.exit(2);
  }, 900_000);
  try {
    const client = await bundleRawFetchClient();
    cpSync(await oldBuild(work), ext, { recursive: true });
    rmSync(join(ext, '_metadata'), { recursive: true, force: true });

    // A — the released build stores plaintext; everything works.
    const extId = manifestId(newManifest.key);
    let s = await launch(chromePath, profile, ext, cdpPort, extId);
    const oldVersion = await s.page.evaluate(() => (chrome.runtime as any).getManifest().version);
    check('A: the old build is installed', oldVersion === '6.248.11', oldVersion);
    check('A: its worker has no encrypted storage', !(await workerHasEncryptedStorage(s.browser)));
    await fillAndSave(
      s.page,
      { 'c-name': 'MIG_TOKEN', 'c-value': TOKEN, 'c-domains': '127.0.0.1' },
      'c-save'
    );
    await fillAndSave(
      s.page,
      {
        's3-profile': 'mig',
        's3-key': AKID,
        's3-secret': SAK,
        's3-region': 'us-east-1',
        's3-endpoint': s3,
        's3-pathstyle': 'true',
        's3-domains': '127.0.0.1',
      },
      's3-save'
    );
    const before = await dump(s.page);
    check(
      'A control: the old build stored plaintext',
      before['MIG_TOKEN'] === TOKEN && before['s3.mig.secret_access_key'] === SAK
    );
    await functional('A', s.page, client, up, 'MIG_TOKEN', TOKEN);
    await s3Signing('A', s.page);
    console.log(`info A done at ${Math.round(performance.now() / 1000)}s`);
    await s.close();
    // Update in place: new files on disk (higher version), then one start in
    // which the still-registered old worker reloads the extension, so Chrome
    // re-registers the worker from the new files (as an installed update does).
    rmSync(ext, { recursive: true, force: true });
    cpSync(newBuild, ext, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
    manifest.version = '6.248.11.1';
    writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
    await reloadFromOldWorker(chromePath, profile, ext, cdpPort, extId);

    // B — after the update.
    console.log('info B: relaunching on the updated build');
    s = await launch(chromePath, profile, ext, cdpPort, extId);
    console.log('info B: page open');
    check('B: the worker runs the new code', await workerHasEncryptedStorage(s.browser));
    const listed = await s.page.evaluate(() => document.getElementById('list')?.innerText ?? '');
    check(
      'B: the secrets page lists the migrated secrets',
      listed.includes('MIG_TOKEN') && listed.includes('s3.mig')
    );
    check('B: no row is unreadable', !/can't be read/.test(listed));
    await functional('B', s.page, client, up, 'MIG_TOKEN', TOKEN);
    await s3Signing('B', s.page);
    await fillAndSave(
      s.page,
      { 'c-name': 'MIG_NEW', 'c-value': NEW_TOKEN, 'c-domains': 'example.com' },
      'c-save'
    );
    const added = (await dump(s.page))['MIG_NEW'];
    check('B: a secret added after the update is ciphertext', !!added && typeof added === 'object');
    await noPlaintext('B', s.page);
    await s.close();

    // C — restart: the key persisted.
    s = await launch(chromePath, profile, ext, cdpPort, extId);
    await functional('C', s.page, client, up, 'MIG_TOKEN', TOKEN);
    await s3Signing('C', s.page);
    await noPlaintext('C', s.page);

    // D — Re-enter an unreadable secret.
    await reenter(s.page, client, up);
    await s.close();
    const dir = join(profile, 'Default', 'Local Extension Settings', s.extId);
    const residue = existsSync(dir)
      ? readdirSync(dir).filter((f) => readFileSync(join(dir, f)).includes(Buffer.from(TOKEN)))
      : [];
    console.log(
      `info on-disk LevelDB residue of the pre-migration plaintext: ${residue.length ? residue.join(', ') : 'none'} (compaction-dependent; not reachable through the API)`
    );
  } finally {
    clearTimeout(hardStop);
    plainServer.close();
    tls.close();
    for (const p of live) p.kill('SIGKILL');
    await sleep(500);
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Chrome may still hold files; tmp is reclaimed by the OS */
    }
  }
  console.log(
    failures === 0
      ? 'all secrets migration checks passed'
      : `${failures} secrets migration check(s) failed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Chrome's extension id for a manifest `key`. */
function manifestId(key: string): string {
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash]
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(c, 16)))
    .join('');
}

process.on('unhandledRejection', (err) => {
  // The reloaded worker's CDP session dies under puppeteer; that is expected.
  if (process.env['SECRETS_DEBUG']) console.log('info unhandled', String(err));
});

main().catch((err) => {
  console.error('setup:', err);
  process.exit(2);
});
