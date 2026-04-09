import { describe, it, expect, beforeEach } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  createCostCommand,
  registerSessionCostsProvider,
  _resetSessionCostsProvider,
  type ScoopCostData,
} from '../../../src/shell/supplemental-commands/cost-command.js';

function createMockCtx() {
  return {
    fs: {
      resolvePath: (b: string, p: string) => (p.startsWith('/') ? p : `${b}/${p}`),
    } as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

const mockCosts: ScoopCostData[] = [
  {
    name: 'sliccy',
    type: 'cone',
    model: 'claude-opus-4-6',
    usage: {
      input: 15234,
      output: 3421,
      cacheRead: 8102,
      cacheWrite: 2344,
      totalTokens: 29101,
      cost: { input: 0.45, output: 0.51, cacheRead: 0.12, cacheWrite: 0.05, total: 1.13 },
    },
    turns: 5,
  },
  {
    name: 'worker',
    type: 'scoop',
    model: 'claude-sonnet-4-20250514',
    usage: {
      input: 5102,
      output: 1203,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6305,
      cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
    },
    turns: 2,
  },
];

describe('cost command', () => {
  const ctx = createMockCtx();

  beforeEach(() => {
    _resetSessionCostsProvider();
  });

  it('has correct name', () => {
    expect(createCostCommand().name).toBe('cost');
  });

  it('shows help with --help', async () => {
    const result = await createCostCommand().execute(['--help'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cost');
  });

  it('shows help with -h', async () => {
    const result = await createCostCommand().execute(['-h'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cost');
  });

  it('returns error when no provider registered', async () => {
    const result = await createCostCommand().execute([], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not available');
  });

  it('shows no data message for empty session', async () => {
    registerSessionCostsProvider(() => []);
    const result = await createCostCommand().execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No session cost data');
  });

  it('formats table output', async () => {
    registerSessionCostsProvider(() => mockCosts);
    const result = await createCostCommand().execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sliccy (cone)');
    expect(result.stdout).toContain('worker (scoop)');
    expect(result.stdout).toContain('claude-opus-4-6');
    expect(result.stdout).toContain('$1.13');
    expect(result.stdout).toContain('Total');
  });

  it('outputs JSON with --json', async () => {
    registerSessionCostsProvider(() => mockCosts);
    const result = await createCostCommand().execute(['--json'], ctx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('sliccy');
    expect(parsed[1].name).toBe('worker');
    expect(parsed[0].usage.cost.total).toBe(1.13);
  });

  it('shows no data message with --json for empty data', async () => {
    registerSessionCostsProvider(() => []);
    const result = await createCostCommand().execute(['--json'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No session cost data');
  });

  it('supports async provider', async () => {
    registerSessionCostsProvider(() => Promise.resolve(mockCosts));
    const result = await createCostCommand().execute(['--json'], ctx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(2);
  });
});
