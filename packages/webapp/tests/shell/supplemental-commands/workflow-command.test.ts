import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
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
