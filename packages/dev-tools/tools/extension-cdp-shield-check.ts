/**
 * Real-browser check of the extension CDP bridge shield (B24-4).
 *
 * Loads the built extension (SLICC_EXT_DEV=1) into a disposable Chrome for
 * Testing profile, serves a stand-in leader page on the dev leader origin
 * (`http://localhost:8787/?slicc=leader`), and drives the real
 * `slicc.cdp-bridge` Port, so every command runs through `chrome.debugger`
 * exactly as the hosted leader's would. `--host-resolver-rules` maps
 * `*.sliccy.ai` (protected) and `*.test` (plain) to one local server, which
 * records every request by host so a check can tell whether a protected
 * document was ever fetched.
 *
 * Every case runs a POSITIVE CONTROL first, the same setup and trigger against
 * a plain origin, and asserts it succeeds (the init-script beacon fires, the
 * document is served, the pause reaches the client, the cookie reads or
 * writes), and only then the protected variant, which must fail. A protected
 * pass without its control is a failure: the trigger may not have fired.
 *
 *   C1 init script, then page-JS `location.href` to the vault
 *   C2 redirect chain plain → plain → vault
 *   C3 `window.open` popup to the vault: never attached, never instrumented
 *   C4 vault iframe in a plain page
 *   C5 Fetch: client pauses never include the vault; fulfill / redirect into it
 *   C5 slicc-cli protectVectors (@2d5d981): sub-resource, auth, guessed-id
 *   C6 cookies: getCookies / getAllCookies filtered, setCookie refused
 *
 * Usage:
 *   SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
 *   npm run test:cdp-shield -w @slicc/chrome-extension
 *
 * Environment: CHROME_PATH overrides the browser; SHIELD_CDP_PORT the
 * DevTools port (default 9461; never 9222-9229).
 * Exit codes: 0 all checks passed; 1 a check failed; 2 setup failed.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';
import { findChromeExecutable } from '../../node-server/src/chrome-launch.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LEADER_PORT = 8787;

interface Hit {
  host: string;
  path: string;
}
const hits: Hit[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LEADER_HTML = `<!doctype html><title>leader</title><script>
window.__events = [];
window.__start = (extId) => new Promise((resolve, reject) => {
  const port = chrome.runtime.connect(extId, { name: 'slicc.cdp-bridge' });
  const pending = new Map();
  let next = 1;
  port.onMessage.addListener((m) => {
    if (m.kind === 'handshake.welcome') resolve(true);
    else if (m.kind === 'handshake.rejected') reject(new Error(m.reason));
    else if (m.kind === 'cdp.response') {
      const p = pending.get(m.id); pending.delete(m.id);
      if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    } else if (m.kind === 'cdp.event') window.__events.push(m);
  });
  window.cdp = (method, params, sessionId) => new Promise((res, rej) => {
    const id = next++;
    pending.set(id, { resolve: res, reject: rej });
    port.postMessage({ bridge: 1, channelId: 'shield-check', kind: 'cdp.request', id, method, params, sessionId });
  });
  port.postMessage({ bridge: 1, channelId: 'shield-check', kind: 'handshake.hello' });
});
</script>`;

function page(title: string, body = ''): string {
  return `<!doctype html><title>${title}</title><body>${title}${body}</body>`;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  const url = new URL(req.url ?? '/', 'http://x');
  hits.push({ host, path: `${url.pathname}${url.search}` });
  const q = (k: string) => url.searchParams.get(k) ?? '';
  const html = (text: string, extra: Record<string, string> = {}) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', ...extra });
    res.end(text);
  };
  if (host === 'localhost') {
    html(LEADER_HTML);
    return;
  }
  switch (url.pathname) {
    case '/redirect':
      res.writeHead(302, { location: q('to'), 'cache-control': 'no-store' });
      res.end();
      break;
    case '/frame':
      html(page('frame', `<iframe src="${q('src')}"></iframe>`));
      break;
    case '/set-cookie':
      html(page('cookie'), { 'set-cookie': `${q('name')}=1; Path=/; Max-Age=3600` });
      break;
    case '/data':
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end(`real-${q('n')}`);
      break;
    case '/auth':
      if (req.headers.authorization) {
        res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        res.end('authed');
      } else {
        res.writeHead(401, {
          'www-authenticate': 'Basic realm="r"',
          'content-type': 'text/plain',
          'access-control-allow-origin': '*',
        });
        res.end('denied');
      }
      break;
    case '/beacon':
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
      break;
    default:
      html(page(q('n') || 'page'));
  }
}

function served(host: string, marker: string): boolean {
  return hits.some((h) => h.host === host && h.path.includes(marker));
}

function beaconFrom(marker: string): boolean {
  return hits.some(
    (h) => h.path.startsWith('/beacon') && decodeURIComponent(h.path).includes(marker)
  );
}

async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

type Cdp = (method: string, params?: unknown, sessionId?: string) => Promise<any>;

function cdpOf(leader: Page): Cdp {
  return (method, params, sessionId) =>
    leader.evaluate(
      (m, p, s) => (window as any).cdp(m, p, s),
      method,
      (params ?? {}) as any,
      sessionId as any
    );
}

/** The client's session still answers, on the page that blocked the load. */
async function sessionAlive(cdp: Cdp, s: string, expectHref: string): Promise<boolean> {
  const href = (
    await cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, s).catch(
      () => undefined
    )
  )?.result?.value;
  return typeof href === 'string' && href.includes(expectHref);
}

async function refused(
  cdp: Cdp,
  method: string,
  params: unknown,
  sessionId?: string
): Promise<string> {
  try {
    await cdp(method, params, sessionId);
    return '';
  } catch (err) {
    return String((err as Error).message);
  }
}

async function events(leader: Page): Promise<any[]> {
  return leader.evaluate(() => (window as any).__events.splice(0));
}

interface Ctx {
  leader: Page;
  cdp: Cdp;
  s: string;
  go: (url: string) => Promise<unknown>;
  plain: string;
  plain2: string;
  vault: string;
  seven: string;
}

async function c1InitScript({ cdp, s, go, plain, plain2, vault }: Ctx): Promise<void> {
  // C1 — init script + self-navigation.
  await go(`${plain2}/page?n=c1`);
  check(
    'C1 control: plain self-navigation is served',
    await until(() => served('plain2.test', 'n=c1'))
  );
  check('C1 control: init script ran on the plain page', await until(() => beaconFrom('n=c1')));
  await go(`${vault}/page?n=c1v`);
  await sleep(2000);
  check('C1 protected: vault document never fetched', !served('vault.sliccy.ai', 'n=c1v'));
  check('C1 protected: init script never ran on the vault', !beaconFrom('n=c1v'));
  const c1Alive = await cdp('Runtime.evaluate', { expression: '1+1', returnByValue: true }, s).then(
    (r) => r.result?.value === 2,
    () => false
  );
  check('C1 protected: tab and session stay (request failed, no detach)', c1Alive);
}

async function c2Redirects({ go, plain, plain2, vault }: Ctx): Promise<void> {
  // C2 — redirect chain.
  await go(
    `${plain}/redirect?to=${encodeURIComponent(`${plain2}/redirect?to=${encodeURIComponent(`${plain}/page?n=c2`)}`)}`
  );
  check(
    'C2 control: plain → plain → plain redirect chain lands',
    await until(() => beaconFrom('n=c2'))
  );
  await go(
    `${plain}/redirect?to=${encodeURIComponent(`${plain2}/redirect?to=${encodeURIComponent(`${vault}/page?n=c2v`)}`)}`
  );
  await sleep(2000);
  check(
    'C2 protected: redirect hop into the vault never fetched',
    !served('vault.sliccy.ai', 'n=c2v')
  );
  check('C2 protected: init script never ran after the redirect', !beaconFrom('n=c2v'));
}

async function c3Popups({ leader, cdp, s, go, plain, plain2, vault }: Ctx): Promise<void> {
  // C3 — window.open popup.
  await go(`${plain}/page?n=c3home`);
  await until(() => beaconFrom('n=c3home'));
  await events(leader);
  await cdp(
    'Runtime.evaluate',
    { expression: `window.open(${JSON.stringify(`${plain2}/page?n=c3`)})`, userGesture: true },
    s
  );
  check(
    'C3 control: plain popup opened (trigger fired)',
    await until(() => served('plain2.test', 'n=c3'))
  );
  const popupTargets = (await cdp('Target.getTargets')).targetInfos as any[];
  const plainPopup = popupTargets.find((t) => String(t.url).includes('n=c3'));
  check(
    'C3 control: plain popup is attachable',
    !!plainPopup &&
      !!(await cdp('Target.attachToTarget', { targetId: plainPopup.targetId, flatten: true }))
        .sessionId
  );
  await cdp(
    'Runtime.evaluate',
    { expression: `window.open(${JSON.stringify(`${vault}/page?n=c3v`)})`, userGesture: true },
    s
  );
  const popupLoaded = await until(() => served('vault.sliccy.ai', 'n=c3v'));
  // Design-dependent PASS (capabilities autoAttach:false, browserSession:false):
  // the bridge never attaches popups, so a vault popup (e.g. a legitimate
  // sign-in/unlock) loads uncontrolled. Reported as a pass, not a skip.
  check(
    `C3 protected: vault popup ${popupLoaded ? 'loaded uncontrolled' : 'did not load'} (design-dependent pass: autoAttach:false)`,
    true
  );
  await sleep(1000);
  check(
    'C3 protected: popup never instrumented (no init script on the vault)',
    !beaconFrom('n=c3v')
  );
  const attachedEvents = (await events(leader)).filter(
    (e) => e.method === 'Target.attachedToTarget'
  );
  check(
    'C3 protected: no popup came up attached',
    attachedEvents.length === 0,
    JSON.stringify(attachedEvents)
  );
  const listed = ((await cdp('Target.getTargets')).targetInfos as any[]).find((t) =>
    String(t.url).startsWith(vault)
  );
  check(
    'C3 protected: vault popup listed by origin only',
    !!listed && listed.url === vault && listed.title === vault,
    JSON.stringify(listed)
  );
  const popupRefusal = listed
    ? await refused(cdp, 'Target.attachToTarget', { targetId: listed.targetId, flatten: true })
    : '';
  check(
    'C3 protected: attaching to the vault popup is refused',
    popupRefusal.includes('refused'),
    popupRefusal
  );
  check(
    'C3 protected: auto-attach is refused',
    (
      await refused(
        cdp,
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        s
      )
    ).includes('refused')
  );
}

async function c4Iframes({ cdp, s, go, plain, plain2, vault }: Ctx): Promise<void> {
  // C4 — iframes.
  await go(`${plain}/frame?src=${encodeURIComponent(`${plain2}/page?n=c4`)}`);
  check('C4 control: plain iframe is served', await until(() => served('plain2.test', 'n=c4')));
  await go(`${plain}/frame?src=${encodeURIComponent(`${vault}/page?n=c4v`)}`);
  await until(
    () =>
      beaconFrom('/frame?src=') &&
      hits.some((h) => h.path.includes('c4v') && h.host === 'plain.test')
  );
  await sleep(2000);
  check('C4 protected: vault iframe document never fetched', !served('vault.sliccy.ai', 'n=c4v'));
  check(
    'C4 protected: only the frame failed; the tab and session stay on the plain page',
    await sessionAlive(cdp, s, '/frame?src=')
  );
}

async function c5Fetch({ leader, cdp, s, go, plain, plain2, vault }: Ctx): Promise<void> {
  // C5 — client Fetch.
  await events(leader);
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document' }] }, s);
  await go(`${plain2}/page?n=c5`);
  let paused: any;
  await until(() => false, 1500);
  for (const e of await events(leader))
    if (e.method === 'Fetch.requestPaused' && String(e.params?.request?.url).includes('n=c5'))
      paused = e.params;
  check('C5 control: plain document pause reaches the client', !!paused);
  if (paused) {
    const body = Buffer.from('<!doctype html><title>fulfilled</title>').toString('base64');
    await cdp('Fetch.fulfillRequest', { requestId: paused.requestId, responseCode: 200, body }, s);
    await sleep(1000);
    const title = (
      await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, s)
    ).result?.value;
    check('C5 control: fulfilled body renders', title === 'fulfilled', String(title));
  }
  await go(`${vault}/page?n=c5v`);
  await sleep(2000);
  const leaked = (await events(leader)).filter(
    (e) => e.method === 'Fetch.requestPaused' && String(e.params?.request?.url).includes('vault')
  );
  check('C5 protected: no vault pause reaches the client', leaked.length === 0);
  check('C5 protected: vault document never fetched', !served('vault.sliccy.ai', 'n=c5v'));
  const fake = await refused(
    cdp,
    'Fetch.fulfillRequest',
    { requestId: 'interception-job-999.0', responseCode: 200, body: '' },
    s
  );
  check('C5 protected: fulfilling an unseen request is refused', fake.includes('refused'), fake);
  await go(`${plain2}/page?n=c5r`);
  await until(() => false, 1500);
  let redirectable: any;
  for (const e of await events(leader))
    if (e.method === 'Fetch.requestPaused' && String(e.params?.request?.url).includes('n=c5r'))
      redirectable = e.params;
  check('C5 control: second plain pause reaches the client', !!redirectable);
  if (redirectable) {
    await cdp(
      'Fetch.fulfillRequest',
      {
        requestId: redirectable.requestId,
        responseCode: 302,
        responseHeaders: [{ name: 'Location', value: `${vault}/page?n=c5f` }],
      },
      s
    );
    await sleep(2000);
    const after = (await events(leader)).filter(
      (e) => e.method === 'Fetch.requestPaused' && String(e.params?.request?.url).includes('vault')
    );
    check(
      'C5 protected: fulfilled redirect into the vault never fetched',
      !served('vault.sliccy.ai', 'n=c5f')
    );
    check('C5 protected: redirect hop pause withheld from the client', after.length === 0);
  }
  await cdp('Fetch.disable', {}, s);
  await go(`${plain}/page?n=c5off`);
  check(
    'C5 control: navigation still works after Fetch.disable',
    await until(() => beaconFrom('n=c5off'))
  );
}

/** Pause-driven probe: start `expr` in the page, answer pauses with `answer`, read the result. */
async function probe(
  { leader, cdp, s }: Ctx,
  expr: string,
  answer: (e: any) => Promise<void>
): Promise<{ result: string; seen: any[] }> {
  await cdp(
    'Runtime.evaluate',
    { expression: `window.__probe = undefined; (${expr}).then((v) => { window.__probe = v; })` },
    s
  );
  const seen: any[] = [];
  for (let i = 0; i < 40; i++) {
    for (const e of await events(leader)) {
      if (e.method === 'Fetch.requestPaused' || e.method === 'Fetch.authRequired') {
        seen.push(e);
        await answer(e);
      }
    }
    const done = (
      await cdp('Runtime.evaluate', { expression: 'window.__probe', returnByValue: true }, s)
    ).result?.value;
    if (done !== undefined) return { result: String(done), seen };
    await sleep(100);
  }
  return { result: '(timeout)', seen };
}

/** slicc-cli protectVectors C5.fetch / C5.auth / C5.guessed-id, live. */
async function c5Vectors(ctx: Ctx): Promise<void> {
  const { cdp, s, go, plain, plain2, vault } = ctx;
  await go(`${plain}/page?n=c5v-home`);
  await until(() => beaconFrom('n=c5v-home'));
  await events(ctx.leader);
  const both = [
    { urlPattern: '*', requestStage: 'Request' },
    { urlPattern: '*', requestStage: 'Response' },
  ];
  await cdp('Fetch.enable', { patterns: both, handleAuthRequests: true }, s);
  const body = Buffer.from('fulfilled').toString('base64');
  const fulfilOrContinue = (marker: string) => async (e: any) => {
    const p = e.params;
    if (e.method === 'Fetch.authRequired') {
      const mine = String(p.request?.url).includes(marker);
      const authChallengeResponse = mine
        ? { response: 'ProvideCredentials', username: 'u', password: 'p' }
        : { response: 'Default' };
      await cdp(
        'Fetch.continueWithAuth',
        { requestId: p.requestId, authChallengeResponse },
        s
      ).catch(() => {});
      return;
    }
    const atResponse = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined;
    if (String(p.request?.url).includes(marker) && !atResponse && marker.includes('data')) {
      const headers = [
        { name: 'access-control-allow-origin', value: '*' },
        { name: 'content-type', value: 'text/plain' },
      ];
      await cdp(
        'Fetch.fulfillRequest',
        { requestId: p.requestId, responseCode: 200, responseHeaders: headers, body },
        s
      ).catch(() => {});
      return;
    }
    await cdp('Fetch.continueRequest', { requestId: p.requestId }, s).catch(() => {});
  };
  const fetchText = (url: string) =>
    `fetch(${JSON.stringify(url)}).then((r) => r.text(), () => 'error')`;
  const ctl = await probe(ctx, fetchText(`${plain2}/data?n=f1`), fulfilOrContinue('data?n=f1'));
  check(
    'C5.fetch control: plain sub-resource paused and fulfilled',
    ctl.result === 'fulfilled' && ctl.seen.length > 0,
    ctl.result
  );
  const prot = await probe(ctx, fetchText(`${vault}/data?n=f2`), fulfilOrContinue('data?n=f2'));
  const sawVault = prot.seen.some((e) => String(e.params?.request?.url).includes('vault'));
  check(
    'C5.fetch protected: vault sub-resource never seen, answered for real',
    !sawVault && prot.result === 'real-f2',
    prot.result
  );

  const authText = (url: string) =>
    `fetch(${JSON.stringify(url)}).then(async (r) => r.status + ' ' + (await r.text()), () => 'error')`;
  const actl = await probe(ctx, authText(`${plain}/auth?n=a1`), fulfilOrContinue('auth?n=a1'));
  check(
    'C5.auth control: plain challenge reaches the client and authenticates',
    actl.result === '200 authed' && actl.seen.some((e) => e.method === 'Fetch.authRequired'),
    actl.result
  );
  const aprot = await probe(ctx, authText(`${vault}/auth?n=a2`), fulfilOrContinue('auth?n=a2'));
  check(
    'C5.auth protected: vault challenge never seen, outcome untouched',
    !aprot.seen.some((e) => String(e.params?.request?.url).includes('vault')) &&
      aprot.result === '401 denied',
    aprot.result
  );

  // C5.guessed-id: hold nothing back; fulfil every id between two of our own.
  const g1 = await probe(ctx, fetchText(`${plain2}/data?n=g1`), fulfilOrContinue('none'));
  const v = await probe(ctx, fetchText(`${vault}/data?n=gv`), fulfilOrContinue('none'));
  const g2 = await probe(ctx, fetchText(`${plain2}/data?n=g2`), fulfilOrContinue('none'));
  const ids = [...g1.seen, ...g2.seen].map((e) => String(e.params.requestId));
  const num = (id: string) => Number(/(\d+)\.\d+$/.exec(id)?.[1]);
  const nums = ids.map(num).filter((n) => Number.isFinite(n));
  const prefix = (ids[0] ?? '').replace(/\d+\.\d+$/, '');
  const attempts: string[] = [];
  for (let n = Math.min(...nums) + 1; n < Math.max(...nums); n += 1) {
    if (ids.includes(`${prefix}${n}.0`)) continue;
    attempts.push(
      await refused(
        cdp,
        'Fetch.fulfillRequest',
        { requestId: `${prefix}${n}.0`, responseCode: 200, body },
        s
      )
    );
  }
  check(
    'C5.guessed-id control: own ids were given and answered',
    g1.result === 'real-g1' && g2.result === 'real-g2' && v.result === 'real-gv'
  );
  check(
    'C5.guessed-id protected: every guessed id refused',
    attempts.length > 0 && attempts.every((a) => a.includes('refused')),
    `${attempts.length} guesses`
  );
  await cdp('Fetch.disable', {}, s);
}

async function c6Cookies({ cdp, s, plain, vault }: Ctx): Promise<void> {
  // C6 — cookies (seeded by an unshielded page before the run).
  const plainCookies = (await cdp('Network.getCookies', { urls: [`${plain}/`] }, s))
    .cookies as any[];
  check(
    'C6 control: plain cookie reads',
    plainCookies.some((c) => c.name === 'plainc'),
    JSON.stringify(plainCookies)
  );
  const vaultCookies = (await cdp('Network.getCookies', { urls: [`${vault}/`] }, s))
    .cookies as any[];
  check(
    'C6 protected: getCookies for the vault URL returns none',
    vaultCookies.length === 0,
    JSON.stringify(vaultCookies)
  );
  const all = (await cdp('Network.getAllCookies', {}, s)).cookies as any[];
  check(
    'C6 control: getAllCookies still lists the plain cookie',
    all.some((c) => c.name === 'plainc')
  );
  check(
    'C6 protected: getAllCookies hides the vault cookie',
    !all.some((c) => c.name === 'vaultc')
  );
  const setPlain = await refused(
    cdp,
    'Network.setCookie',
    { name: 'agentc', value: '1', url: `${plain}/` },
    s
  );
  check('C6 control: setCookie on a plain URL succeeds', setPlain === '', setPlain);
  check(
    'C6 protected: setCookie on the vault is refused',
    (
      await refused(cdp, 'Network.setCookie', { name: 'x', value: '1', url: `${vault}/` }, s)
    ).includes('refused')
  );
  check(
    'C6 protected: setCookie on .sliccy.ai is refused',
    (
      await refused(
        cdp,
        'Network.setCookie',
        { name: 'x', value: '1', domain: '.sliccy.ai', path: '/' },
        s
      )
    ).includes('refused')
  );
  check(
    'C6 protected: deleteCookies on the vault is refused',
    (await refused(cdp, 'Network.deleteCookies', { name: 'vaultc', url: `${vault}/` }, s)).includes(
      'refused'
    )
  );
}

async function refusals({ cdp, s, plain, seven }: Ctx): Promise<void> {
  // Outright refusals and navigation (control first).
  check(
    'nav control: Page.navigate to a plain URL works',
    (await refused(cdp, 'Page.navigate', { url: `${plain}/page?n=nav` }, s)) === ''
  );
  check(
    'nav protected: Page.navigate to seven is refused',
    (await refused(cdp, 'Page.navigate', { url: `${seven}/` }, s)).includes('refused')
  );
  check(
    'refused: Security.setIgnoreCertificateErrors',
    (await refused(cdp, 'Security.setIgnoreCertificateErrors', { ignore: true }, s)).includes(
      'refused'
    )
  );
}

async function run(leader: Page, base: (host: string) => string): Promise<void> {
  const cdp = cdpOf(leader);
  const plain = base('plain.test');
  const plain2 = base('plain2.test');
  const vault = base('vault.sliccy.ai');
  const seven = base('seven.sliccy.ai');
  const beacon = base('beacon.test');

  const { targetId } = await cdp('Target.createTarget', { url: `${plain}/page?n=start` });
  const { sessionId: s } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.enable', {}, s);
  const initSource = `fetch('${beacon}/beacon?h=' + encodeURIComponent(location.href), { mode: 'no-cors' });`;
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: initSource }, s);
  const go = (url: string) =>
    cdp('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` }, s);
  const ctx: Ctx = { leader, cdp, s, go, plain, plain2, vault, seven };
  for (const step of [
    c1InitScript,
    c2Redirects,
    c3Popups,
    c4Iframes,
    c5Fetch,
    c5Vectors,
    c6Cookies,
    refusals,
  ]) {
    await step(ctx);
  }
}

async function main(): Promise<void> {
  const extSrc = join(repoRoot, 'dist/extension');
  const chromePath =
    process.env['CHROME_PATH'] ??
    findChromeExecutable({ executablePreference: 'chrome-for-testing' });
  if (!existsSync(join(extSrc, 'manifest.json')) || !chromePath) {
    console.error('setup: build the extension (SLICC_EXT_DEV=1) and install Chrome for Testing');
    process.exit(2);
  }
  const cdpPort = Number(process.env['SHIELD_CDP_PORT'] ?? 9461);
  if (cdpPort >= 9222 && cdpPort <= 9229) throw new Error('refusing a DevTools port in 9222-9229');
  const server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const leaderServer = createServer(handle);
  await new Promise<void>((r) => leaderServer.listen(LEADER_PORT, '127.0.0.1', r));
  const work = mkdtempSync(join(tmpdir(), 'slicc-cdp-shield-check-'));
  const ext = join(work, 'ext');
  cpSync(extSrc, ext, { recursive: true });
  const chromeProc = spawn(
    chromePath,
    [
      `--user-data-dir=${join(work, 'profile')}`,
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      `--host-resolver-rules=MAP *.sliccy.ai 127.0.0.1:${port}, MAP *.test 127.0.0.1:${port}`,
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
  }, 240_000);
  try {
    let browser;
    for (let i = 0; i < 100 && !browser; i++) {
      browser = await puppeteer
        .connect({ browserURL: `http://127.0.0.1:${cdpPort}` })
        .catch(() => undefined);
      if (!browser) await sleep(200);
    }
    if (!browser) throw new Error('could not reach Chrome');
    const sw = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'),
      { timeout: 60_000 }
    );
    const base = (host: string) => `http://${host}:${port}`;
    const seeder = await browser.newPage();
    await seeder.goto(`${base('vault.sliccy.ai')}/set-cookie?name=vaultc`);
    await seeder.goto(`${base('plain.test')}/set-cookie?name=plainc`);
    await seeder.close();
    const leader = await browser.newPage();
    await leader.goto(`http://localhost:${LEADER_PORT}/?slicc=leader`);
    await leader.evaluate((id) => (window as any).__start(id), new URL(sw.url()).host);
    await run(leader, base);
    await browser.disconnect();
  } finally {
    clearTimeout(hardStop);
    chromeProc.kill('SIGKILL');
    server.close();
    leaderServer.close();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(failures === 0 ? 'all shield checks passed' : `${failures} shield check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('setup:', err);
  process.exit(2);
});
