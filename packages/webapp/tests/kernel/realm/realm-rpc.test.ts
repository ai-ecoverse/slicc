/**
 * Tests for realm RPC client + host.
 *
 * Uses a fake `MessagePort` pair (two `RealmPortLike` shims wired
 * to each other) so we can drive both ends of the protocol in
 * vitest without real workers / iframes.
 *
 * Critical assertion: the fetch channel routes through `ctx.fetch`
 * (just-bash `SecureFetch`), NOT `globalThis.fetch`. Without that,
 * masked secret values would bypass the proxy.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';

interface PortPair {
  realm: RealmPortLike;
  host: RealmPortLike;
}

function makePortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: RealmPortLike = {
    postMessage: (msg) => {
      // Posts FROM realm go TO host.
      for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_type, handler) => {
      realmListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      realmListeners.delete(handler);
    },
  };
  const host: RealmPortLike = {
    postMessage: (msg) => {
      // Posts FROM host go TO realm.
      for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_type, handler) => {
      hostListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      hostListeners.delete(handler);
    },
  };
  return { realm, host };
}

function makeMockFs(files: Record<string, string> = {}): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const fs: IFileSystem = {
    async readFile(path: string) {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async readFileBuffer(path: string) {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(content);
    },
    async writeFile(path: string, content: string | Uint8Array) {
      store.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async appendFile() {
      /* noop */
    },
    async exists(path: string) {
      return store.has(path);
    },
    async stat(path: string): Promise<FsStat> {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: (store.get(path) || '').length,
        mtime: new Date(),
      };
    },
    async mkdir() {
      /* noop */
    },
    async readdir() {
      return [...store.keys()];
    },
    async rm(path: string) {
      store.delete(path);
    },
    async cp() {
      /* noop */
    },
    async mv() {
      /* noop */
    },
    resolvePath(base: string, path: string): string {
      if (path.startsWith('/')) return path;
      return base === '/' ? `/${path}` : `${base}/${path}`;
    },
    getAllPaths() {
      return [...store.keys()];
    },
    async chmod() {
      /* noop */
    },
    async symlink() {
      /* noop */
    },
    async link() {
      /* noop */
    },
    async readlink() {
      return '';
    },
    async lstat(path: string) {
      return fs.stat(path);
    },
    async realpath(path: string) {
      return path;
    },
    async utimes() {
      /* noop */
    },
  };
  return fs;
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    fs: makeMockFs(),
    cwd: '/workspace',
    env: new Map(),
    stdin: '',
    ...overrides,
  } as CommandContext;
}

describe('realm RPC: vfs channel', () => {
  it('round-trips readFile through ctx.fs.resolvePath + ctx.fs.readFile', async () => {
    const ctx = makeCtx({ fs: makeMockFs({ '/workspace/data.txt': 'hello' }) });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const result = await client.call<string>('vfs', 'readFile', ['data.txt']);
    expect(result).toBe('hello');
    client.dispose();
  });

  it('writeFile persists through to ctx.fs', async () => {
    const fs = makeMockFs();
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await client.call('vfs', 'writeFile', ['/tmp/out.txt', 'written']);
    expect(await fs.readFile('/tmp/out.txt')).toBe('written');
    client.dispose();
  });

  it('readDir returns entries from ctx.fs', async () => {
    const ctx = makeCtx({ fs: makeMockFs({ '/a': '1', '/b': '2' }) });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const entries = await client.call<string[]>('vfs', 'readDir', ['/']);
    expect(entries).toEqual(expect.arrayContaining(['/a', '/b']));
    client.dispose();
  });

  it('rejects unknown vfs ops with a clear error', async () => {
    const ctx = makeCtx();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await expect(client.call('vfs', 'unknownOp', [])).rejects.toThrow(/unknown vfs op/);
    client.dispose();
  });
});

describe('realm RPC: exec channel', () => {
  it('routes exec call through ctx.exec', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'output\n', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const result = await client.call<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>('exec', 'run', ['echo hi']);
    expect(result).toEqual({ stdout: 'output\n', stderr: '', exitCode: 0 });
    expect(exec).toHaveBeenCalledWith('echo hi', { cwd: '/workspace' });
    client.dispose();
  });

  it('errors clearly when ctx.exec is missing', async () => {
    const ctx = makeCtx({ exec: undefined });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await expect(client.call('exec', 'run', ['ls'])).rejects.toThrow(/exec is not available/);
    client.dispose();
  });

  it('exec.spawn forwards argv tail via just-bash `args` (no shell parsing)', async () => {
    // The quoting-trap canary: a literal `$peculiar` and an arg with
    // spaces. Both MUST land in the `args` option verbatim — if they
    // get folded into the command string they'd be word-split and
    // env-expanded by the shell, which is exactly what spawn() exists
    // to prevent.
    const exec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const result = await client.call<{ stdout: string; stderr: string; exitCode: number }>(
      'exec',
      'spawn',
      [['echo', 'arg with spaces', '$peculiar', '* glob']]
    );
    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(exec).toHaveBeenCalledWith('echo', {
      cwd: '/workspace',
      args: ['arg with spaces', '$peculiar', '* glob'],
    });
    client.dispose();
  });

  it('exec.spawn rejects a non-array argv', async () => {
    const exec = vi.fn();
    const ctx = makeCtx({ exec });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await expect(client.call('exec', 'spawn', ['not-an-array'])).rejects.toThrow(
      /argv must be a non-empty string\[\]/
    );
    await expect(client.call('exec', 'spawn', [[]])).rejects.toThrow(
      /argv must be a non-empty string\[\]/
    );
    await expect(client.call('exec', 'spawn', [['cmd', 42]])).rejects.toThrow(
      /argv must be a non-empty string\[\]/
    );
    expect(exec).not.toHaveBeenCalled();
    client.dispose();
  });
});

describe('realm RPC: vfs.writeFile size cap', () => {
  it('round-trips a 4 MiB string without skill-side chunking', async () => {
    // The Concur skill (lines 80–110) used to base64-chunk content
    // through a shell heredoc because `cat << EOF` had an argv cap.
    // `fs.writeFile` is the canonical escape hatch: it ships the
    // string through structured clone on the realm port, no shell
    // argv involved. Pin the contract so a regression in the RPC
    // path can't quietly reintroduce the cap.
    const FOUR_MIB = 4 * 1024 * 1024;
    const huge = 'x'.repeat(FOUR_MIB);
    const fs = makeMockFs();
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await client.call('vfs', 'writeFile', ['/tmp/huge.txt', huge]);
    const persisted = await fs.readFile('/tmp/huge.txt');
    expect(persisted.length).toBe(FOUR_MIB);
    expect(persisted.startsWith('xxxx')).toBe(true);
    expect(persisted.endsWith('xxxx')).toBe(true);
    client.dispose();
  });
});

describe('realm RPC: vfs.readFileBinary large-payload boundary', () => {
  it('round-trips a >37 MiB binary payload through readFileBinary with no size cap', async () => {
    // Ceiling investigation for the realm-worker WASM kill (PR #1085):
    // biome's 37 MB `biome_wasm_bg.wasm` hard-kills the per-task realm
    // DedicatedWorker at `WebAssembly.compile` (esbuild's ~13.9 MB wasm
    // compiles fine). This pins that the realm-host RPC boundary
    // (`dispatchVfs.readFileBinary` → `collectTransferables` →
    // `port.postMessage`) is NOT the ceiling: a payload LARGER than
    // biome's wasm crosses the boundary byte-for-byte. There is
    // deliberately no byte-length guard / chunk cap on this path, so the
    // EXT5 kill lives strictly downstream in the browser's
    // `WebAssembly.compile`, which exposes no JS-settable memory knob
    // (a browser `Worker` takes only `{ type }`; nothing here uses
    // `worker_threads` `resourceLimits`). The fake port pair passes the
    // object reference rather than structured-cloning it — same modeling
    // limit as the 4 MiB writeFile cap test above — so this guards the
    // protocol layer (no guard rejects the payload), not real transfer.
    const FORTY_MIB = 40 * 1024 * 1024;
    // Prefix the WASM magic + version so the blob reads as the kind of
    // payload this boundary actually carries, then pad past 37 MB.
    const header = '\x00asm\x01\x00\x00\x00';
    const payload = header + 'b'.repeat(FORTY_MIB - header.length);
    const fs = makeMockFs({ '/workspace/biome_wasm_bg.wasm': payload });
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const bytes = await client.call<Uint8Array>('vfs', 'readFileBinary', ['biome_wasm_bg.wasm']);
    expect(bytes.byteLength).toBe(FORTY_MIB);
    // WASM magic survives intact at the head…
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
    // …and the tail is uncorrupted.
    expect(bytes[FORTY_MIB - 1]).toBe('b'.charCodeAt(0));
    client.dispose();
  });
});

describe('realm RPC: fetch channel', () => {
  it('routes fetch through ctx.fetch (NOT globalThis.fetch) — secret invariant', async () => {
    // Critical: secrets are substituted server-side via the
    // SecureFetch path (createNodeFetchAdapter wraps ctx.fetch).
    // If the host ever calls globalThis.fetch directly, masked
    // secret values get sent to upstream APIs literally and break
    // every secret-gated call. Pin the routing here.
    const ctxFetch = vi.fn().mockResolvedValue({
      url: 'https://example.com/',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: 'response-bytes',
    });
    const ctx = makeCtx({ fetch: ctxFetch });
    const globalFetch = vi.fn();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch =
      globalFetch as unknown as typeof globalThis.fetch;
    try {
      const { realm, host } = makePortPair();
      attachRealmHost(host, ctx);
      const client = new RealmRpcClient(realm);
      const result = await client.call<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: Uint8Array;
        url: string;
      }>('fetch', 'request', ['https://example.com/']);
      expect(ctxFetch).toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
      expect(result.status).toBe(200);
      // Body bytes round-trip cleanly.
      expect(new TextDecoder().decode(result.body)).toBe('response-bytes');
      client.dispose();
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });

  it('falls back to globalThis.fetch when ctx.fetch is absent', async () => {
    const fakeResponse = new Response('global-bytes', {
      status: 201,
      statusText: 'Created',
      headers: { 'x-custom': 'yes' },
    });
    const globalFetch = vi.fn().mockResolvedValue(fakeResponse);
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch =
      globalFetch as unknown as typeof globalThis.fetch;
    try {
      const ctx = makeCtx({ fetch: undefined });
      const { realm, host } = makePortPair();
      attachRealmHost(host, ctx);
      const client = new RealmRpcClient(realm);
      const result = await client.call<{
        status: number;
        body: Uint8Array;
      }>('fetch', 'request', ['https://example.com/']);
      expect(globalFetch).toHaveBeenCalled();
      expect(result.status).toBe(201);
      expect(new TextDecoder().decode(result.body)).toBe('global-bytes');
      client.dispose();
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
  });
});

describe('realm RPC: client lifecycle', () => {
  it('rejects pending calls on dispose', async () => {
    const { realm } = makePortPair();
    // No host attached — the request hangs forever otherwise.
    const client = new RealmRpcClient(realm);
    const pending = client.call('vfs', 'readFile', ['/x']);
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('rejects new calls after dispose', async () => {
    const { realm } = makePortPair();
    const client = new RealmRpcClient(realm);
    client.dispose();
    await expect(client.call('vfs', 'readFile', ['/x'])).rejects.toThrow(/disposed/);
  });
});
