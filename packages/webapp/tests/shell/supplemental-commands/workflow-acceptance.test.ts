import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import { createWorkflowCommand } from '../../../src/shell/supplemental-commands/workflow-command.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/workflows/repo-audit.workflow.js', import.meta.url)),
  'utf8'
);

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

describe('workflow acceptance', () => {
  it('runs a fan-out/verify workflow with schema and bounded concurrency', async () => {
    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/repo-audit.workflow.js', FIXTURE);

    const peak = { cur: 0, max: 0 };
    const spawn = async (a: string[]) => {
      peak.cur++;
      peak.max = Math.max(peak.max, peak.cur);
      await Promise.resolve();
      const prompt = a[a.length - 1];
      const hasSchema = a.includes('--schema-b64');
      let stdout = '';
      if (hasSchema && prompt.startsWith('Find bugs')) {
        stdout = JSON.stringify({ bugs: ['x', 'y'] });
      } else if (hasSchema && prompt.startsWith('Verify')) {
        stdout = JSON.stringify({ real: prompt.includes('"x"') });
      }
      peak.cur--;
      return { stdout, stderr: '', exitCode: 0 };
    };

    const res = await createWorkflowCommand().execute(
      [
        'run',
        '/workspace/repo-audit.workflow.js',
        '--args',
        '{"files":["a.ts","b.ts"]}',
        '--concurrency',
        '4',
      ],
      await ctxWith(fs, spawn)
    );

    expect(res.exitCode).toBe(0);
    // The result is printed as the LAST line after banner/logs
    const lines = res.stdout.trim().split('\n');
    const resultLine = lines[lines.length - 1];
    const parsed = JSON.parse(resultLine);
    expect(parsed.confirmed).toBeDefined();
    expect(Array.isArray(parsed.confirmed)).toBe(true);
    // Only "x" verifies as real
    expect(parsed.confirmed.every((c: any) => c.bug === 'x')).toBe(true);
    // Concurrency: max should be > 1 (parallel execution) but <= 4 (cap)
    expect(peak.max).toBeGreaterThan(1);
    expect(peak.max).toBeLessThanOrEqual(4);
  });
});
