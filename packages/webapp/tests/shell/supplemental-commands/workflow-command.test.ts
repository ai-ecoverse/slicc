import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import { createWorkflowCommand } from '../../../src/shell/supplemental-commands/workflow-command.js';
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

describe('workflow run', () => {
  it('is registered', () => {
    expect(createSupplementalCommands().some((c) => c.name === 'workflow')).toBe(true);
  });
  it('runs a fan-out workflow and prints the returned value', async () => {
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
      ['run', '/workspace/wf.js'],
      await ctxWith(fs, spawn)
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"xs":["A","B"]');
  });
  it('creates the per-run scratch cwd before running', async () => {
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
    await createWorkflowCommand().execute(['run', '/workspace/wf.js'], await ctxWith(fs, spawn));
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
  it('surfaces a thrown body as non-zero', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile(
      '/workspace/boom.js',
      `export const meta={name:'b',description:'d'}\nthrow new Error('kaboom')`
    );
    const res = await createWorkflowCommand().execute(
      ['run', '/workspace/boom.js'],
      await ctxWith(fs, async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/kaboom/);
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
  it('--script runs an inline workflow (no file)', async () => {
    const res = await createWorkflowCommand().execute(
      ['run', '--script', `export const meta = { name: 's' }\nreturn 42`],
      await ctxWith(await freshFs(), noop)
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim().split('\n').pop()).toBe('42');
  });
});
