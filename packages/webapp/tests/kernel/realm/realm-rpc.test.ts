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
    // A signal is always threaded so `kill` can abort mid-run.
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

    // Process was registered as a shell kind owned by the spawning scoop…
    const all = pm.list();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('shell');
    expect(all[0].owner.scoopJid).toBe('jid-1');
    // …and it is no longer running (a `ps` would not list it as live).
    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(0);
    expect(all[0].exitCode).toBe(0);
    client.dispose();
  });

  it('handle.kill() aborts a long-running command; exit reflects termination; ps drops it', async () => {
    // A long-running command: resolves only when its abort signal fires,
    // mirroring just-bash cooperative cancel at the next statement boundary.
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
    // Let the host register the spawn + PM process before killing.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(1);

    const delivered = await handle.kill();
    expect(delivered).toBe(true);

    const result = await handle.done;
    expect(result.exitCode).toBe(143);
    // PM process is terminated (SIGTERM by default) — a `ps` no longer
    // lists it as live.
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

    // No such spawn id.
    await expect(client.call<boolean>('exec', 'kill', [9999])).resolves.toBe(false);

    // A completed spawn is cleaned up, so killing it is also a no-op.
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
    // Kill BEFORE stdin.end(): the host hasn't registered the spawn yet, so
    // this is honored client-side.
    const delivered = await handle.kill('SIGKILL');
    expect(delivered).toBe(true);
    // A late stdin.end() must NOT launch the killed spawn.
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
    await h1.kill(); // default → SIGTERM
    expect((await h1.done).exitCode).toBe(143);

    const h2 = bridge.start('b');
    await h2.kill('SIGINT');
    expect((await h2.done).exitCode).toBe(130);

    expect(exec).not.toHaveBeenCalled();
    client.dispose();
  });

  it('rejects a duplicate spawnId instead of clobbering a live spawn', async () => {
    // A long-running exec keeps spawnId 1 live in the host map.
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
    // The original spawn is untouched — killing it still works and settles it.
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

    // SIGSTOP is delivered but does NOT terminate: the command keeps running
    // (no abort recorded) and the process is only gate-paused.
    await expect(handle.kill('SIGSTOP')).resolves.toBe(true);
    await tick();
    expect(pm.list().filter((p) => p.status === 'running')).toHaveLength(1);
    expect(pm.list()[0].terminatedBy).toBeNull();

    // SIGCONT likewise leaves the command running.
    await expect(handle.kill('SIGCONT')).resolves.toBe(true);
    expect(pm.list()[0].terminatedBy).toBeNull();

    // A terminating signal still aborts and settles the spawn.
    await expect(handle.kill('SIGTERM')).resolves.toBe(true);
    const result = await handle.done;
    expect(result.exitCode).toBe(143);
    expect(pm.list()[0].terminatedBy).toBe('SIGTERM');
    client.dispose();
  });
});

describe('createExecBridge: sync-fs coherence + perf gate', () => {
  type Call = { channel: string; op: string };
  /**
   * Minimal `RealmRpcClient` stand-in that records the (channel, op) of every
   * call so we can assert the flush-before / re-snapshot-after RPCs happen (or
   * are skipped) exactly as the perf gate requires.
   */
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
    // Sync cache is never touched → the exec bridge must not pay the coherence
    // round-trips. Only the exec op itself crosses the wire.
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
    // A prior sync write both marks the cache used AND creates a pending
    // mutation that flush-before must ship to the host.
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
    // A pure sync READ marks the cache used but produces no mutation: the
    // flush-before then skips `flushWrites`, but the re-snapshot-after still
    // runs so a later `readFileSync` can see the exec's writes.
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
    // The RPC-only call form (used by other unit tests) must keep dispatching
    // exec ops verbatim with zero coherence RPCs.
    const { rpc, calls } = makeCountingRpc({ 'exec.run': () => okResult });
    const bridge = createExecBridge(rpc);
    await bridge('ls');
    expect(calls).toEqual([{ channel: 'exec', op: 'run' }]);
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

// A tree-aware in-memory fs: unlike `makeMockFs` (whose `readdir` returns ALL
// keys and `stat` always reports a file), this models real directories so the
// snapshot walk in `realm-host` can be driven end-to-end over `vfs.snapshot`.
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
    // A file larger than the 1 MB per-file content cap is snapshotted as a
    // metadata-only placeholder: present + truncated, empty content, but its
    // REAL size recorded so statSync().size is correct. A small sibling keeps
    // its real content.
    const big = 'a'.repeat(1_100_000); // > SYNC_FS_MAX_FILE_BYTES (1 MB)
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

  it('walk continues PAST the file-count content budget as placeholders (Coh#3)', async () => {
    // 502 small files > the 500-file content budget. The OLD walk stopped at
    // 500 and files 501+ vanished (existsSync/statSync wrongly reported absent).
    // Now the walk continues, emitting metadata-only placeholders (with size)
    // so existsSync/statSync stay correct; only the CONTENT read stops at 500.
    // (Couples to SYNC_FS_MAX_FILES = 500 by design — it tests that budget.)
    const files: Record<string, string> = {};
    for (let i = 0; i < 502; i++) {
      files[`/workspace/f${String(i).padStart(3, '0')}.txt`] = 'hello'; // 5 bytes
    }
    const fs = makeTreeFs(files);
    const ctx = makeCtx({ fs });
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const snap = await client.call<SyncFsSnapshot>('vfs', 'snapshot', ['/workspace']);
    client.dispose();

    const fileEntries = snap.entries.filter((e) => !e.isDirectory);
    // Coh#3: EVERY file is present in the snapshot metadata (walk didn't stop).
    expect(fileEntries.length).toBe(502);
    const withContent = fileEntries.filter((e) => !e.truncated);
    const placeholders = fileEntries.filter((e) => e.truncated);
    // Content budget still capped byte-reads at 500 files.
    expect(withContent.length).toBe(500);
    expect(placeholders.length).toBe(2);
    // Coh#2: each placeholder carries the real byte size, empty content.
    for (const e of placeholders) {
      expect(e.content.byteLength).toBe(0);
      expect(e.size).toBe(5);
    }
  });
});

describe('realm RPC: sync-fs cache init', () => {
  it('surfaces a snapshot RPC failure via onError (bridge-enabled path)', async () => {
    // A bridge-enabled realm serves metadata ops from the cache only (phase-1),
    // so a failed snapshot must not silently yield an empty cache — the caller
    // wires onError to leave a diagnosable breadcrumb.
    const rpc = {
      call: async () => {
        throw new Error('snapshot boom');
      },
    } as unknown as RealmRpcClient;
    const errors: string[] = [];
    const cache = await initSyncFsCache(rpc, '/workspace', (m) => errors.push(m));
    expect(errors).toEqual(['snapshot boom']);
    // Still falls back to an empty (usable) cache — never throws.
    expect(cache).toBeInstanceOf(SyncFsCache);
    expect(cache.exists('/workspace/anything')).toBe(false);
  });

  it('stays silent when no breadcrumb sink is wired (no-bridge / minimal test host)', async () => {
    const rpc = {
      call: async () => {
        throw new Error('unsupported op');
      },
    } as unknown as RealmRpcClient;
    // No onError → must not throw and must fall back to an empty cache (the
    // legitimate "host has no snapshot op" case must stay quiet).
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
