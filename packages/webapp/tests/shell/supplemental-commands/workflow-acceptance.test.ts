import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => vi.unstubAllGlobals());

  it('runs a fan-out/verify workflow with schema and bounded concurrency', async () => {
    // ROOT CAUSE of the prior CI failures (#929/#930): the effective concurrency cap is
    // `min(--concurrency, resolveMaxCap())` and `resolveMaxCap() = min(16, max(1, cores-2))`
    // reads `navigator.hardwareConcurrency` (workflow-command.ts). On a 2-core CI runner
    // that is `max(1, 0) = 1`, so `--concurrency 4` is CLAMPED TO 1 → agents run serially →
    // the two "Find bugs" spawns never overlap (peak.max===1), and a concurrency barrier
    // would deadlock (agent B can't acquire the cap-1 semaphore until A finishes, but A
    // waits for B). Locally (many cores) the cap is 4 and it passes — hence "green local,
    // red Release". Pin the core count so the cap is a deterministic 4
    // (min(4, min(16, max(1, 8-2))) = 4) regardless of the runner. Reproduced + verified
    // locally by stubbing navigator to 2 cores (deadlock) vs 8 (pass).
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });

    const fs = await VirtualFS.create({ dbName: `wf-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace', { recursive: true });
    await fs.writeFile('/workspace/repo-audit.workflow.js', FIXTURE);

    const peak = { cur: 0, max: 0 };
    // With the cap pinned to 4 (above), the pipeline issues both "Find bugs" agents
    // together and both acquire the semaphore before either spawn returns. Hold the first
    // PROBE spawns until PROBE are concurrently in flight; the PROBE-th arrival releases
    // the wave — a count-only barrier (no wall-clock) that deterministically yields
    // peak.max ≥ PROBE. This is safe (no deadlock) precisely BECAUSE the cap is ≥ PROBE;
    // the prior failures came from the cap collapsing to 1 on CI, not from this barrier.
    const PROBE = 2;
    let releaseWave!: () => void;
    const waveReady = new Promise<void>((resolve) => {
      releaseWave = resolve;
    });
    let arrived = 0;
    const spawn = async (a: string[]) => {
      peak.cur++;
      peak.max = Math.max(peak.max, peak.cur);
      const index = arrived++;
      if (arrived >= PROBE) releaseWave(); // the PROBE-th concurrent spawn frees the wave
      if (index < PROBE) await waveReady; // only the first wave blocks; later spawns flow
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
        '--wait', // SP2: default run is non-blocking; --wait keeps the full-result assertion below
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
    // Concurrency: with the cap pinned to 4, the two "Find bugs" agents overlap, so
    // peak.max is > 1 (parallel) and <= 4 (cap).
    expect(peak.max).toBeGreaterThan(1);
    expect(peak.max).toBeLessThanOrEqual(4);
    // 10s timeout: a backstop only. The cap is pinned to 4 so the barrier can't deadlock;
    // this guards against unforeseen hangs without masking them behind a huge window.
  }, 10000);
});
