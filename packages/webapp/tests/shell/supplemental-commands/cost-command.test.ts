import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderBudgetWindow } from '../../../src/providers/provider-budget.js';
import {
  _resetSessionCostsProvider,
  createCostCommand,
  frozenSessionToCostData,
  registerSessionBudgetProvider,
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
    expect(parsed.scoops).toHaveLength(4);
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
    // The envelope is stable in both directions: `budget` is null on a metered
    // provider rather than absent, so a script never has to shape-check.
    expect(parsed.budget).toBeNull();
    expect(parsed.scoops).toHaveLength(2);
    expect(parsed.scoops[0].name).toBe('sliccy');
    expect(parsed.scoops[1].name).toBe('worker');
    expect(parsed.scoops[0].usage.cost.total).toBe(1.13);
    expect(scopes).toEqual(['live']);
  });

  it('honours --all scoping with --json', async () => {
    const scopes: SessionCostScope[] = [];
    registerScopedProvider(scopes);
    const result = await createCostCommand().execute(['--all', '--json'], ctx);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scoops.map((row: ScoopCostData) => row.source)).toEqual([
      'live',
      'live',
      'dropped',
      'frozen',
    ]);
    expect(scopes).toEqual(['all']);
  });

  it('emits an EMPTY envelope with --json rather than prose', async () => {
    // `--json` is now parseable in every case; it used to answer the
    // no-data path with the human sentence, which no `JSON.parse` survives.
    registerSessionCostsProvider(() => []);
    const result = await createCostCommand().execute(['--json'], ctx);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ budget: null, scoops: [] });
  });

  it('supports async provider', async () => {
    registerSessionCostsProvider(() => Promise.resolve(mockCosts));
    const result = await createCostCommand().execute(['--json'], ctx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scoops).toHaveLength(2);
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
    const rows = JSON.parse(jsonResult.stdout).scoops as ScoopCostData[];
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
    expect(JSON.parse(jsonResult.stdout).scoops[0].usage).toMatchObject({
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

describe('cost on a budget provider', () => {
  let ctx: ReturnType<typeof createMockCtx>;

  const week = (over: Partial<ProviderBudgetWindow> = {}): ProviderBudgetWindow => ({
    percent: 9.5,
    status: 'ok',
    window: 'weekly',
    resetsAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
    providerId: 'adobe',
    ...over,
  });

  beforeEach(() => {
    _resetSessionCostsProvider();
    ctx = createMockCtx();
    registerSessionCostsProvider(() => mockCosts);
  });

  it('leads the report with the window, above the dollar table', () => {
    registerSessionBudgetProvider(() => week());
    return createCostCommand()
      .execute([], ctx)
      .then((result) => {
        expect(result.exitCode).toBe(0);
        const lines = result.stdout.split('\n');
        expect(lines[0]).toBe('Weekly budget: 9.5% used');
        expect(lines[1]).toContain('resets in 6d');
        expect(lines[1]).toContain('adobe');
        // The dollars survive, below the headline.
        expect(result.stdout).toContain('Session Cost Breakdown');
        expect(result.stdout).toContain('$1.13');
        expect(result.stdout.indexOf('Weekly budget')).toBeLessThan(
          result.stdout.indexOf('Session Cost Breakdown')
        );
      });
  });

  it('says plainly that a rate-limited provider is refusing calls', async () => {
    registerSessionBudgetProvider(() => week({ percent: 96, status: 'rate-limited' }));
    const result = await createCostCommand().execute([], ctx);
    expect(result.stdout).toContain('RATE-LIMITED');
    expect(result.stdout).toContain('refusing calls until the window resets');
  });

  it('draws a full bar for an overrun but still reports the real figure', async () => {
    registerSessionBudgetProvider(() => week({ percent: 104, status: 'rate-limited' }));
    const result = await createCostCommand().execute([], ctx);
    expect(result.stdout).toContain('104% used');
    expect(result.stdout).toContain('█'.repeat(24));
    expect(result.stdout).not.toContain('░');
  });

  it('still shows the window when this session has spent nothing', async () => {
    // The allowance is SHARED: it can be half gone before this session's first
    // turn, so "no cost data" must not swallow the headline.
    registerSessionCostsProvider(() => []);
    registerSessionBudgetProvider(() => week({ percent: 63.2 }));
    const result = await createCostCommand().execute([], ctx);
    expect(result.stdout).toContain('Weekly budget: 63% used');
    expect(result.stdout).toContain('No session cost data yet.');
  });

  it('carries the window in the JSON envelope beside the scoops', async () => {
    registerSessionBudgetProvider(() => week());
    const result = await createCostCommand().execute(['--json'], ctx);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.budget).toMatchObject({ percent: 9.5, status: 'ok', window: 'weekly' });
    expect(parsed.scoops).toHaveLength(2);
  });

  it('prints the dollar report unchanged when no budget source is registered', async () => {
    const result = await createCostCommand().execute([], ctx);
    expect(result.stdout.startsWith('Session Cost Breakdown')).toBe(true);
    expect(result.stdout).not.toContain('budget');
  });

  it('prints the dollar report when the budget source reports none', async () => {
    registerSessionBudgetProvider(() => null);
    const result = await createCostCommand().execute([], ctx);
    expect(result.stdout.startsWith('Session Cost Breakdown')).toBe(true);
  });

  it('keeps reporting the dollars when the budget source THROWS', async () => {
    // A missing headline is not a failed report: what is below it is still true.
    registerSessionBudgetProvider(() => Promise.reject(new Error('proxy 503')));
    const result = await createCostCommand().execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Session Cost Breakdown');
    const json = await createCostCommand().execute(['--json'], ctx);
    expect(JSON.parse(json.stdout).budget).toBeNull();
  });

  it('documents the budget behaviour in --help', async () => {
    const result = await createCostCommand().execute(['--help'], ctx);
    expect(result.stdout).toContain('rolling allowance');
    expect(result.stdout).toContain('"budget"');
  });
});
