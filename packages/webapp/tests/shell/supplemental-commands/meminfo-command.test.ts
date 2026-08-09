import { describe, expect, it } from 'vitest';
import {
  createMeminfoCommand,
  formatBytes,
  type MemoryMeasurement,
} from '../../../src/shell/supplemental-commands/meminfo-command.js';

const CTX = { fs: {}, cwd: '/', env: new Map(), stdin: new Uint8Array() } as never;

const MEASUREMENT: MemoryMeasurement = {
  bytes: 3 * 1024 * 1024,
  breakdown: [
    {
      bytes: 2 * 1024 * 1024,
      types: ['JavaScript'],
      attribution: [
        { url: 'https://origin/assets/kernel-worker.js', scope: 'DedicatedWorkerGlobalScope' },
      ],
    },
    {
      bytes: 1024 * 1024,
      types: ['JavaScript', 'DOM'],
      attribution: [{ url: 'https://origin/', scope: 'Window' }],
    },
    { bytes: 0, types: ['Shared'], attribution: [] },
  ],
};

describe('formatBytes', () => {
  it('scales through B/KB/MB/GB with one decimal', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(5.5 * 1024 * 1024 * 1024)).toBe('5.5 GB');
  });
});

describe('meminfo', () => {
  it('prints help', async () => {
    const cmd = createMeminfoCommand();
    const result = await cmd.execute(['--help'], CTX);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('meminfo --json');
  });

  it('rejects unknown options without running a measurement', async () => {
    const measure = vi.fn(async () => MEASUREMENT);
    const cmd = createMeminfoCommand({ isIsolated: () => true, measure });
    const result = await cmd.execute(['--jsoon'], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option '--jsoon'");
    expect(measure).not.toHaveBeenCalled();
  });

  it('fails with the isolation explanation when not cross-origin isolated', async () => {
    const cmd = createMeminfoCommand({ isIsolated: () => false });
    const result = await cmd.execute([], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cross-origin-isolated');
    expect(result.stderr).toContain('Document-Isolation-Policy');
  });

  it('fails with the browser-support explanation when isolated but the API is missing', async () => {
    // Node has no performance.measureUserAgentSpecificMemory.
    const cmd = createMeminfoCommand({ isIsolated: () => true });
    const result = await cmd.execute([], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('measureUserAgentSpecificMemory is not available');
  });

  it('renders a sorted human-readable breakdown, dropping zero-byte rows', async () => {
    const cmd = createMeminfoCommand({
      isIsolated: () => true,
      measure: async () => MEASUREMENT,
    });
    const result = await cmd.execute([], CTX);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('total: 3.0 MB');
    const lines = result.stdout.split('\n');
    const kernelRow = lines.findIndex((l: string) => l.includes('kernel-worker.js'));
    const pageRow = lines.findIndex((l: string) => l.includes('Window https://origin/'));
    expect(kernelRow).toBeGreaterThan(0);
    expect(pageRow).toBeGreaterThan(kernelRow); // sorted desc by bytes
    expect(result.stdout).not.toContain('Shared'); // zero-byte row dropped
  });

  it('emits the raw measurement under --json', async () => {
    const cmd = createMeminfoCommand({
      isIsolated: () => true,
      measure: async () => MEASUREMENT,
    });
    const result = await cmd.execute(['--json'], CTX);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.bytes).toBe(3 * 1024 * 1024);
    expect(parsed.breakdown).toHaveLength(3);
  });

  it('surfaces measurement rejections as command errors', async () => {
    const cmd = createMeminfoCommand({
      isIsolated: () => true,
      measure: async () => {
        throw new Error('security context changed');
      },
    });
    const result = await cmd.execute([], CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('security context changed');
  });
});
