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
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePath, splitPath } from '../../webapp/src/fs/path-utils.js';
import { buildModuleGraph } from '../../webapp/src/shell/ipk/module-loader.js';
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
 * Mirror `realm-host.ts dispatchModule`: resolve each entry specifier in
 * isolation so one broken/uninstalled entry surfaces as `errors[specifier]`
 * without sinking the others, then merge the per-entry graphs.
 */
async function buildGraphForHost(
  reader: ModuleReader,
  entrySpecifiers: string[],
  fromDir: string
): Promise<{
  files: Array<{ path: string; cjsSource: string; kind: string }>;
  entryMap: Record<string, string>;
  edges: Record<string, Record<string, string>>;
  errors: Record<string, string>;
}> {
  const filesByPath = new Map<string, { path: string; cjsSource: string; kind: string }>();
  const order: string[] = [];
  const entryMap: Record<string, string> = {};
  const edges: Record<string, Record<string, string>> = {};
  const errors: Record<string, string> = {};
  for (const specifier of entrySpecifiers) {
    try {
      const graph = await buildModuleGraph({ entrySpecifiers: [specifier], fromDir, reader });
      for (const file of graph.files) {
        if (!filesByPath.has(file.path)) {
          filesByPath.set(file.path, {
            path: file.path,
            cjsSource: file.cjsSource,
            kind: file.kind,
          });
          order.push(file.path);
        }
      }
      Object.assign(entryMap, graph.entryMap);
      for (const [path, fileEdges] of Object.entries(graph.edges)) {
        edges[path] = { ...(edges[path] ?? {}), ...fileEdges };
      }
    } catch (err) {
      errors[specifier] = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    files: order.map((p) => filesByPath.get(p)!),
    entryMap,
    edges,
    errors,
  };
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
      } else if (req.channel === 'module' && req.op === 'buildGraph') {
        const entrySpecifiers = (req.args?.[0] as string[]) ?? [];
        const fromDir = (req.args?.[1] as string) ?? '/workspace';
        const reader = makeModuleReader(host.files ?? {});
        result = await buildGraphForHost(reader, entrySpecifiers, fromDir);
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
