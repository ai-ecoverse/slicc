import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSessionCostsProvider,
  createCostCommand,
  frozenSessionToCostData,
  registerSessionCostsProvider,
  type ScoopCostData,
  type SessionCostScope,
} from '../../../src/shell/supplemental-commands/cost-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const createMockCtx = () => mockCommandContext();

const now = Date.now();
const mockCosts: ScoopCostData[] = [
  {
    name: 'sliccy',
    type: 'cone',
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6'],
    source: 'live',
    usage: {
      input: 15234,
      output: 3421,
      cacheRead: 8102,
      cacheWrite: 2344,
      totalTokens: 29101,
      cost: { input: 0.45, output: 0.51, cacheRead: 0.12, cacheWrite: 0.05, total: 1.13 },
    },
    turns: 5,
    firstActivity: now - 60 * 60 * 1000, // 1 hour ago
    lastActivity: now,
    activeTimeMs: 60 * 60 * 1000, // 1 hour (4 intervals of 15 minutes)
  },
  {
    name: 'worker',
    type: 'scoop',
    model: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514'],
    source: 'live',
    usage: {
      input: 5102,
      output: 1203,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6305,
      cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
    },
    turns: 2,
    firstActivity: now - 30 * 60 * 1000, // 30 minutes ago
    lastActivity: now,
    activeTimeMs: 30 * 60 * 1000, // 30 minutes (2 intervals of 15 minutes)
  },
];

const droppedCost: ScoopCostData = {
  ...mockCosts[1],
  name: 'retired',
  source: 'dropped',
};

const frozenCost = frozenSessionToCostData({
  filename: '2026-07-01-frozen.md',
  title: 'frozen-work',
  frozenAt: '2026-07-01T12:00:00.000Z',
  messageCount: 8,
  cost: { input: 0.2, output: 0.3, cacheRead: 0.04, cacheWrite: 0.01, total: 0.55 },
  models: [{ model: 'claude-sonnet-4-6', cost: 0.55, turns: 4, tokens: 12_000 }],
});

const allCosts = [...mockCosts, droppedCost, frozenCost];

function registerScopedProvider(scopes: SessionCostScope[]): void {
  registerSessionCostsProvider((scope) => {
    scopes.push(scope);
    return scope === 'all' ? allCosts : mockCosts;
  });
}

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
    expect(result.stdout).toContain('--all');
  });

  it('shows help with -h', async () => {
    const result = await createCostCommand().execute(['-h'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cost');
  });

  it('rejects an unknown flag instead of silently ignoring it', async () => {
    registerSessionCostsProvider(() => mockCosts);
    const result = await createCostCommand().execute(['--bogus'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag: --bogus');
    expect(result.stdout).toBe('');
  });

  it('accepts known flags in any order', async () => {
    const scopes: SessionCostScope[] = [];
    registerScopedProvider(scopes);
    const result = await createCostCommand().execute(['--json', '--all'], ctx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(4);
    expect(scopes).toEqual(['all']);
  });

  it('treats tokens after -- as positional, not flags', async () => {
    registerSessionCostsProvider(() => mockCosts);
    const result = await createCostCommand().execute(['--', '--json'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Session Cost Breakdown');
    expect(result.stdout).not.toContain('"name"');
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
    expect(result.stdout).toContain('sliccy');
    expect(result.stdout).toContain('worker');
    expect(result.stdout).toContain('claude-opus-4-6');
    expect(result.stdout).toContain('$1.13');
    expect(result.stdout).toContain('Total');
    expect(result.stdout).toContain('MTok');
    expect(result.stdout).toContain('$/hour');
    expect(result.stdout).toContain('Source');
    expect(result.stdout).toContain('live');
  });

  it('defaults to live costs and excludes dropped scoops', async () => {
    const scopes: SessionCostScope[] = [];
    registerScopedProvider(scopes);
    const result = await createCostCommand().execute([], ctx);
    expect(result.stdout).toContain('sliccy');
    expect(result.stdout).not.toContain('retired');
    expect(result.stdout).not.toContain('frozen-work');
    expect(scopes).toEqual(['live']);
  });

  it('includes dropped scoops and frozen sessions with --all', async () => {
    const scopes: SessionCostScope[] = [];
    registerScopedProvider(scopes);
    const result = await createCostCommand().execute(['--all'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('retired');
    expect(result.stdout).toContain('dropped');
    expect(result.stdout).toContain('frozen-work');
    expect(result.stdout).toContain('frozen');
    expect(scopes).toEqual(['all']);
  });

  it('outputs JSON with --json', async () => {
    const scopes: SessionCostScope[] = [];
    registerScopedProvider(scopes);
    const result = await createCostCommand().execute(['--json'], ctx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('sliccy');
    expect(parsed[1].name).toBe('worker');
    expect(parsed[0].usage.cost.total).toBe(1.13);
    expect(scopes).toEqual(['live']);
  });

  it('honours --all scoping with --json', async () => {
    const scopes: SessionCostScope[] = [];
    registerScopedProvider(scopes);
    const result = await createCostCommand().execute(['--all', '--json'], ctx);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.map((row: ScoopCostData) => row.source)).toEqual([
      'live',
      'live',
      'dropped',
      'frozen',
    ]);
    expect(scopes).toEqual(['all']);
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

  it('renders frozen sessions without cost data as unknown', async () => {
    const legacyFrozen = frozenSessionToCostData({
      filename: 'legacy.md',
      title: 'legacy',
      frozenAt: '2026-06-01T12:00:00.000Z',
      messageCount: 5,
    });
    registerSessionCostsProvider(() => [legacyFrozen]);
    const result = await createCostCommand().execute(['--all'], ctx);
    const row = result.stdout.split('\n').find((line) => line.includes('legacy')) ?? '';
    const total = result.stdout.split('\n').find((line) => line.includes('Total')) ?? '';
    expect(legacyFrozen.costAvailable).toBe(false);
    expect(row).toContain('frozen');
    expect(row).toContain('-');
    expect(row).not.toContain('$0.00');
    expect(total).toContain('-');
    expect(total).not.toContain('$0.00');
  });

  it('keeps a mixed known-and-unknown cost total unknown', async () => {
    const legacyFrozen = frozenSessionToCostData({
      filename: 'legacy.md',
      title: 'legacy',
      frozenAt: '2026-06-01T12:00:00.000Z',
      messageCount: 5,
    });
    registerSessionCostsProvider(() => [mockCosts[0], legacyFrozen]);

    const tableResult = await createCostCommand().execute(['--all'], ctx);
    const total = tableResult.stdout.split('\n').find((line) => line.includes('Total')) ?? '';
    expect(total).toContain('-');
    expect(total).not.toContain('$1.13');

    const jsonResult = await createCostCommand().execute(['--all', '--json'], ctx);
    const rows = JSON.parse(jsonResult.stdout) as ScoopCostData[];
    expect(rows[0].usage.cost.total).toBe(1.13);
    expect(rows[1].costAvailable).toBe(false);
  });

  it('keeps aggregate-only frozen token categories unavailable', async () => {
    const aggregateOnly = frozenSessionToCostData({
      filename: 'aggregate-only.md',
      title: 'aggregate-only',
      frozenAt: '2026-07-01T12:00:00.000Z',
      messageCount: 8,
      cost: { input: 0.2, output: 0.3, cacheRead: 0.04, cacheWrite: 0.01, total: 0.55 },
      models: [{ model: 'claude-sonnet-4-6', cost: 0.55, turns: 4, tokens: 12_000 }],
    });

    expect(aggregateOnly.usage).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      totalTokens: 12_000,
    });
    registerSessionCostsProvider(() => [aggregateOnly]);
    const jsonResult = await createCostCommand().execute(['--all', '--json'], ctx);
    expect(JSON.parse(jsonResult.stdout)[0].usage).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      totalTokens: 12_000,
    });
    const result = await createCostCommand().execute(['--all'], ctx);
    const row = result.stdout.split('\n').find((line) => line.includes('aggregate-only')) ?? '';
    expect(row).toContain('    - /     -');
    expect(row).not.toContain('<0.01');
  });
});
