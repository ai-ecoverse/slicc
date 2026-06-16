// @vitest-environment jsdom

/**
 * Behavioral harness for the extension-float realm script in
 * `sandbox.html`. The companion `realm-iframe.test.ts` (webapp) pins
 * the source-level parity tokens between the inline script and the
 * worker-float `js-realm-shared.ts`; nothing in the gate has ever
 * actually EXECUTED the iframe script, which is how the Buffer gap
 * survived to user-testing.
 *
 * This file fills that hole. We read `sandbox.html`, extract its
 * inline `<script>` block, evaluate it in this jsdom context to
 * capture `bootstrapRealmPort`, then drive `runRealm` against a real
 * `MessageChannel` whose host end is a fake RPC peer. The assertions
 * cover the iframe float's runtime contract that the standalone
 * browser-terminal harness cannot reach (VAL-GLOBALS-015 +
 * FIX-1 Buffer + FIX-3 drain).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_HTML_PATH = resolve(HERE, '..', 'sandbox.html');
const SANDBOX_HTML = readFileSync(SANDBOX_HTML_PATH, 'utf-8');

function extractInlineScript(html: string): string {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!/\bsrc\s*=/.test(m[1])) return m[2];
  }
  throw new Error('sandbox.html: no inline <script> block found');
}

const INLINE_SCRIPT = extractInlineScript(SANDBOX_HTML);

interface RealmPortLike {
  postMessage(msg: unknown, transfer?: unknown[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start(): void;
  close?(): void;
}

type BootstrapFn = (port: RealmPortLike) => void;

let bootstrapRealmPort: BootstrapFn;

beforeAll(() => {
  if (typeof (window as { fetch?: unknown }).fetch !== 'function') {
    (window as unknown as { fetch: typeof globalThis.fetch }).fetch = globalThis.fetch;
  }
  const factory = new Function(`${INLINE_SCRIPT}\n;return { bootstrapRealmPort };`) as () => {
    bootstrapRealmPort: BootstrapFn;
  };
  bootstrapRealmPort = factory().bootstrapRealmPort;
});

interface RealmDone {
  type: 'realm-done';
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface HostHandlers {
  fsReadFile?: (path: string) => Promise<string> | string;
  fsExists?: (path: string) => Promise<boolean> | boolean;
  exec?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  hangPaths?: Set<string>;
  fsDelayMs?: number;
}

interface RunOpts {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  filename?: string;
  host?: HostHandlers;
}

async function runInIframeFloat(code: string, opts: RunOpts = {}): Promise<RealmDone> {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const realmPort = channel.port2;
  const host = opts.host ?? {};

  hostPort.addEventListener('message', async (ev) => {
    const req = ev.data as {
      type?: string;
      id?: number;
      channel?: string;
      op?: string;
      args?: unknown[];
    };
    if (req?.type !== 'realm-rpc-req') return;
    try {
      let result: unknown;
      if (req.channel === 'vfs' && req.op === 'readFile') {
        const path = req.args?.[0] as string;
        if (host.hangPaths?.has(path)) return;
        if (host.fsDelayMs && host.fsDelayMs > 0) {
          await new Promise((r) => setTimeout(r, host.fsDelayMs));
        }
        result = host.fsReadFile ? await host.fsReadFile(path) : `hello-${path}`;
      } else if (req.channel === 'vfs' && req.op === 'exists') {
        const path = req.args?.[0] as string;
        result = host.fsExists ? await host.fsExists(path) : false;
      } else if (req.channel === 'exec' && req.op === 'run') {
        const cmd = req.args?.[0] as string;
        result = host.exec
          ? await host.exec(cmd)
          : { stdout: `ran:${cmd}\n`, stderr: '', exitCode: 0 };
      } else {
        hostPort.postMessage({
          type: 'realm-rpc-res',
          id: req.id,
          error: `unsupported test op: ${req.channel}.${req.op}`,
        });
        return;
      }
      hostPort.postMessage({ type: 'realm-rpc-res', id: req.id, result });
    } catch (err) {
      hostPort.postMessage({
        type: 'realm-rpc-res',
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  hostPort.start();

  const done = new Promise<RealmDone>((resolveDone, rejectDone) => {
    hostPort.addEventListener('message', (ev) => {
      const data = ev.data as { type?: string; message?: string };
      if (data?.type === 'realm-done') {
        resolveDone(data as unknown as RealmDone);
      } else if (data?.type === 'realm-error') {
        rejectDone(new Error(`realm-error: ${data.message ?? 'unknown'}`));
      }
    });
  });

  bootstrapRealmPort(realmPort as unknown as RealmPortLike);

  hostPort.postMessage({
    type: 'realm-init',
    kind: 'js',
    code,
    argv: opts.argv ?? ['node', '-e', code],
    env: opts.env ?? {},
    cwd: opts.cwd ?? '/workspace',
    filename: opts.filename ?? '[eval]',
    stdin: opts.stdin ?? '',
  });

  const result = await done;
  hostPort.close();
  return result;
}

describe('sandbox.html iframe float — behavioral harness (VAL-GLOBALS-015 + FIX-1 + FIX-3)', () => {
  it('FIX-1: globalThis.Buffer is reachable bare inside the iframe-float realm', async () => {
    const code = `
      console.log(typeof Buffer);
      console.log(typeof Buffer.from);
      console.log(typeof Buffer.alloc);
      console.log(Buffer.from('hi-iframe').toString());
      console.log(Buffer.from('aGVsbG8=', 'base64').toString());
      const a = Buffer.alloc(3);
      a[0] = 0x68; a[1] = 0x69; a[2] = 0x21;
      console.log(a.toString('utf-8'));
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('function');
    expect(lines[2]).toBe('function');
    expect(lines[3]).toBe('hi-iframe');
    expect(lines[4]).toBe('hello');
    expect(lines[5]).toBe('hi!');
  });

  it("require('node:buffer').Buffer is the same constructor as the bare Buffer global", async () => {
    const code = `
      const { Buffer: B } = require('node:buffer');
      console.log(B === Buffer);
      console.log(B.from('round').toString() === Buffer.from('round').toString());
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('true');
    expect(lines[1]).toBe('true');
  });

  it('VAL-GLOBALS-015: every documented sliccy:* virtual module resolves in the iframe float', async () => {
    const code = `
      const names = ['exec','skill','http','browser','usb','serial','hid','cli','color','time','fmt','pool'];
      for (const n of names) {
        const m = require('sliccy:' + n);
        console.log(n + ':' + (m !== undefined && m !== null ? 'ok' : 'missing'));
      }
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    expect(done.stderr).not.toContain('failed to pre-load');
    expect(done.stderr).not.toContain('sliccy:');
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines).toEqual([
      'exec:ok',
      'skill:ok',
      'http:ok',
      'browser:ok',
      'usb:ok',
      'serial:ok',
      'hid:ok',
      'cli:ok',
      'color:ok',
      'time:ok',
      'fmt:ok',
      'pool:ok',
    ]);
  });

  it("require('sliccy:exec') exposes both .spawn and the callable bridge", async () => {
    const code = `
      const exec = require('sliccy:exec');
      console.log(typeof exec);
      console.log(typeof exec.spawn);
      const a = await exec('echo hi');
      console.log(a.stdout.trim());
    `;
    const done = await runInIframeFloat(code, {
      host: {
        exec: async (cmd) => ({ stdout: `ran:${cmd}\n`, stderr: '', exitCode: 0 }),
      },
    });
    expect(done.exitCode).toBe(0);
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('function');
    expect(lines[1]).toBe('function');
    expect(lines[2]).toBe('ran:echo hi');
  });

  it("require('sliccy:bogus') throws a scheme-specific error in the iframe float", async () => {
    const code = `
      try { require('sliccy:bogus'); console.log('UNEXPECTED'); }
      catch (e) { console.log(e.message); }
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("unknown sliccy: module 'bogus'");
    expect(done.stdout).toContain("require('sliccy:bogus')");
  });

  it("require('sliccy:') with empty name throws a scheme-specific error", async () => {
    const code = `
      try { require('sliccy:'); console.log('UNEXPECTED'); }
      catch (e) { console.log(e.message); }
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('empty sliccy: module name');
  });

  it.each([
    'exec',
    'skill',
    'http',
    'browser',
    'usb',
    'serial',
    'hid',
    'cli',
    'c',
    'time',
    'fmt',
    'pool',
    'fs',
  ])('VAL-GLOBALS-015: bare `%s` is undefined in the iframe-float realm scope', async (name) => {
    const code = `${name};`;
    const done = await runInIframeFloat(code);
    expect(done.exitCode, `bare ${name} should throw ReferenceError`).toBe(1);
    expect(done.stderr).toContain('not defined');
    expect(done.stderr.toLowerCase()).toContain(name);
  });

  it('typeof on bare bespoke globals returns "undefined" without ReferenceError', async () => {
    const code = `
      console.log(typeof exec, typeof skill, typeof http, typeof fs, typeof cli, typeof c);
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout.trim()).toBe('undefined undefined undefined undefined undefined undefined');
  });

  it('Node-standard globals (process / console / fetch / Buffer / setTimeout) remain bare in the iframe float', async () => {
    const code = `
      console.log(typeof process);
      console.log(typeof console);
      console.log(typeof fetch);
      console.log(typeof Buffer);
      console.log(typeof setTimeout);
      console.log(typeof globalThis);
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines).toEqual(['object', 'object', 'function', 'function', 'function', 'object']);
  });

  it("require('fs') / require('node:fs') still route to the VFS bridge in the iframe float", async () => {
    const code = `
      const fs1 = require('fs');
      const fs2 = require('node:fs');
      console.log(typeof fs1.readFile, typeof fs2.readFile);
      const a = await fs1.readFile('/a.txt');
      const b = await fs2.readFile('/b.txt');
      console.log(a + '|' + b);
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('function function');
    expect(done.stdout).toContain('hello-/a.txt|hello-/b.txt');
  });

  it('FIX-3: a non-awaited `.then` on an RPC promise prints to stdout before teardown', async () => {
    const code = `
      const fs = require('fs');
      fs.readFile('/x').then(v => console.log('then:' + v));
    `;
    const done = await runInIframeFloat(code, { host: { fsDelayMs: 10 } });
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('then:hello-/x');
  });

  it('FIX-3 (bound): a never-settling RPC promise does not hang teardown', async () => {
    const code = `
      const fs = require('fs');
      fs.readFile('/never').then(v => console.log('then:' + v)).catch(() => {});
    `;
    const start = Date.now();
    const done = await runInIframeFloat(code, {
      host: { hangPaths: new Set(['/never']) },
    });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3000);
    expect(done.stdout).not.toContain('then:');
  });

  it('FIX-3 (bypass): explicit process.exit skips the drain and teardown is immediate', async () => {
    const code = `
      const fs = require('fs');
      fs.readFile('/x').then(v => console.log('then:' + v)).catch(() => {});
      process.exit(0);
    `;
    const start = Date.now();
    const done = await runInIframeFloat(code, { host: { fsDelayMs: 500 } });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    expect(done.stdout).not.toContain('then:');
    expect(elapsed).toBeLessThan(400);
  });
});

describe('sandbox.html structural anchors that the behavioral harness depends on', () => {
  it('loads buffer-polyfill.js BEFORE the inline realm bootstrap', () => {
    const polyIdx = SANDBOX_HTML.search(
      /<script\s+src=["']buffer-polyfill\.js["']\s*>\s*<\/script>/
    );
    const inlineIdx = SANDBOX_HTML.indexOf('function bootstrapRealmPort');
    expect(polyIdx).toBeGreaterThanOrEqual(0);
    expect(inlineIdx).toBeGreaterThan(polyIdx);
  });

  it('the inline script exposes bootstrapRealmPort + runRealm at script scope', () => {
    expect(INLINE_SCRIPT).toMatch(/function\s+bootstrapRealmPort\s*\(/);
    expect(INLINE_SCRIPT).toMatch(/async\s+function\s+runRealm\s*\(/);
  });
});
