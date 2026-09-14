import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { initSyncFsCache } from '../../../src/kernel/realm/js-realm-shared.js';
import { createExecBridge } from '../../../src/kernel/realm/realm-exec-bridge.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import { SyncFsCache, type SyncFsSnapshot } from '../../../src/kernel/realm/sync-fs-cache.js';

interface PortPair {
  realm: RealmPortLike;
  host: RealmPortLike;
}

function makePortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: RealmPortLike = {
    postMessage: (msg) => {
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
    async appendFile() {},
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
    async mkdir() {},
    async readdir() {
      return [...store.keys()];
    },
    async rm(path: string) {
      store.delete(path);
    },
    async cp() {},
    async mv() {},
    resolvePath(base: string, path: string): string {
      if (path.startsWith('/')) return path;
      return base === '/' ? `/${path}` : `${base}/${path}`;
    },
    getAllPaths() {
      return [...store.keys()];
    },
    async chmod() {},
    async symlink() {},
    async link() {},
    async readlink() {
      return '';
    },
    async lstat(path: string) {
      return fs.stat(path);
    },
    async realpath(path: string) {
      return path;
    },
    async utimes() {},
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

describe('realm RPC: exec.start / exec.kill (kill + buffered stdin)', () => {
  it('exec.start resolves the handle done-promise with the buffered result', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start('echo hi');
    handle.stdin.end();
    const result = await handle.done;

    expect(result).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });

    const [cmd, options] = exec.mock.calls[0];
    expect(cmd).toBe('echo hi');
    expect(options.cwd).toBe('/workspace');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    client.dispose();
  });

  it('buffered stdin (write + end) is delivered as the command stdin', async () => {
    const exec = vi.fn(async (_cmd: string, options: { stdin?: string }) => ({
      stdout: options.stdin ?? '',
      stderr: '',
      exitCode: 0,
    }));
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start('cat');
    handle.stdin.write('hel');
    handle.stdin.write('lo');
    handle.stdin.end();
    const result = await handle.done;

    expect(result.stdout).toBe('hello');
    expect(exec).toHaveBeenCalledWith('cat', expect.objectContaining({ stdin: 'hello' }));
    client.dispose();
  });

  it('array-argv form threads the tail through just-bash `args` (shell-free)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start(['echo', 'arg with spaces', '$peculiar']);
    handle.stdin.end();
    await handle.done;

    expect(exec).toHaveBeenCalledWith(
      'echo',
      expect.objectContaining({ args: ['arg with spaces', '$peculiar'] })
    );
    client.dispose();
  });

  it('registers a live PM process per spawn and removes it (ps) on settle', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'scoop', scoopJid: 'jid-1' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start('echo hi');
    handle.stdin.end();
    await handle.done;

    const all = pm.list();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('shell');
    expect(all[0].owner.scoopJid).toBe('jid-1');

    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(0);
    expect(all[0].exitCode).toBe(0);
    client.dispose();
  });

  it('handle.kill() aborts a long-running command; exit reflects termination; ps drops it', async () => {
    const exec = vi.fn(
      (_cmd: string, options: { signal?: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          options.signal?.addEventListener('abort', () => {
            resolve({ stdout: '', stderr: 'terminated\n', exitCode: 143 });
          });
        })
    );
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start('sleep 100');
    handle.stdin.end();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(1);

    const delivered = await handle.kill();
    expect(delivered).toBe(true);

    const result = await handle.done;
    expect(result.exitCode).toBe(143);

    const running = pm.list().filter((p) => p.status === 'running');
    expect(running).toHaveLength(0);
    const proc = pm.list()[0];
    expect(proc.terminatedBy).toBe('SIGTERM');
    expect(proc.status).toBe('killed');
    client.dispose();
  });

  it('kill of an unknown / already-settled spawn returns false', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);

    await expect(client.call<boolean>('exec', 'kill', [9999])).resolves.toBe(false);

    const bridge = createExecBridge(client);
    const handle = bridge.start('echo hi');
    handle.stdin.end();
    await handle.done;
    await expect(handle.kill()).resolves.toBe(false);
    client.dispose();
  });

  it('back-compat: exec() and exec.spawn() through the bridge are unchanged', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    await expect(bridge('ls')).resolves.toEqual({ stdout: 'out', stderr: '', exitCode: 0 });
    expect(exec).toHaveBeenCalledWith('ls', { cwd: '/workspace' });

    await expect(bridge.spawn(['ls', '-la'])).resolves.toEqual({
      stdout: 'out',
      stderr: '',
      exitCode: 0,
    });
    expect(exec).toHaveBeenLastCalledWith('ls', { cwd: '/workspace', args: ['-la'] });
    client.dispose();
  });
});

describe('realm RPC: exec.start / exec.kill review fixes (PR #1402)', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('a pre-start kill() prevents the command from launching and resolves done as terminated', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'ran\n', stderr: '', exitCode: 0 });
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start('rm -rf /');

    const delivered = await handle.kill('SIGKILL');
    expect(delivered).toBe(true);

    handle.stdin.end();
    const result = await handle.done;
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 137 });
    await tick();
    expect(exec).not.toHaveBeenCalled();
    client.dispose();
  });

  it('pre-start kill exit code reflects the signal (default SIGTERM=143, SIGINT=130)', async () => {
    const exec = vi.fn();
    const ctx = makeCtx({ exec });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const h1 = bridge.start('a');
    await h1.kill();
    expect((await h1.done).exitCode).toBe(143);

    const h2 = bridge.start('b');
    await h2.kill('SIGINT');
    expect((await h2.done).exitCode).toBe(130);

    expect(exec).not.toHaveBeenCalled();
    client.dispose();
  });

  it('rejects a duplicate spawnId instead of clobbering a live spawn', async () => {
    const exec = vi.fn(
      (_cmd: string, options: { signal?: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          options.signal?.addEventListener('abort', () =>
            resolve({ stdout: '', stderr: '', exitCode: 143 })
          );
        })
    );
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);

    const live = client.call('exec', 'start', [1, 'sleep 100', {}]);
    await tick();
    await expect(client.call('exec', 'start', [1, 'echo hi', {}])).rejects.toThrow(
      /spawnId 1 is already in use/
    );

    await expect(client.call<boolean>('exec', 'kill', [1])).resolves.toBe(true);
    await expect(live).resolves.toEqual({ stdout: '', stderr: '', exitCode: 143 });
    client.dispose();
  });

  it('validates stdin / stdinKind / args shapes before running the command', async () => {
    const exec = vi.fn();
    const ctx = makeCtx({ exec });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);

    await expect(client.call('exec', 'start', [1, 'echo', { stdin: 42 }])).rejects.toThrow(
      /stdin must be a string/
    );
    await expect(client.call('exec', 'start', [2, 'echo', { stdinKind: 'weird' }])).rejects.toThrow(
      /stdinKind must be 'text' or 'bytes'/
    );
    await expect(client.call('exec', 'start', [3, 'echo', { args: 'nope' }])).rejects.toThrow(
      /args must be a string\[\]/
    );
    await expect(client.call('exec', 'start', [4, 'echo', { args: ['ok', 5] }])).rejects.toThrow(
      /args must be a string\[\]/
    );
    expect(exec).not.toHaveBeenCalled();
    client.dispose();
  });

  it('SIGSTOP / SIGCONT drive the PM gate without aborting the in-flight command', async () => {
    const exec = vi.fn(
      (_cmd: string, options: { signal?: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          options.signal?.addEventListener('abort', () =>
            resolve({ stdout: '', stderr: 'terminated\n', exitCode: 143 })
          );
        })
    );
    const ctx = makeCtx({ exec });
    const pm = new ProcessManager();
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx, { pm, owner: { kind: 'cone' } });
    const client = new RealmRpcClient(realm);
    const bridge = createExecBridge(client);

    const handle = bridge.start('sleep 100');
    handle.stdin.end();
    await tick();
    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(1);

    await expect(handle.kill('SIGSTOP')).resolves.toBe(true);
    await tick();
    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(1);
    expect(pm.list()[0].terminatedBy).toBeNull();

    await expect(handle.kill('SIGCONT')).resolves.toBe(true);
    expect(pm.list()[0].terminatedBy).toBeNull();

    await expect(handle.kill('SIGTERM')).resolves.toBe(true);
    const result = await handle.done;
    expect(result.exitCode).toBe(143);
    expect(pm.list()[0].terminatedBy).toBe('SIGTERM');
    client.dispose();
  });
});

describe('createExecBridge: sync-fs coherence + perf gate', () => {
  type Call = { channel: string; op: string };

  function makeCountingRpc(handlers: Record<string, (args: unknown[]) => unknown>): {
    rpc: RealmRpcClient;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const rpc = {
      call: async (channel: string, op: string, args: unknown[]): Promise<unknown> => {
        calls.push({ channel, op });
        return handlers[`${channel}.${op}`]?.(args);
      },
    };
    return { rpc: rpc as unknown as RealmRpcClient, calls };
  }

  const okResult = { stdout: 'ok', stderr: '', exitCode: 0 };

  it('exec-only script incurs NO flushWrites / snapshot RPCs (perf gate)', async () => {
    const syncFs = new SyncFsCache({ entries: [] });
    const { rpc, calls } = makeCountingRpc({ 'exec.run': () => okResult });

    const bridge = createExecBridge(rpc, syncFs, '/workspace');
    await bridge('ls');

    expect(calls).toEqual([{ channel: 'exec', op: 'run' }]);
    expect(syncFs.wasUsed()).toBe(false);
  });

  it('flushes-before then re-snapshots-after once the sync-fs API is used', async () => {
    const snapshotAfter: SyncFsSnapshot = { entries: [] };
    const syncFs = new SyncFsCache({
      entries: [{ path: '/workspace', content: new Uint8Array(), isDirectory: true }],
    });

    syncFs.writeFile('/workspace/a.txt', new TextEncoder().encode('hi'));

    const { rpc, calls } = makeCountingRpc({
      'vfs.flushWrites': () => true,
      'exec.run': () => okResult,
      'vfs.snapshot': () => snapshotAfter,
    });

    const bridge = createExecBridge(rpc, syncFs, '/workspace');
    await bridge('cat a.txt');

    expect(calls).toEqual([
      { channel: 'vfs', op: 'flushWrites' },
      { channel: 'exec', op: 'run' },
      { channel: 'vfs', op: 'snapshot' },
    ]);
  });

  it('re-snapshots after a used-cache exec even with no pending mutations', async () => {
    const syncFs = new SyncFsCache({ entries: [] });
    syncFs.exists('/workspace/anything');

    const { rpc, calls } = makeCountingRpc({
      'exec.run': () => okResult,
      'vfs.snapshot': () => ({ entries: [] }) as SyncFsSnapshot,
    });

    const bridge = createExecBridge(rpc, syncFs, '/workspace');
    await bridge('echo hi');

    expect(calls).toEqual([
      { channel: 'exec', op: 'run' },
      { channel: 'vfs', op: 'snapshot' },
    ]);
  });

  it('without a sync cache the bridge is a plain exec passthrough', async () => {
    const { rpc, calls } = makeCountingRpc({ 'exec.run': () => okResult });
    const bridge = createExecBridge(rpc);
    await bridge('ls');
    expect(calls).toEqual([{ channel: 'exec', op: 'run' }]);
  });
});

describe('realm RPC: vfs.writeFile size cap', () => {
  it('round-trips a 4 MiB string without skill-side chunking', async () => {
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
    const FORTY_MIB = 40 * 1024 * 1024;

    const header = '\x00asm\x01\x00\x00\x00';
    const payload = header + 'b'.repeat(FORTY_MIB - header.length);
    const fs = makeMockFs({ '/workspace/biome_wasm_bg.wasm': payload });
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const bytes = await client.call<Uint8Array>('vfs', 'readFileBinary', ['biome_wasm_bg.wasm']);
    expect(bytes.byteLength).toBe(FORTY_MIB);

    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);

    expect(bytes[FORTY_MIB - 1]).toBe('b'.charCodeAt(0));
    client.dispose();
  });
});

function makeTreeFs(files: Record<string, string>): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const dirs = new Set<string>(['/']);
  for (const p of store.keys()) {
    const parts = p.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc += `/${parts[i]}`;
      dirs.add(acc);
    }
  }
  const size = (c: string) => new TextEncoder().encode(c).byteLength;
  const childrenOf = (dir: string): string[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = new Set<string>();
    for (const p of [...store.keys(), ...dirs]) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const first = p.slice(prefix.length).split('/')[0];
      if (first) names.add(first);
    }
    return [...names];
  };
  const base = makeMockFs();
  return {
    ...base,
    async exists(path: string) {
      return store.has(path) || dirs.has(path);
    },
    async stat(path: string): Promise<FsStat> {
      if (dirs.has(path)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(),
        };
      }
      const c = store.get(path);
      if (c === undefined) throw new Error(`ENOENT: ${path}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: size(c),
        mtime: new Date(),
      };
    },
    async readdir(path: string) {
      return childrenOf(path);
    },
    async readFileBuffer(path: string) {
      const c = store.get(path);
      if (c === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(c);
    },
  };
}

describe('realm RPC: vfs.snapshot budgets', () => {
  it('over-per-file-cap file becomes a metadata placeholder with real size (Coh#2)', async () => {
    const big = 'a'.repeat(1_100_000);
    const fs = makeTreeFs({
      '/workspace/big.bin': big,
      '/workspace/small.txt': 'hello',
    });
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    const bigE = snap.entries.find((e) => e.path === '/workspace/big.bin');
    expect(bigE).toBeDefined();
    expect(bigE?.truncated).toBe(true);
    expect(bigE?.content.byteLength).toBe(0);
    expect(bigE?.size).toBe(1_100_000);

    const smallE = snap.entries.find((e) => e.path === '/workspace/small.txt');
    expect(smallE?.truncated).toBeFalsy();
    expect(new TextDecoder().decode(smallE?.content)).toBe('hello');
  });

  it('a file whose read disagrees with its metadata costs one entry, not the snapshot', async () => {
    const fs = makeTreeFs({
      '/workspace/good.txt': 'hello',
      '/workspace/poisoned.png': 'x',
      '/workspace/also-good.txt': 'world',
    });
    const realFs = {
      ...fs,
      async readFileBuffer(path: string) {
        if (path === '/workspace/poisoned.png') {
          throw new Error("EISDIR: illegal operation on a directory '/workspace/poisoned.png'");
        }
        return fs.readFileBuffer(path);
      },
    } as typeof fs;
    const ctx = makeCtx({ fs: realFs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    const good = snap.entries.find((e) => e.path === '/workspace/good.txt');
    const alsoGood = snap.entries.find((e) => e.path === '/workspace/also-good.txt');
    expect(new TextDecoder().decode(good?.content)).toBe('hello');
    expect(new TextDecoder().decode(alsoGood?.content)).toBe('world');

    const bad = snap.entries.find((e) => e.path === '/workspace/poisoned.png');
    expect(bad).toBeDefined();
    expect(bad?.truncated).toBe(true);
    expect(bad?.content.byteLength).toBe(0);
  });

  it('a path that becomes a directory between stat and read is walked as one', async () => {
    const fs = makeTreeFs({ '/workspace/thing/inner.txt': 'inner' });
    let statCalls = 0;
    const realFs = {
      ...fs,
      async stat(path: string) {
        if (path === '/workspace/thing' && statCalls++ === 0) {
          return { isDirectory: false, isFile: true, size: 3 } as Awaited<
            ReturnType<typeof fs.stat>
          >;
        }
        return fs.stat(path);
      },
      async readFileBuffer(path: string) {
        if (path === '/workspace/thing') {
          throw new Error("EISDIR: illegal operation on a directory '/workspace/thing'");
        }
        return fs.readFileBuffer(path);
      },
    } as typeof fs;
    const ctx = makeCtx({ fs: realFs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    const inner = snap.entries.find((e) => e.path === '/workspace/thing/inner.txt');
    expect(new TextDecoder().decode(inner?.content)).toBe('inner');
  });

  it('a persistent kind flip degrades to a placeholder, not a lost snapshot', async () => {
    const fs = makeTreeFs({
      '/workspace/poisoned': 'x',
      '/workspace/sibling.txt': 'fine',
    });
    const realFs = {
      ...fs,

      async readFileBuffer(path: string) {
        if (path === '/workspace/poisoned') {
          throw new Error("EISDIR: illegal operation on a directory '/workspace/poisoned'");
        }
        return fs.readFileBuffer(path);
      },
    } as typeof fs;
    const ctx = makeCtx({ fs: realFs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    const bad = snap.entries.find((e) => e.path === '/workspace/poisoned');
    expect(bad?.truncated).toBe(true);
    expect(bad?.isDirectory).toBe(false);
    const sibling = snap.entries.find((e) => e.path === '/workspace/sibling.txt');
    expect(new TextDecoder().decode(sibling?.content)).toBe('fine');
  });

  it('a path that disappears mid-walk drops out without killing the snapshot', async () => {
    const fs = makeTreeFs({ '/workspace/keep.txt': 'keep', '/workspace/vanishes.txt': 'gone' });
    let statCalls = 0;
    const realFs = {
      ...fs,
      async stat(path: string) {
        if (path === '/workspace/vanishes.txt' && statCalls++ > 0) {
          throw new Error('ENOENT: no such file');
        }
        return fs.stat(path);
      },
      async readFileBuffer(path: string) {
        if (path === '/workspace/vanishes.txt') throw new Error('ENOENT: no such file');
        return fs.readFileBuffer(path);
      },
    } as typeof fs;
    const ctx = makeCtx({ fs: realFs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    expect(snap.entries.find((e) => e.path === '/workspace/vanishes.txt')).toBeUndefined();
    const keep = snap.entries.find((e) => e.path === '/workspace/keep.txt');
    expect(new TextDecoder().decode(keep?.content)).toBe('keep');
  });

  it('walk continues PAST the file-count content budget as placeholders (Coh#3)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 502; i++) {
      files[`/workspace/f${String(i).padStart(3, '0')}.txt`] = 'hello';
    }
    const fs = makeTreeFs(files);
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    const fileEntries = snap.entries.filter((e) => !e.isDirectory);

    expect(fileEntries.length).toBe(502);
    const withContent = fileEntries.filter((e) => !e.truncated);
    const placeholders = fileEntries.filter((e) => e.truncated);

    expect(withContent.length).toBe(500);
    expect(placeholders.length).toBe(2);

    for (const e of placeholders) {
      expect(e.content.byteLength).toBe(0);
      expect(e.size).toBe(5);
    }
  });
});

describe('realm RPC: sync-fs cache init', () => {
  it('surfaces a snapshot RPC failure via onError (bridge-enabled path)', async () => {
    const rpc = {
      call: async () => {
        throw new Error('snapshot boom');
      },
    } as unknown as RealmRpcClient;
    const errors: string[] = [];
    const cache = await initSyncFsCache(rpc, '/workspace', (m) => errors.push(m));
    expect(errors).toEqual(['snapshot boom']);

    expect(cache).toBeInstanceOf(SyncFsCache);
    expect(cache.exists('/workspace/anything')).toBe(false);
  });

  it('stays silent when no breadcrumb sink is wired (no-bridge / minimal test host)', async () => {
    const rpc = {
      call: async () => {
        throw new Error('unsupported op');
      },
    } as unknown as RealmRpcClient;

    const cache = await initSyncFsCache(rpc, '/workspace');
    expect(cache).toBeInstanceOf(SyncFsCache);
  });

  it('builds the cache from a successful snapshot without a breadcrumb', async () => {
    const snapshot: SyncFsSnapshot = {
      entries: [
        { path: '/workspace/a.txt', content: new TextEncoder().encode('hi'), isDirectory: false },
      ],
    };
    const rpc = { call: async () => snapshot } as unknown as RealmRpcClient;
    const errors: string[] = [];
    const cache = await initSyncFsCache(rpc, '/workspace', (m) => errors.push(m));
    expect(errors).toEqual([]);
    expect(cache.exists('/workspace/a.txt')).toBe(true);
  });
});

describe('realm RPC: fetch channel', () => {
  it('routes fetch through ctx.fetch (NOT globalThis.fetch) — secret invariant', async () => {
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
