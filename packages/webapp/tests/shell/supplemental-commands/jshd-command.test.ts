import type { FsStat, IFileSystem } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kernelJobTable } from '../../../src/kernel/job-table.js';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import { resetJshdSupervisor } from '../../../src/shell/supplemental-commands/jshd/supervisor.js';
import { createJshdCommand } from '../../../src/shell/supplemental-commands/jshd-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

function createMockFs(files: Record<string, string> = {}): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const dirs = new Set<string>(['/', '/workspace', '/workspace/.jshd', '/workspace/.jshd/log']);
  const fs: IFileSystem = {
    async readFile(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      return new TextEncoder().encode(await fs.readFile(path));
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      store.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async appendFile(path: string, content: string | Uint8Array): Promise<void> {
      const existing = store.get(path) || '';
      store.set(
        path,
        existing + (typeof content === 'string' ? content : new TextDecoder().decode(content))
      );
    },
    async exists(path: string): Promise<boolean> {
      return store.has(path) || dirs.has(path);
    },
    async stat(path: string): Promise<FsStat> {
      if (!(await fs.exists(path))) throw new Error(`ENOENT: ${path}`);
      return {
        isFile: store.has(path),
        isDirectory: dirs.has(path),
        isSymbolicLink: false,
        mode: 0o644,
        size: (store.get(path) || '').length,
        mtime: new Date(),
      };
    },
    async mkdir(path: string): Promise<void> {
      dirs.add(path);
    },
    async readdir(path: string): Promise<string[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const name = key.slice(prefix.length).split('/')[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    async rm(path: string): Promise<void> {
      store.delete(path);
    },
    async cp(): Promise<void> {
      /* noop */
    },
    async mv(): Promise<void> {
      /* noop */
    },
    async chmod(): Promise<void> {
      /* noop */
    },
    async symlink(): Promise<void> {
      /* noop */
    },
    async link(): Promise<void> {
      /* noop */
    },
    async readlink(): Promise<string> {
      return '';
    },
    async lstat(path: string): Promise<FsStat> {
      return fs.stat(path);
    },
    async realpath(path: string): Promise<string> {
      return path;
    },
    async utimes(): Promise<void> {
      /* noop */
    },
    resolvePath(base: string, path: string): string {
      if (path.startsWith('/')) return path;
      return base === '/' ? `/${path}` : `${base}/${path}`;
    },
    getAllPaths(): string[] {
      return [...store.keys()];
    },
  };
  return fs;
}

function ctxFor(fs: IFileSystem) {
  return mockCommandContext({ fs, cwd: '/workspace', env: new Map() });
}

const ONESHOT = 'console.log("hello-jshd");';
const DAEMON = 'console.log("up"); setInterval(() => {}, 60_000);';
const inProcess = createInProcessJsRealmFactory();

function command(pm: ProcessManager) {
  return createJshdCommand({ processManager: pm, realmFactory: inProcess });
}

afterEach(() => {
  resetJshdSupervisor();
  kernelJobTable.clear();
});

describe('jshd command', () => {
  it('prints help for bare, --help, and verb --help without dispatching', async () => {
    const cmd = createJshdCommand();
    const ctx = ctxFor(createMockFs());
    for (const args of [[], ['--help'], ['start', '--help'], ['logs', '--help']]) {
      const result = await cmd.execute(args, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: jshd');
    }
    expect((await cmd.execute(['start', '--help'], ctx)).stdout).toContain('start [-n <name>]');
  });

  it('starts a oneshot unit, lists it, and tees logs', async () => {
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/hello.jsh': ONESHOT });
    const cmd = command(pm);
    const start = await cmd.execute(
      ['start', '-n', 'hello', '--restart', 'no', '/workspace/hello.jsh'],
      ctxFor(fs)
    );
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toMatch(/started 'hello' \(pid \d+\)/);
    expect(start.stdout).toContain('not durable');

    await vi.waitFor(async () => {
      const ls = await cmd.execute(['ls', '--json'], ctxFor(fs));
      const rows = JSON.parse(ls.stdout) as Array<{ name: string; state: string }>;
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'hello' })]));
    });

    await vi.waitFor(async () => {
      const logs = await cmd.execute(['logs', 'hello'], ctxFor(fs));
      expect(logs.stdout).toContain('hello-jshd');
    });

    expect(kernelJobTable.get('jshd:hello')?.kind).toBe('jshd');
    expect(
      pm.list().some((proc) => proc.kind === 'jsh' && proc.argv.includes('/workspace/hello.jsh'))
    ).toBe(true);
    expect(pm.list().some((proc) => proc.owner.kind === 'jshd')).toBe(true);
  });

  it('stop does not restart a running daemon, and kill of the pid does not either', async () => {
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/loop.jsh': DAEMON });
    const cmd = command(pm);
    const start = await cmd.execute(
      ['start', '-n', 'loop', '--restart', 'always', '/workspace/loop.jsh'],
      ctxFor(fs)
    );
    expect(start.exitCode).toBe(0);
    const pid = Number(/pid (\d+)/.exec(start.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);

    const stopped = await cmd.execute(['stop', 'loop'], ctxFor(fs));
    expect(stopped.exitCode).toBe(0);
    const status = await cmd.execute(['status', 'loop'], ctxFor(fs));
    expect(status.stdout).toContain('state: stopped');
    expect(status.stdout).toContain('restarts: 0');

    const start2 = await cmd.execute(
      ['start', '-n', 'loop2', '--restart', 'always', '/workspace/loop.jsh'],
      ctxFor(fs)
    );
    const pid2 = Number(/pid (\d+)/.exec(start2.stdout)?.[1]);
    expect(pm.signal(pid2, 'SIGTERM')).toBe(true);
    await vi.waitFor(async () => {
      const st = await cmd.execute(['status', 'loop2'], ctxFor(fs));
      expect(st.stdout).toContain('state: stopped');
    });
    const st2 = await cmd.execute(['status', 'loop2'], ctxFor(fs));
    expect(st2.stdout).toContain('restarts: 0');
  });

  it('enable writes the record so boot restore can relaunch it', async () => {
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/hello.jsh': ONESHOT });
    const cmd = command(pm);
    await cmd.execute(
      ['start', '-n', 'svc', '--enable', '--restart', 'no', '/workspace/hello.jsh'],
      ctxFor(fs)
    );
    const record = JSON.parse(await fs.readFile('/workspace/.jshd/svc.json'));
    expect(record.enabled).toBe(true);
    expect(record.argv[0]).toBe('/workspace/hello.jsh');
    const disabled = await cmd.execute(['disable', 'svc'], ctxFor(fs));
    expect(disabled.exitCode).toBe(0);
    expect(JSON.parse(await fs.readFile('/workspace/.jshd/svc.json')).enabled).toBe(false);
  });

  it('rm deletes the record and log', async () => {
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/hello.jsh': ONESHOT });
    const cmd = command(pm);
    await cmd.execute(
      ['start', '-n', 'gone', '--restart', 'no', '/workspace/hello.jsh'],
      ctxFor(fs)
    );
    await cmd.execute(['rm', 'gone'], ctxFor(fs));
    expect(await fs.exists('/workspace/.jshd/gone.json')).toBe(false);
    const ls = await cmd.execute(['ls'], ctxFor(fs));
    expect(ls.stdout).toContain('no jshd units');
  });

  it('fails closed when the script is missing', async () => {
    const pm = new ProcessManager();
    const cmd = command(pm);
    const result = await cmd.execute(['start', 'missing.jsh'], ctxFor(createMockFs()));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot find script');
  });

  it('logs -f emits a live chunk before abort and does not duplicate the tail', async () => {
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/hello.jsh': ONESHOT });
    const cmd = command(pm);
    await cmd.execute(
      ['start', '-n', 'hello', '--restart', 'no', '/workspace/hello.jsh'],
      ctxFor(fs)
    );
    await vi.waitFor(async () => {
      const logs = await cmd.execute(['logs', 'hello'], ctxFor(fs));
      expect(logs.stdout.length).toBeGreaterThan(0);
    });
    const existing = await fs.readFile('/workspace/.jshd/log/hello.log');
    await fs.writeFile('/workspace/.jshd/log/hello.log', `${existing}line-a\nline-b\nline-c\n`);
    const ac = new AbortController();
    const live: string[] = [];
    const ctx = {
      ...ctxFor(fs),
      signal: ac.signal,
      writeStdout: (chunk: string) => {
        live.push(chunk);
      },
    };
    const follow = cmd.execute(['logs', 'hello', '-f', '-n', '1'], ctx);
    await vi.waitFor(() => {
      expect(live.join('')).toContain('line-c');
    });
    expect(live.join('')).not.toContain('line-a');
    await fs.appendFile('/workspace/.jshd/log/hello.log', 'LIVE-CHUNK\n');
    await vi.waitFor(() => {
      expect(live.join('')).toContain('LIVE-CHUNK');
    });
    const joined = live.join('');
    expect(joined.split('LIVE-CHUNK').length - 1).toBe(1);
    ac.abort();
    const result = await follow;
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(typeof Worker === 'undefined')(
    'starts an enabled daemon in a DedicatedWorker when Worker exists',
    async () => {
      const { createDefaultRealmFactory } = await import(
        '../../../src/kernel/realm/realm-factory.js'
      );
      const pm = new ProcessManager();
      const fs = createMockFs({ '/workspace/loop.jsh': DAEMON });
      const cmd = createJshdCommand({
        processManager: pm,
        realmFactory: createDefaultRealmFactory(),
      });
      const start = await cmd.execute(
        ['start', '-n', 'tick', '--enable', '--restart', 'no', '/workspace/loop.jsh'],
        ctxFor(fs)
      );
      expect(start.exitCode).toBe(0);
      const pid = Number(/pid (\d+)/.exec(start.stdout)?.[1]);
      expect(pid).toBeGreaterThan(0);
      const ls = await cmd.execute(['ls', '--json'], ctxFor(fs));
      const rows = JSON.parse(ls.stdout) as Array<{ name: string; durable: boolean }>;
      expect(rows).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'tick', durable: true })])
      );
      expect(pm.signal(pid, 'SIGTERM')).toBe(true);
    }
  );
});

describe('jshd supervisor restart policy', () => {
  it('marks a crash-looping unit errored and reports a lick', async () => {
    const { JshdSupervisor } = await import(
      '../../../src/shell/supplemental-commands/jshd/supervisor.js'
    );
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/fail.jsh': 'process.exit(1);' });
    const licks: unknown[] = [];
    let now = 1_000;
    const supervisor = new JshdSupervisor({
      fs,
      processManager: pm,
      lickManager: { emitEvent: (event) => licks.push(event) },
      now: () => now,
      sleep: async () => {
        now += 1;
      },
      isDurable: () => false,
      realmFactory: inProcess,
      buildContext: () => ctxFor(fs),
    });
    await supervisor.start({
      name: 'fail',
      argv: ['/workspace/fail.jsh'],
      cwd: '/workspace',
      env: {},
      restart: 'on-failure',
      enabled: false,
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => {
      expect(supervisor.status('fail')?.state).toBe('errored');
    });
    expect(licks).toEqual([
      expect.objectContaining({
        type: 'jshd',
        jshdName: 'fail',
        body: expect.objectContaining({ reason: 'crash-loop' }),
      }),
    ]);
  });

  it('waits 1s on the first restart and aborts backoff on stop', async () => {
    const { JshdSupervisor } = await import(
      '../../../src/shell/supplemental-commands/jshd/supervisor.js'
    );
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/fail.jsh': 'process.exit(1);' });
    const delays: number[] = [];
    const supervisor = new JshdSupervisor({
      fs,
      processManager: pm,
      now: () => Date.now(),
      sleep: async (ms, signal) => {
        delays.push(ms);
        if (signal?.aborted) throw new Error('aborted');
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(new Error('aborted'));
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      isDurable: () => false,
      realmFactory: inProcess,
      buildContext: () => ctxFor(fs),
    });
    await supervisor.start({
      name: 'fail',
      argv: ['/workspace/fail.jsh'],
      cwd: '/workspace',
      env: {},
      restart: 'always',
      enabled: false,
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => {
      expect(delays[0]).toBe(1000);
    });
    const started = Date.now();
    await supervisor.stop('fail');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('awaits pending log appends before rm deletes the log', async () => {
    const { JshdSupervisor } = await import(
      '../../../src/shell/supplemental-commands/jshd/supervisor.js'
    );
    const pm = new ProcessManager();
    const fs = createMockFs({ '/workspace/hello.jsh': ONESHOT });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const origAppend = fs.appendFile!.bind(fs);
    let entered = 0;
    fs.appendFile = async (path: string, content: string | Uint8Array) => {
      entered += 1;
      await gate;
      await origAppend(path, content);
    };
    const supervisor = new JshdSupervisor({
      fs,
      processManager: pm,
      sleep: async () => undefined,
      isDurable: () => false,
      realmFactory: inProcess,
      buildContext: () => ctxFor(fs),
    });
    await supervisor.start({
      name: 'hello',
      argv: ['/workspace/hello.jsh'],
      cwd: '/workspace',
      env: {},
      restart: 'no',
      enabled: false,
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => {
      expect(entered).toBeGreaterThan(0);
    });
    const rm = supervisor.rm('hello');
    let rmDone = false;
    void rm.then(() => {
      rmDone = true;
    });
    await Promise.resolve();
    expect(rmDone).toBe(false);
    release?.();
    await rm;
    expect(await fs.exists('/workspace/.jshd/hello.json')).toBe(false);
    expect(await fs.exists('/workspace/.jshd/log/hello.log')).toBe(false);
  });
});
