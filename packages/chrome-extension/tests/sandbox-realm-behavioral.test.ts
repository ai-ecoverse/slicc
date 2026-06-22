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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { md5 } from 'js-md5';
import { sha1 } from 'js-sha1';
import { sha256 } from 'js-sha256';
import * as pako from 'pako';
import * as ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePath, splitPath } from '../../webapp/src/fs/path-utils.js';
import { runJsRealm } from '../../webapp/src/kernel/realm/js-realm-shared.js';
import type { RealmInitMsg } from '../../webapp/src/kernel/realm/realm-types.js';
import {
  buildRealmModuleGraph,
  type EntryTranspile,
  type ModuleTranspile,
  type RealmGraphResult,
} from '../../webapp/src/shell/ipk/module-loader.js';
import type { ModuleReader } from '../../webapp/src/shell/ipk/resolver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SANDBOX_HTML_PATH = resolve(HERE, '..', 'sandbox.html');
const SANDBOX_HTML = readFileSync(SANDBOX_HTML_PATH, 'utf-8');
const BUFFER_POLYFILL_DIST = resolve(REPO_ROOT, 'dist/extension/buffer-polyfill.js');
const BUFFER_POLYFILL_SOURCE = resolve(REPO_ROOT, 'packages/webapp/src/shims/buffer-polyfill.ts');

function extractInlineScript(html: string): string {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!/\bsrc\s*=/.test(m[1])) return m[2];
  }
  throw new Error('sandbox.html: no inline <script> block found');
}

const INLINE_SCRIPT = extractInlineScript(SANDBOX_HTML);

function loadBufferPolyfillIife(): string {
  // Prefer the production-built dist artifact when present — it's the exact
  // bytes the extension ships to users.
  try {
    return readFileSync(BUFFER_POLYFILL_DIST, 'utf-8');
  } catch {
    // Fallback: build the same IIFE the Vite `buildBufferPolyfillPlugin`
    // emits, from the same source. jsdom's TextEncoder/Uint8Array mix
    // makes esbuild's invariant check fail when imported into the test
    // realm directly (`new TextEncoder().encode("") instanceof Uint8Array`
    // returns false across the realm boundary), so we run esbuild in a
    // clean Node subprocess instead and capture its stdout.
    const compileScript = `
      const { build } = require('esbuild');
      build({
        entryPoints: [${JSON.stringify(BUFFER_POLYFILL_SOURCE)}],
        bundle: true,
        format: 'iife',
        target: 'esnext',
        minify: true,
        write: false,
        define: { __DEV__: 'false', global: 'globalThis' },
      }).then((r) => {
        process.stdout.write(r.outputFiles[0].text);
      }, (err) => {
        process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n');
        process.exit(1);
      });
    `;
    const out = execFileSync(process.execPath, ['-e', compileScript], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!out || out.length === 0) {
      throw new Error('subprocess esbuild produced empty output for buffer-polyfill source');
    }
    return out;
  }
}

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

  // (B) Prove the bundled polyfill (not Node/jsdom's ambient Buffer) is what
  // supplies the realm's Buffer. Strip the ambient global FIRST so the
  // polyfill's `if (typeof globalThis.Buffer === 'undefined')` guard actually
  // fires, then run the real IIFE asset (dist, falling back to compiling the
  // exact same source the build ships).
  delete (globalThis as { Buffer?: unknown }).Buffer;
  if (typeof window !== 'undefined') {
    delete (window as unknown as { Buffer?: unknown }).Buffer;
  }
  expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');

  const polyfillIife = loadBufferPolyfillIife();
  runInThisContext(polyfillIife, { filename: 'buffer-polyfill.js' });
  expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('function');

  // Publish the realm-vendor globals (hashers + pako) the iframe float's
  // `crypto.createHash` / `zlib` shims read from `globalThis.__sliccRealmVendor`.
  // Production loads these via `<script src="realm-vendor.js">`; the behavioral
  // harness supplies the same libraries directly so the inline shims execute.
  (globalThis as Record<string, unknown>).__sliccRealmVendor = { md5, sha1, sha256, pako };

  // (A) Execute the inline realm-bootstrap script with real iframe top-level
  // script semantics. `vm.runInThisContext` evaluates the source as a top-
  // level `<script>` in the current realm: top-level function/var land on
  // globalThis AND top-level let/const land in the realm's global lexical
  // environment, so subsequent Function/AsyncFunction (the user-code path
  // in `runRealm`) can resolve them the way a real iframe would. A `new
  // Function` FACTORY or `(0, eval)(...)` would keep let/const in a
  // function/eval scope, hiding any reintroduced top-level capability
  // binding from the bare-global tests below.
  runInThisContext(INLINE_SCRIPT, { filename: 'sandbox.html#inline' });
  const exposed = (globalThis as unknown as { bootstrapRealmPort?: BootstrapFn })
    .bootstrapRealmPort;
  if (typeof exposed !== 'function') {
    throw new Error('inline script did not expose bootstrapRealmPort on the realm global');
  }
  bootstrapRealmPort = exposed;
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
  /**
   * In-memory `{ path: contents }` node_modules tree backing the `module`
   * channel. When set, the host answers `module`/buildGraph with the REAL
   * host-side `buildModuleGraph` over a reader on this map — the same loader
   * `realm-host.ts` runs in production — so the iframe-float evaluator is
   * exercised against a faithful graph.
   */
  files?: Record<string, string>;
  /**
   * Optional entry-code transpile hook. The default `buildGraphForHost` omits
   * the esbuild-backed hooks (esbuild's load-time `TextEncoder` invariant fails
   * under jsdom). ESM parity cases inject a TypeScript-only `createEntryTranspile`
   * so the host lowers `import ... from 'sliccy:'`/`node:`/`fs` to `require(...)`
   * (the same transform `realm-host.ts` performs) without loading esbuild.
   */
  transpileEntry?: EntryTranspile;
  /**
   * Optional ESM-module transpile hook. Like `transpileEntry`, the default
   * omits the esbuild-backed `createEsmTranspile` (jsdom-hostile); ESM parity
   * cases inject a TypeScript-only ESM->CJS transform so an installed ESM
   * package's source is lowered to the same uniform CJS the realm evaluates.
   */
  transpileModule?: ModuleTranspile;
}

/** Build a ModuleReader over a flat `{ path: contents }` map (mirrors module-resolve.test.ts). */
function makeModuleReader(files: Record<string, string>): ModuleReader {
  const norm: Record<string, string> = {};
  const dirs = new Set<string>(['/']);
  for (const [key, value] of Object.entries(files)) {
    const p = normalizePath(key);
    norm[p] = value;
    let dir = splitPath(p).dir;
    while (dir && dir !== '/') {
      dirs.add(dir);
      dir = splitPath(dir).dir;
    }
  }
  const fileSet = new Set(Object.keys(norm));
  return {
    exists: async (path) => {
      const p = normalizePath(path);
      return fileSet.has(p) || dirs.has(p);
    },
    isDirectory: async (path) => dirs.has(normalizePath(path)),
    readFile: async (path) => {
      const v = norm[normalizePath(path)];
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
  };
}

/**
 * Run the REAL host-side `buildRealmModuleGraph` (the same function
 * `realm-host.ts dispatchModule` calls in production) from the entry CODE: it
 * extracts the tagged require/import specifiers and resolves each in isolation
 * so one broken/uninstalled entry surfaces as `errors[specifier]` without
 * sinking the others, then returns the ordered graph.
 *
 * The default esbuild-backed hooks (`createEsmTranspile` / `createEntryTranspile`)
 * are intentionally omitted: they pull in `esbuild-wasm`, whose load-time
 * `TextEncoder` invariant fails under this suite's jsdom environment. CJS-only
 * cases need no transpile; ESM parity cases inject TypeScript-only
 * `transpileEntry`/`transpileModule` hooks instead (the same lowering the
 * esbuild hooks fall back to).
 */
async function buildGraphForHost(
  reader: ModuleReader,
  entryCode: string,
  fromDir: string,
  entryFilename: string,
  transpileEntry?: EntryTranspile,
  transpileModule?: ModuleTranspile
): Promise<RealmGraphResult> {
  return buildRealmModuleGraph({
    entryCode,
    fromDir,
    entryFilename,
    reader,
    transpileEntry,
    transpile: transpileModule,
  });
}

interface RunOpts {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  filename?: string;
  host?: HostHandlers;
}

/**
 * Wire a fake RPC host onto the host end of a `MessageChannel`: it answers the
 * `vfs` / `exec` / `module` channels the realm calls back on (the `module`
 * channel runs the REAL host-side `buildModuleGraph`, mirroring
 * `realm-host.ts dispatchModule`) and resolves once the realm posts
 * `realm-done`. Shared by BOTH float runners so the iframe float and the CLI
 * worker float are driven against a byte-identical host.
 */
function attachFakeRpcHost(hostPort: MessagePort, host: HostHandlers): Promise<RealmDone> {
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
      } else if (req.channel === 'module' && req.op === 'buildGraph') {
        const entryCode = (req.args?.[0] as string) ?? '';
        const fromDir = (req.args?.[1] as string) ?? '/workspace';
        const entryFilename = (req.args?.[2] as string) ?? '[eval]';
        const reader = makeModuleReader(host.files ?? {});
        result = await buildGraphForHost(
          reader,
          entryCode,
          fromDir,
          entryFilename,
          host.transpileEntry,
          host.transpileModule
        );
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

  return new Promise<RealmDone>((resolveDone, rejectDone) => {
    hostPort.addEventListener('message', (ev) => {
      const data = ev.data as { type?: string; message?: string };
      if (data?.type === 'realm-done') {
        resolveDone(data as unknown as RealmDone);
      } else if (data?.type === 'realm-error') {
        rejectDone(new Error(`realm-error: ${data.message ?? 'unknown'}`));
      }
    });
  });
}

function makeRealmInit(code: string, opts: RunOpts): RealmInitMsg {
  return {
    type: 'realm-init',
    kind: 'js',
    code,
    argv: opts.argv ?? ['node', '-e', code],
    env: opts.env ?? {},
    cwd: opts.cwd ?? '/workspace',
    filename: opts.filename ?? '[eval]',
    stdin: opts.stdin ?? '',
  };
}

async function runInIframeFloat(code: string, opts: RunOpts = {}): Promise<RealmDone> {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const realmPort = channel.port2;
  const done = attachFakeRpcHost(hostPort, opts.host ?? {});

  bootstrapRealmPort(realmPort as unknown as RealmPortLike);
  hostPort.postMessage(makeRealmInit(code, opts));

  const result = await done;
  hostPort.close();
  return result;
}

/**
 * Drive the CLI/standalone worker float realm. `js-realm-shared.ts runJsRealm`
 * is the SAME engine the production DedicatedWorker (`js-realm-worker.ts`) runs,
 * so this is a faithful worker-float reference; we run it against the identical
 * fake RPC host the iframe float uses so any divergence is a real parity bug.
 */
async function runInWorkerFloat(code: string, opts: RunOpts = {}): Promise<RealmDone> {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const realmPort = channel.port2;
  const done = attachFakeRpcHost(hostPort, opts.host ?? {});

  void runJsRealm(makeRealmInit(code, opts), realmPort as unknown as RealmPortLike).catch(() => {
    // runJsRealm posts `realm-error` on the port for engine-level failures,
    // which `attachFakeRpcHost` rejects with; nothing extra to do here.
  });

  const result = await done;
  hostPort.close();
  return result;
}

/** Run the same code+host in BOTH floats so a single test can assert parity. */
async function runBothFloats(
  code: string,
  opts: RunOpts = {}
): Promise<{ iframe: RealmDone; worker: RealmDone }> {
  const iframe = await runInIframeFloat(code, opts);
  const worker = await runInWorkerFloat(code, opts);
  return { iframe, worker };
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

describe('sandbox.html iframe float — CJS require error/edge parity (VAL-REQUIRE-012/014/015)', () => {
  it('VAL-REQUIRE-012: require("sharp") hard-fails with the native-module error (no CDN/node_modules path)', async () => {
    const code = "require('sharp');";
    const start = Date.now();
    const done = await runInIframeFloat(code);
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toContain('native module');
    expect(done.stderr).toContain('C++ bindings');
    expect(done.stderr).toContain("require('sharp')");
    // Distinct from the "Cannot find module" install hint; no CDN wording.
    expect(done.stderr).not.toContain('Cannot find module');
    expect(done.stderr).not.toContain('ipk install');
    expect(done.stderr).not.toContain('esm.sh');
    expect(done.stderr).not.toContain('jsdelivr');
    expect(elapsed).toBeLessThan(3000);
  });

  it('VAL-REQUIRE-012: the native hard-fail wins even with a node_modules folder present', async () => {
    const code = "const s = require('sqlite3'); console.log(s.real);";
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/node_modules/sqlite3/package.json': JSON.stringify({
            name: 'sqlite3',
            version: '5.0.0',
            main: 'index.js',
          }),
          '/workspace/node_modules/sqlite3/index.js':
            "module.exports = { real: 'should-not-load' };",
        },
      },
    });
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toContain('native module');
    expect(done.stdout).not.toContain('should-not-load');
  });

  it('VAL-REQUIRE-014: a package whose main points at a nonexistent file errors clearly and terminates', async () => {
    const code = "require('brokenmain');";
    const start = Date.now();
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/node_modules/brokenmain/package.json': JSON.stringify({
            name: 'brokenmain',
            version: '1.0.0',
            main: './nope.js',
          }),
        },
      },
    });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toMatch(/missing/);
    expect(done.stderr).toContain('nope.js');
    expect(elapsed).toBeLessThan(3000);
  });

  it('VAL-REQUIRE-014: a malformed package.json errors clearly and terminates', async () => {
    const code = "require('badmeta');";
    const start = Date.now();
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/node_modules/badmeta/package.json': '{ "name": "badmeta", not valid json',
          '/workspace/node_modules/badmeta/index.js': 'module.exports = 1;',
        },
      },
    });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toContain('Invalid package.json');
    expect(done.stderr).toContain('badmeta');
    expect(elapsed).toBeLessThan(3000);
  });

  it('VAL-REQUIRE-015: a relative a.js <-> b.js cycle resolves with partial exports and no hang', async () => {
    const code = `const a = require('./a.js');
      const b = require('./b.js');
      console.log(a.name, a.done, a.bValue);
      console.log(b.aNameWhenLoaded, String(b.aDoneWhenLoaded), b.value);`;
    const start = Date.now();
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/a.js': `
            exports.name = 'a';
            const b = require('./b.js');
            exports.bValue = b.value;
            module.exports.done = true;
          `,
          '/workspace/b.js': `
            const a = require('./a.js');
            exports.aNameWhenLoaded = a.name;
            exports.aDoneWhenLoaded = a.done;
            exports.value = 'b-value';
          `,
        },
      },
    });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    expect(done.stderr).not.toContain('Cannot find module');
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('a true b-value');
    expect(lines[1]).toBe('a undefined b-value');
    expect(elapsed).toBeLessThan(3000);
  });

  it('m4: a nested package require("os") hard-fails with the built-in-unavailable message (not Cannot find module)', async () => {
    const code = "const u = require('usesos'); u();";
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/node_modules/usesos/package.json': JSON.stringify({
            name: 'usesos',
            version: '1.0.0',
            main: 'index.js',
          }),
          '/workspace/node_modules/usesos/index.js':
            "const os = require('os'); module.exports = () => os.hostname();",
        },
      },
    });
    expect(done.exitCode).toBe(1);
    expect(done.stderr).toContain('not available in the browser');
    expect(done.stderr).toContain('os');
    expect(done.stderr).not.toContain('Cannot find module');
    expect(done.stderr).not.toContain('ipk install');
  });

  it('m5: require("crypto") / require("node:crypto") resolve to the Web Crypto bridge in the iframe float', async () => {
    const code = `const crypto = require('crypto');
      const aliased = require('node:crypto');
      const buf = new Uint8Array(8);
      const same = crypto.randomFillSync(buf) === buf;
      const filled = buf.some((b) => b !== 0);
      const uuid = crypto.randomUUID();
      const rb = crypto.randomBytes(16);
      const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      console.log(same, filled, v4.test(uuid), rb.length === 16, aliased === crypto);`;
    const done = await runInIframeFloat(code, {});
    expect(done.exitCode).toBe(0);
    expect(done.stderr).not.toContain('not available in the browser');
    expect(done.stderr).not.toContain('Cannot find module');
    expect(done.stdout.trim()).toBe('true true true true true');
  });

  it('NS3: require("util") resolves to the nodeUtil shim in the iframe float', async () => {
    const code = `const util = require('util');
      const fmt = util.format('%s=%d json=%j', 'x', 7, { a: 1 });
      const ins = util.inspect({ a: 1, b: [2, 3] });
      const doubled = await util.promisify((v, cb) => cb(null, v * 2))(21);
      console.log(fmt, '|', ins, '|', doubled);`;
    const done = await runInIframeFloat(code, {});
    expect(done.exitCode).toBe(0);
    expect(done.stderr).not.toContain('not available in the browser');
    expect(done.stdout.trim()).toBe('x=7 json={"a":1} | { a: 1, b: [ 2, 3 ] } | 42');
  });

  it('NS3: crypto.createHash computes md5/sha1/sha256 in the iframe float', async () => {
    const code = `const crypto = require('crypto');
      console.log(crypto.createHash('md5').update('abc').digest('hex'));
      console.log(crypto.createHash('sha1').update('abc').digest('hex'));
      console.log(crypto.createHash('sha256').update('abc').digest('hex'));`;
    const done = await runInIframeFloat(code, {});
    expect(done.exitCode).toBe(0);
    expect(done.stderr).not.toContain('not available in the browser');
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(lines[1]).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(lines[2]).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('NS3: require("zlib") round-trips gzip/deflate in the iframe float', async () => {
    const code = `const zlib = require('zlib');
      const text = 'hello hello hello zlib world';
      const back = zlib.gunzipSync(zlib.gzipSync(text)).toString();
      const inf = zlib.inflateSync(zlib.deflateSync(text)).toString();
      await new Promise((resolve, reject) => {
        zlib.gzip(text, (err, gz) => {
          if (err) return reject(err);
          zlib.gunzip(gz, (e2, out) => {
            if (e2) return reject(e2);
            console.log(back === text, inf === text, out.toString() === text);
            resolve();
          });
        });
      });`;
    const done = await runInIframeFloat(code, {});
    expect(done.exitCode).toBe(0);
    expect(done.stderr).not.toContain('not available in the browser');
    expect(done.stdout.trim()).toBe('true true true');
  });

  it('m4: a package that lazily guards an unavailable built-in loads cleanly in the iframe float', async () => {
    const code = "const m = require('lazyos'); console.log(m.tag);";
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/node_modules/lazyos/package.json': JSON.stringify({
            name: 'lazyos',
            version: '1.0.0',
            main: 'index.js',
          }),
          '/workspace/node_modules/lazyos/index.js':
            "module.exports = { host: () => require('os').hostname(), tag: 'loaded' };",
        },
      },
    });
    expect(done.exitCode).toBe(0);
    expect(done.stdout.trim()).toBe('loaded');
    expect(done.stderr).not.toContain('Cannot find module');
  });

  it('VAL-REQUIRE-015: a package-level cycle (pkg-a <-> pkg-b) terminates', async () => {
    const code = `const a = require('pkg-a');
      const b = require('pkg-b');
      console.log(a.tag, a.bTag, b.tag, b.aTagWhenLoaded);`;
    const start = Date.now();
    const done = await runInIframeFloat(code, {
      host: {
        files: {
          '/workspace/node_modules/pkg-a/package.json': JSON.stringify({
            name: 'pkg-a',
            version: '1.0.0',
            main: 'index.js',
          }),
          '/workspace/node_modules/pkg-a/index.js': `
            exports.tag = 'a';
            const b = require('pkg-b');
            exports.bTag = b.tag;
          `,
          '/workspace/node_modules/pkg-b/package.json': JSON.stringify({
            name: 'pkg-b',
            version: '1.0.0',
            main: 'index.js',
          }),
          '/workspace/node_modules/pkg-b/index.js': `
            const a = require('pkg-a');
            exports.tag = 'b';
            exports.aTagWhenLoaded = a.tag;
          `,
        },
      },
    });
    const elapsed = Date.now() - start;
    expect(done.exitCode).toBe(0);
    expect(done.stdout.trim()).toBe('a b b a');
    expect(elapsed).toBeLessThan(3000);
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

describe('harness fidelity: real iframe top-level script semantics + polyfilled Buffer', () => {
  // The two pinned facts below are what stop the factory-wrap regression
  // (top-level lexical leaks) and the ambient-Buffer regression (assertions
  // that pass on Node's Buffer even when the bundled polyfill is missing).
  // If either drifts back, every VAL-GLOBALS-015 / VAL-GLOBALS-009/010
  // result above would silently lose its meaning.

  it("a fresh AsyncFunction at global scope sees the inline script's top-level let/const", async () => {
    // `fetchIdCounter` is `let` at the top of the inline script;
    // `pendingFetch` is a top-level `const`. Neither is a property of
    // globalThis — they live in the global lexical environment. A real
    // iframe `<script>` followed by a `new Function/AsyncFunction(...)` call
    // resolves these via the global script-scope binding; that's the same
    // resolution path bare-capability identifiers (`exec`, `skill`, …) take
    // in user code. Asserting they resolve here proves the harness preserves
    // that resolution path — so any reintroduced top-level capability binding
    // would leak through the same channel and the bare-global tests above
    // would catch it.
    const asyncFnCtor = Object.getPrototypeOf(async function () {}).constructor as new (
      body: string
    ) => () => Promise<string>;
    const probe = new asyncFnCtor('return typeof fetchIdCounter + " " + typeof pendingFetch');
    expect(await probe()).toBe('number object');

    expect((globalThis as { fetchIdCounter?: unknown }).fetchIdCounter).toBeUndefined();
    expect((globalThis as { pendingFetch?: unknown }).pendingFetch).toBeUndefined();
  });

  it("globalThis.Buffer is the buffer-polyfill IIFE's constructor, not Node's ambient Buffer", async () => {
    const buf = (globalThis as { Buffer: { from: (s: string) => { toString(): string } } }).Buffer;
    expect(typeof buf).toBe('function');
    expect(buf.from('hello-from-polyfill').toString()).toBe('hello-from-polyfill');

    const code = `
      const direct = Buffer.from('via-async-function').toString();
      console.log(direct);
      console.log(Buffer === globalThis.Buffer);
    `;
    const done = await runInIframeFloat(code);
    expect(done.exitCode).toBe(0);
    const lines = done.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('via-async-function');
    expect(lines[1]).toBe('true');
  });
});

describe('VAL-REQUIRE-016: CJS require matrix — extension iframe float vs CLI worker float parity', () => {
  // The standalone browser-terminal harness cannot load the extension
  // `sandbox.html` float (chrome.runtime absent; /sandbox.html serves the
  // standalone app), so this behavioral harness is the option-D acceptance for
  // the extension-float side of VAL-REQUIRE-016. We execute the SAME require
  // matrix — an installed package, a relative require, a `.json` require, a
  // `node:` builtin, a `sliccy:` scheme, and an uninstalled hard-error — in the
  // real iframe float AND in the CLI/standalone worker float (`runJsRealm`, the
  // engine `js-realm-worker.ts` runs) against a byte-identical fake RPC host,
  // and assert the two floats produce identical stdout, stderr (including the
  // exact `Cannot find module ... (run: ipk install ...)` text), and exit/throw
  // behavior. The real-browser extension e2e remains BLOCKED by design.

  const MATRIX_FILES: Record<string, string> = {
    '/workspace/node_modules/is-number/package.json': JSON.stringify({
      name: 'is-number',
      version: '7.0.0',
      main: 'index.js',
    }),
    '/workspace/node_modules/is-number/index.js':
      'module.exports = function isNumber(n) { return typeof n === "number" && n - n === 0; };',
    '/workspace/local.js': 'module.exports = { tag: "local-ok" };',
    '/workspace/data.json': JSON.stringify({ answer: 42 }),
  };

  // Installed pkg, relative, .json, node: builtin, sliccy: scheme, and an
  // uninstalled hard-error (caught so the whole matrix runs in one script and
  // its exact `Cannot find module ...` message is captured on stdout).
  const MATRIX_CODE = `
    console.log('pkg', typeof require('is-number'), require('is-number')(5));
    console.log('relative', require('./local.js').tag);
    console.log('json', require('./data.json').answer);
    console.log('node', require('node:path').join('a', 'b'));
    console.log('sliccy', require('sliccy:time').parseDuration('1h'));
    try { require('not-installed'); console.log('UNEXPECTED'); }
    catch (e) { console.log('missing', e.message); }
  `;

  const EXPECTED_MATRIX_LINES = [
    'pkg function true',
    'relative local-ok',
    'json 42',
    'node a/b',
    'sliccy 3600000',
    "missing Cannot find module 'not-installed' (run: ipk install not-installed)",
  ];

  it('the full require matrix resolves byte-identically across both floats', async () => {
    const { iframe, worker } = await runBothFloats(MATRIX_CODE, { host: { files: MATRIX_FILES } });

    // Each float, on its own, produced the expected matrix output and exit 0.
    expect(worker.exitCode).toBe(0);
    expect(iframe.exitCode).toBe(0);
    expect(worker.stdout.split('\n').filter(Boolean)).toEqual(EXPECTED_MATRIX_LINES);
    expect(iframe.stdout.split('\n').filter(Boolean)).toEqual(EXPECTED_MATRIX_LINES);

    // The headline parity assertion: identical stdout, stderr, and exit code.
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);

    // Neither float retains a CDN fallback for any matrix entry.
    for (const r of [iframe, worker]) {
      expect(r.stdout).not.toContain('esm.sh');
      expect(r.stdout).not.toContain('jsdelivr');
      expect(r.stderr).not.toContain('esm.sh');
      expect(r.stderr).not.toContain('jsdelivr');
    }
  });

  it('an uninstalled bare require throws + exits non-zero with the exact install hint in both floats', async () => {
    const code = "require('not-installed');";
    const { iframe, worker } = await runBothFloats(code);
    const expectedErr = "Cannot find module 'not-installed' (run: ipk install not-installed)";

    // Throw/exit behavior is identical: a hard non-zero exit in both floats.
    expect(worker.exitCode).toBe(1);
    expect(iframe.exitCode).toBe(1);
    expect(iframe.exitCode).toBe(worker.exitCode);

    // The exact install-hint text appears in BOTH floats' stderr.
    expect(worker.stderr).toContain(expectedErr);
    expect(iframe.stderr).toContain(expectedErr);

    // No CDN fallback / legacy esm.sh wording, immediate failure (no prefetch).
    for (const r of [iframe, worker]) {
      expect(r.stderr).not.toContain('esm.sh');
      expect(r.stderr).not.toContain('jsdelivr');
      expect(r.stdout).toBe('');
    }
  });

  it.each([
    ['installed package', "console.log(typeof require('is-number'), require('is-number')(5));"],
    ['relative require', "console.log(require('./local.js').tag);"],
    ['.json require', "console.log(require('./data.json').answer);"],
    ['node: builtin', "console.log(require('node:path').join('a', 'b'));"],
    ['sliccy: scheme', "console.log(require('sliccy:time').parseDuration('1h'));"],
  ])('matrix entry "%s" produces identical stdout/stderr/exit across floats', async (_label, code) => {
    const { iframe, worker } = await runBothFloats(code, { host: { files: MATRIX_FILES } });
    expect(worker.exitCode).toBe(0);
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);
  });
});

describe('VAL-GLOBALS-016: ESM sliccy: import + unknown-name error — dual-float parity', () => {
  // The host-side ESM->CJS transpile runs in `realm-host.ts` (identical for both
  // floats); the iframe-float evaluator just runs the transpiled CJS. esbuild's
  // load-time `TextEncoder` invariant fails under jsdom (and importing the real
  // `createEntryTranspile` pulls esbuild-wasm in at module load), so this injects
  // the SAME TypeScript lowering `createEntryTranspile` falls back to —
  // `import ... from 'sliccy:exec'` -> `require('sliccy:exec')`, top-level await
  // preserved under `module: CommonJS` — so the parity assertion still exercises
  // the real iframe ESM access path against a byte-identical host transform.
  const tsEntryTranspile: EntryTranspile = async ({ source, filename }) => {
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: `${(filename || '[eval]').replace(/\.[^./]+$/, '')}.ts`,
    });
    return out.outputText;
  };

  const echoHost = {
    exec: async (cmd: string) => ({
      stdout: `${cmd.replace(/^echo\s+/, '')}\n`,
      stderr: '',
      exitCode: 0,
    }),
    transpileEntry: tsEntryTranspile,
  };

  it('static named `import { exec } from "sliccy:exec"` resolves and runs identically in both floats', async () => {
    const code = [
      "import { exec } from 'sliccy:exec';",
      "const r = await exec('echo esm-sliccy');",
      'console.log(r.stdout.trim());',
    ].join('\n');
    const { iframe, worker } = await runBothFloats(code, { host: echoHost });

    expect(worker.exitCode).toBe(0);
    expect(iframe.exitCode).toBe(0);
    expect(worker.stdout.trim()).toBe('esm-sliccy');
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);
  });

  it('default `import exec from "sliccy:exec"` resolves and runs identically in both floats', async () => {
    const code = [
      "import exec from 'sliccy:exec';",
      "const r = await exec('echo esm-default');",
      'console.log(r.stdout.trim());',
    ].join('\n');
    const { iframe, worker } = await runBothFloats(code, { host: echoHost });

    expect(worker.exitCode).toBe(0);
    expect(worker.stdout.trim()).toBe('esm-default');
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);
  });

  it("require('sliccy:bogus') throws the same scheme-specific error in both floats", async () => {
    const code = `
      try { require('sliccy:bogus'); console.log('UNEXPECTED'); }
      catch (e) { console.log(e.message); }
    `;
    const { iframe, worker } = await runBothFloats(code);

    expect(worker.exitCode).toBe(0);
    expect(worker.stdout).toContain("unknown sliccy: module 'bogus'");
    expect(worker.stdout).not.toContain('run: ipk install');
    // Headline parity: byte-identical error surface across floats.
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);
  });
});

describe('VAL-ESM-015: dual-float ESM parity + CSP-safe execution (no native import())', () => {
  // VAL-ESM-015 asks that the default import, named import, dynamic import,
  // CJS<->ESM interop, and `sliccy:` import each produce byte-identical output
  // in the extension `sandbox.html` float and the CLI worker float, and that in
  // the extension float ESM runs under the sandbox CSP with NO native `import()`
  // (served by the host transpile + uniform CJS graph). The host transpile is
  // float-agnostic (it runs in `realm-host.ts`, identical for both floats);
  // here we drive the iframe-float evaluator (`bootstrapRealmPort`) and the CLI
  // worker-float engine (`runJsRealm`) against a byte-identical host that
  // transpiles the SAME ESM source for both, and assert identical output.
  //
  // esbuild can't load under jsdom (its `TextEncoder` init invariant fails), so
  // — exactly as VAL-GLOBALS-016 does for the entry — we inject TypeScript-only
  // module + entry transpiles (the same lowering `createEsmTranspile` /
  // `createEntryTranspile` fall back to). The real esbuild transpile correctness
  // is the node-env webapp ESM suites' job; here we prove EVALUATOR parity.
  // Real-browser extension e2e remains BLOCKED by design.
  const tsModuleTranspile: ModuleTranspile = async ({ source, path, kind }) => {
    if (kind !== 'esm') return source;
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: `${path.replace(/\.[^./]+$/, '')}.ts`,
    });
    return out.outputText;
  };
  const tsEntryTranspile: EntryTranspile = async ({ source, filename }) => {
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: `${(filename || '[eval]').replace(/\.[^./]+$/, '')}.ts`,
    });
    return out.outputText;
  };

  const ESM_FILES: Record<string, string> = {
    '/workspace/node_modules/esm-pkg/package.json': JSON.stringify({
      name: 'esm-pkg',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    }),
    '/workspace/node_modules/esm-pkg/index.js': [
      "export const named = () => 'named-ok';",
      "export default function def() { return 'default-ok'; }",
    ].join('\n'),
    '/workspace/node_modules/cjs-pkg/package.json': JSON.stringify({
      name: 'cjs-pkg',
      version: '1.0.0',
      main: 'index.js',
    }),
    '/workspace/node_modules/cjs-pkg/index.js': "module.exports = { merge: () => 'merged' };",
  };
  const esmHost = {
    files: ESM_FILES,
    transpileModule: tsModuleTranspile,
    transpileEntry: tsEntryTranspile,
    exec: async (cmd: string) => ({
      stdout: `${cmd.replace(/^echo\s+/, '')}\n`,
      stderr: '',
      exitCode: 0,
    }),
  };

  /** Assert both floats produced identical output and neither hit a CDN. */
  function expectFloatParity(iframe: RealmDone, worker: RealmDone, expectedStdout: string): void {
    expect(worker.exitCode).toBe(0);
    expect(iframe.exitCode).toBe(0);
    expect(worker.stdout.trim()).toBe(expectedStdout);
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);
    for (const r of [iframe, worker]) {
      expect(r.stdout).not.toContain('esm.sh');
      expect(r.stdout).not.toContain('jsdelivr');
      expect(r.stderr).not.toContain('esm.sh');
      expect(r.stderr).not.toContain('jsdelivr');
    }
  }

  it('default import of an ESM package is byte-identical across floats', async () => {
    const code = "import def from 'esm-pkg';\nconsole.log(def());";
    const { iframe, worker } = await runBothFloats(code, { host: esmHost });
    expectFloatParity(iframe, worker, 'default-ok');
  });

  it('named import of an ESM package is byte-identical across floats', async () => {
    const code = "import { named } from 'esm-pkg';\nconsole.log(named());";
    const { iframe, worker } = await runBothFloats(code, { host: esmHost });
    expectFloatParity(iframe, worker, 'named-ok');
  });

  it('dynamic import of an ESM package is byte-identical across floats', async () => {
    const code = "import('esm-pkg').then(m => console.log(typeof m.default, m.named()));";
    const { iframe, worker } = await runBothFloats(code, { host: esmHost });
    expectFloatParity(iframe, worker, 'function named-ok');
  });

  it('CJS require() of an ESM package (interop namespace) is byte-identical across floats', async () => {
    const code =
      "const m = require('esm-pkg'); console.log(m.__esModule === true, typeof m.default, m.default(), m.named());";
    const { iframe, worker } = await runBothFloats(code, { host: esmHost });
    expectFloatParity(iframe, worker, 'true function default-ok named-ok');
  });

  it('ESM import of a CJS package (default-interop) is byte-identical across floats', async () => {
    const code = "import _ from 'cjs-pkg';\nconsole.log(_.merge());";
    const { iframe, worker } = await runBothFloats(code, { host: esmHost });
    expectFloatParity(iframe, worker, 'merged');
  });

  it('`sliccy:` ESM import is byte-identical across floats', async () => {
    const code = [
      "import { exec } from 'sliccy:exec';",
      "const r = await exec('echo esm15-sliccy');",
      'console.log(r.stdout.trim());',
    ].join('\n');
    const { iframe, worker } = await runBothFloats(code, { host: esmHost });
    expectFloatParity(iframe, worker, 'esm15-sliccy');
  });
});

describe('VAL-ESM-015: sandbox.html executes ESM CSP-safely (no native import() of remote code)', () => {
  // The CSP-safety guarantee is structural: the extension `sandbox.html` realm
  // must NEVER call a native dynamic `import()` (the manifest sandbox CSP allows
  // `Function`/`eval` but not a cross-origin `import()` of remote code). ESM is
  // served entirely by the host transpile -> uniform CJS graph, evaluated with
  // `new Function`/`AsyncFunction`. Guard against a regression reintroducing a
  // native `import()` or a CDN module URL into the inline realm script.
  it('the inline realm script contains no native dynamic import()', () => {
    // Strip string/template literals and comments so an `import(` inside an
    // explanatory comment or a logged string cannot mask a real call site.
    const stripped = INLINE_SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    expect(stripped).not.toMatch(/\bimport\s*\(/);
  });

  it('the inline realm script makes no executable CDN module fetch', () => {
    // CDN host names still appear in explanatory comments (the rewire removed
    // the executable path, not the prose). Strip comments + string/template
    // literals so only a live reference to a CDN module URL would match.
    const stripped = INLINE_SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    expect(stripped).not.toMatch(/esm\.sh/);
    expect(stripped).not.toMatch(/jsdelivr/);
    expect(stripped).not.toMatch(/unpkg/);
  });

  it('the inline realm script evaluates module sources via Function (the CSP-safe seam)', () => {
    // The CJS factory + entry wrapper are built with `new Function` /
    // `AsyncFunction`, which the sandbox CSP permits — this is the seam that
    // replaces a native `import()` of remote code.
    expect(INLINE_SCRIPT).toMatch(/new Function\(/);
    expect(INLINE_SCRIPT).toMatch(/AsyncFunction/);
  });
});

describe('VAL-IPX-012: entry sloppy (CJS) vs strict (ESM) — dual-float parity', () => {
  // Node runs a CommonJS entry in SLOPPY mode and an ES-module entry in STRICT
  // mode. The realm must match this at the ENTRY layer: the `"use strict"`
  // wrapper prefix is applied ONLY when the entry is ESM-derived (transpiled to
  // `graph.entrySource`). These cases prove the conditional BEHAVIORALLY in both
  // the iframe (`sandbox.html`) float and the CLI worker (`runJsRealm`) float.
  //
  // The CJS case needs no transpile (no import/export). The ESM case injects a
  // TypeScript-only entry transpile with `noImplicitUseStrict` so the emitted
  // CJS body carries NO "use strict" of its own — strictness then comes purely
  // from the realm's conditional wrapper prefix, isolating exactly the behavior
  // under test (esbuild can't load under jsdom, mirroring VAL-GLOBALS-016).
  const tsEntryTranspileNoImplicitStrict: EntryTranspile = async ({ source, filename }) => {
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        noImplicitUseStrict: true,
      },
      fileName: `${(filename || '[eval]').replace(/\.[^./]+$/, '')}.ts`,
    });
    return out.outputText;
  };

  it('a plain-CJS entry using a strict-only reserved word runs sloppy (prints 42) in both floats', async () => {
    // No import/export, so `graph.entrySource` stays undefined and the entry
    // runs verbatim WITHOUT a "use strict" prefix; `var implements` is a legal
    // identifier in sloppy mode, exactly as Node runs a `node <script.js>` /
    // `node -e` / ipx bin entry.
    const code = 'var implements = 41;\nconsole.log(implements + 1);';
    const { iframe, worker } = await runBothFloats(code);

    expect(worker.exitCode).toBe(0);
    expect(iframe.exitCode).toBe(0);
    expect(worker.stdout.trim()).toBe('42');
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.stderr).toBe(worker.stderr);
    expect(iframe.exitCode).toBe(worker.exitCode);
  });

  it('an ESM entry stays strict (undeclared-assignment throws) in both floats', async () => {
    // `export {}` marks the entry ESM-derived → `graph.entrySource` is set →
    // the wrapper prepends "use strict". Assigning to an undeclared identifier
    // throws a ReferenceError in strict mode but silently creates a global in
    // sloppy mode, so the throw proves the entry runs strict. (A runtime
    // violation is used over the `var implements` parse error so it fails the
    // SAME way INSIDE the evaluator's try/catch in both floats — a parse error
    // throws at AsyncFunction construction, which the worker float surfaces as
    // a realm-error rather than an exit code.)
    const code =
      "import 'sliccy:time';\nesmStrictProbe = 7;\nconsole.log('ran:' + esmStrictProbe);";
    const host = { transpileEntry: tsEntryTranspileNoImplicitStrict };
    const { iframe, worker } = await runBothFloats(code, { host });

    expect(worker.exitCode).toBe(1);
    expect(iframe.exitCode).toBe(1);
    expect(worker.stderr).toContain('esmStrictProbe');
    expect(worker.stderr).toMatch(/not defined/);
    expect(worker.stdout).not.toContain('ran:');
    expect(iframe.stdout).toBe(worker.stdout);
    expect(iframe.exitCode).toBe(worker.exitCode);
  });
});
