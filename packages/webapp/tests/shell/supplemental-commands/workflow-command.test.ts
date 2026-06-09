import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import { WORKFLOW_MANAGER_GLOBAL_KEY } from '../../../src/scoops/workflow-run-manager.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import {
  createWorkflowCommand,
  resolveMaxCap,
} from '../../../src/shell/supplemental-commands/workflow-command.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

async function ctxWith(
  fs: VirtualFS,
  spawn: (a: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
) {
  const adapter = new VfsAdapter(fs);
  // exec is called as a function by the realm-host, which unpacks argv[0] as cmd
  // and passes the rest as { args }. Rebuild the full argv and forward to spawn.
  const exec = Object.assign(
    async (cmd: string, opts: { args?: string[] }) => {
      const argv = [cmd, ...(opts.args || [])];
      return spawn(argv);
    },
    { spawn }
  );
  return { fs: adapter, cwd: '/workspace', env: new Map<string, string>(), stdin: '', exec } as any;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY];
});

// Install a fake WorkflowRunManager on globalThis (the command resolves it from the
// shared global key, NOT by injection — see the dual-mode test in workflow-run-manager).
function installFakeManager(over: Partial<any> = {}) {
  const runs = new Map<string, any>();
  const mgr = {
    start: vi.fn(async (opts: any) => {
      const id = 'r1';
      runs.set(id, {
        id,
        name: opts.name,
        status: 'running',
        origin: 'terminal',
        agentsStarted: 0,
        agentsDone: 0,
        logs: [],
        preview: null,
        resultPath: null,
        error: null,
        pid: null,
        currentPhase: null,
        startedAt: 't',
      });
      return { runId: id };
    }),
    getRun: (id: string) => runs.get(id) ?? null,
    listRuns: () => [...runs.values()],
    observeRun: () => () => {},
    ...over,
  };
  (globalThis as Record<string, unknown>)[WORKFLOW_MANAGER_GLOBAL_KEY] = mgr;
  return mgr;
}

describe('workflow run', () => {
  it('is registered', () => {
    expect(createSupplementalCommands().some((c) => c.name === 'workflow')).toBe(true);
  });
  it('run (non-blocking default) prints the started line + runId', async () => {
    installFakeManager();
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
    const res = await createWorkflowCommand().execute(
      ['run', '/workspace/wf.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/started.*r1/i);
  });
  it('run (non-blocking) errors when the run manager is not available', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
    const res = await createWorkflowCommand().execute(
      ['run', '/workspace/wf.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/run manager not available/);
  });
  it('--wait runs a fan-out workflow and prints the returned value', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile(
      '/workspace/wf.js',
      `export const meta = { name:'demo', description:'d' }\n` +
        `const xs = await parallel([()=>agent('a'),()=>agent('b')])\n` +
        `return { xs }`
    );
    const spawn = async (a: string[]) => ({
      stdout: a[a.length - 1].toUpperCase(),
      stderr: '',
      exitCode: 0,
    });
    const res = await createWorkflowCommand().execute(
      ['run', '--wait', '/workspace/wf.js'],
      await ctxWith(fs, spawn)
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"xs":["A","B"]');
  });
  it('--wait creates the per-run scratch cwd before running', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile(
      '/workspace/wf.js',
      `export const meta={name:'x',description:'d'}\nreturn await agent('hi')`
    );
    const seen: string[] = [];
    const spawn = async (a: string[]) => {
      seen.push(a[a.indexOf('--read-only') + 2] ?? '');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }; // +1='/workspace/', +2=__agentCwd, +3='*'
    await createWorkflowCommand().execute(
      ['run', '--wait', '/workspace/wf.js'],
      await ctxWith(fs, spawn)
    );
    // the agentCwd passed to `agent` must exist on the VFS
    expect(await fs.exists(seen[0])).toBe(true);
  });
  it('errors on missing file', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    const res = await createWorkflowCommand().execute(
      ['run', '/nope.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/not found/i);
  });
  it('--wait surfaces a thrown body as non-zero', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile(
      '/workspace/boom.js',
      `export const meta={name:'b',description:'d'}\nthrow new Error('kaboom')`
    );
    const res = await createWorkflowCommand().execute(
      ['run', '--wait', '/workspace/boom.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/kaboom/);
  });
});

describe('workflow — delegation, subcommands, and origin', () => {
  it('--wait blocks and prints the full result (inline SP1 path — bypasses the manager)', async () => {
    // IMPORTANT: --wait does NOT touch the run manager. It runs the real realm via
    // executeJsCode and the realm SELF-EMITS the sentinel line for `return {ok:true}`
    // (buildWorkflowCode appends `__emit(sentinel + stringify(__r))`), which renderResult
    // then extracts. So no installFakeManager and no mock-spawn stdout is involved — the
    // workflow body has no agent() calls, so ctxWith's spawn is never invoked.
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn {ok:true}`);
    const res = await createWorkflowCommand().execute(
      ['run', '--wait', '/workspace/wf.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('{"ok":true}');
  });

  it('list / status / stop render run state', async () => {
    const killed: string[][] = [];
    installFakeManager({
      listRuns: () => [
        { id: 'r1', status: 'running', agentsDone: 1, agentsStarted: 2, name: 'demo' },
      ],
      getRun: () => ({
        id: 'r1',
        name: 'demo',
        status: 'running',
        agentsDone: 1,
        agentsStarted: 2,
        currentPhase: 'Scan',
        resultPath: null,
        preview: null,
        error: null,
        pid: 1234,
      }),
    });
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    const ctx = await ctxWith(fs, async (a) => {
      killed.push(a);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    expect((await createWorkflowCommand().execute(['list'], ctx)).stdout).toContain('r1');
    expect((await createWorkflowCommand().execute(['status', 'r1'], ctx)).stdout).toMatch(
      /status=running/
    );
    await createWorkflowCommand().execute(['stop', 'r1'], ctx);
    expect(killed).toContainEqual(['kill', '-KILL', '1234']);
  });

  it('stop on a terminal run does NOT kill (pid may be recycled) and reports the status', async () => {
    const killed: string[][] = [];
    installFakeManager({
      // status=done but pid is non-null (the kernel ProcessManager may have recycled it).
      getRun: () => ({
        id: 'r1',
        name: 'demo',
        status: 'done',
        agentsDone: 2,
        agentsStarted: 2,
        currentPhase: null,
        resultPath: '/shared/workflow-runs/r1.json',
        preview: 'ok',
        error: null,
        pid: 1234,
      }),
    });
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    const ctx = await ctxWith(fs, async (a) => {
      killed.push(a);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const res = await createWorkflowCommand().execute(['stop', 'r1'], ctx);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/already done/);
    expect(killed).toHaveLength(0); // no kill issued for a terminal run
  });

  it('stop propagates a non-zero kill exit code on the stderr', async () => {
    installFakeManager({
      getRun: () => ({
        id: 'r1',
        name: 'demo',
        status: 'running',
        agentsDone: 0,
        agentsStarted: 1,
        currentPhase: null,
        resultPath: null,
        preview: null,
        error: null,
        pid: 1234,
      }),
    });
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    // kill fails (e.g. the pid is gone) → command must surface the failure, not a fake "stopped".
    const ctx = await ctxWith(fs, async () => ({
      stdout: '',
      stderr: 'kill: no such process\n',
      exitCode: 1,
    }));
    const res = await createWorkflowCommand().execute(['stop', 'r1'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/no such process/);
  });

  it('list / status / stop error when the run is unknown / manager absent', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    const ctx = await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const list = await createWorkflowCommand().execute(['list'], ctx);
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toMatch(/run manager not available/);
    const status = await createWorkflowCommand().execute(['status', 'nope'], ctx);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toMatch(/no run 'nope'/);
  });

  it('passes the parent jid to the manager for origin classification', async () => {
    const mgr = installFakeManager();
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/wf.js', `export const meta={name:'demo'}\nreturn 1`);
    await createWorkflowCommand({ getParentJid: () => 'cone_1' }).execute(
      ['run', '/workspace/wf.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect((mgr.start as any).mock.calls[0][0].parentJid).toBe('cone_1');
  });
});

describe('workflow run — argument validation', () => {
  const noop = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  const freshFs = () => VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
  const run = async (args: string[]) =>
    createWorkflowCommand().execute(args, await ctxWith(await freshFs(), noop));

  it('no args → help on stdout, exit 0', async () => {
    const res = await run([]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/usage: workflow run/);
  });
  it('unknown subcommand → exit 1', async () => {
    const res = await run(['bogus']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/unknown subcommand/);
  });
  it('--args invalid JSON → exit 1', async () => {
    const res = await run(['run', '--args', '{bad', '/workspace/x.js']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--args must be valid JSON/);
  });
  it('--budget non-number → exit 1', async () => {
    const res = await run(['run', '--budget', 'abc', '/workspace/x.js']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--budget must be a number/);
  });
  it('--concurrency non-number → exit 1', async () => {
    const res = await run(['run', '--concurrency', 'abc', '/workspace/x.js']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--concurrency must be a number/);
  });
  it('unknown flag → exit 1', async () => {
    const res = await run(['run', '--bogus', '/workspace/x.js']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/unknown flag/);
  });
  it('too many positional args → exit 1', async () => {
    const res = await run(['run', 'a.js', 'b.js']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/too many arguments/);
  });
  it('meta without a name → exit 1', async () => {
    const fs = await freshFs();
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile(
      '/workspace/noname.js',
      `export const meta = { description: 'd' }\nreturn 1`
    );
    const res = await createWorkflowCommand().execute(
      ['run', '/workspace/noname.js'],
      await ctxWith(fs, noop)
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/must define a meta block with a name/);
  });
  it('--wait --script runs an inline workflow (no file)', async () => {
    const res = await createWorkflowCommand().execute(
      ['run', '--wait', '--script', `export const meta = { name: 's' }\nreturn 42`],
      await ctxWith(await freshFs(), noop)
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().split('\n').pop()).toBe('42');
  });
});

describe('workflow concurrency cap (scoop-appropriate: 4/core, clamp [8,16])', () => {
  afterEach(() => vi.unstubAllGlobals());
  const capForCores = (cores: number): number => {
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    return resolveMaxCap();
  };
  it('clamps cores*4 into [8,16]', () => {
    expect(capForCores(1)).toBe(8); // 1*4=4 → floored to 8
    expect(capForCores(2)).toBe(8); // 2*4=8
    expect(capForCores(3)).toBe(12); // 3*4=12
    expect(capForCores(4)).toBe(16); // 4*4=16
    expect(capForCores(8)).toBe(16); // 8*4=32 → ceilinged to 16
    expect(capForCores(64)).toBe(16);
  });
  it('falls back to 8 cores when navigator is absent → cap 16', () => {
    vi.stubGlobal('navigator', undefined); // typeof navigator stays defined-but-undefined → ?? 8
    expect(resolveMaxCap()).toBe(16); // 8*4=32 → 16
  });
});

describe('workflow save', () => {
  it('persists the run source and triggers a sync', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) =>
      id === 'r1' ? ({ id, source: "export const meta={name:'audit'}\nreturn 1" } as any) : null;
    const fs = await VirtualFS.create({ dbName: `wf-save-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    let synced = 0;
    const cmd = createWorkflowCommand({ syncScriptCommands: async () => void synced++ });
    const res = await cmd.execute(
      ['save', 'r1', 'audit'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(0);
    expect(await fs.readFile('/workspace/.workflows/audit.workflow.js')).toContain("name:'audit'");
    expect(synced).toBe(1);
  });

  it('rejects a name already taken by an existing command', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) => ({ id, source: "export const meta={name:'x'}\nreturn 1" }) as any;
    const fs = await VirtualFS.create({ dbName: `wf-save2-${Math.random()}`, wipe: true });
    const ctx = await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    (ctx as any).getRegisteredCommands = () => ['ls', 'git'];
    const res = await createWorkflowCommand().execute(['save', 'r1', 'ls'], ctx);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/already a command|taken/i);
  });

  it('errors for a --wait (unmanaged) run id', async () => {
    installFakeManager(); // getRun returns null for unknown ids
    const fs = await VirtualFS.create({ dbName: `wf-save3-${Math.random()}`, wipe: true });
    const res = await createWorkflowCommand().execute(
      ['save', 'nope', 'audit'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/no run|no such run/i);
  });

  it('refuses to overwrite without --force, allows with --force', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) =>
      ({ id, source: "export const meta={name:'audit'}\nreturn 2" }) as any;
    const fs = await VirtualFS.create({ dbName: `wf-save4-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile('/workspace/.workflows/audit.workflow.js', 'old');
    const ctx = await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    // After Task 4, a saved workflow's name is a registered command. --force must still
    // overwrite OUR OWN saved workflow (the collision check only applies to NEW names).
    (ctx as any).getRegisteredCommands = () => ['audit'];
    const r1 = await createWorkflowCommand().execute(['save', 'r1', 'audit'], ctx);
    expect(r1.exitCode).toBe(1); // exists, no --force
    expect(r1.stderr).toMatch(/already exists/i); // NOT "already a command"
    const r2 = await createWorkflowCommand().execute(['save', 'r1', 'audit', '--force'], ctx);
    expect(r2.exitCode).toBe(0);
    expect(await fs.readFile('/workspace/.workflows/audit.workflow.js')).toContain('return 2');
  });

  it('rejects extra positional arguments', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) => ({ id, source: "export const meta={name:'x'}\nreturn 1" }) as any;
    const fs = await VirtualFS.create({ dbName: `wf-extra-${Math.random()}`, wipe: true });
    const res = await createWorkflowCommand().execute(
      ['save', 'r1', 'audit', 'oops'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/usage/);
  });

  it('accepts --force in any position (flag, not a positional)', async () => {
    const mgr = installFakeManager();
    mgr.getRun = (id: string) =>
      ({ id, source: "export const meta={name:'audit'}\nreturn 9" }) as any;
    const fs = await VirtualFS.create({ dbName: `wf-force-pos-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace/.workflows', { recursive: true });
    await fs.writeFile('/workspace/.workflows/audit.workflow.js', 'old');
    const res = await createWorkflowCommand().execute(
      ['save', '--force', 'r1', 'audit'], // --force ahead of the positionals
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).toBe(0);
    expect(await fs.readFile('/workspace/.workflows/audit.workflow.js')).toContain('return 9');
  });
});
