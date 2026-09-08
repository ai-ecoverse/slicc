import { describe, expect, it } from 'vitest';
import {
  BUDGET_CRITICAL_PERCENT as PRESENTATIONAL_CRITICAL,
  BUDGET_WARN_PERCENT as PRESENTATIONAL_WARN,
  budgetLevel as presentationalLevel,
  formatBudgetPercent as presentationalPercent,
} from '../../../webcomponents/src/primitives/budget-usage.js';
import {
  BUDGET_CRITICAL_PERCENT,
  BUDGET_WARN_PERCENT,
  budgetLevel,
  describeBudgetWindow,
  formatBudgetPercent,
  formatBudgetResets,
  parseProviderUsage,
} from '../../src/providers/provider-budget.js';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe('parseProviderUsage', () => {
  it('reads the weekly window in the proxy shape', () => {
    expect(
      parseProviderUsage({
        usage: { weekly: { status: 'ok', percent: 9.5, resetsAt: '2026-09-14T00:00:00.000Z' } },
      })
    ).toEqual({
      percent: 9.5,
      status: 'ok',
      window: 'weekly',
      resetsAt: '2026-09-14T00:00:00.000Z',
    });
  });

  it('carries a rate-limited window through', () => {
    const parsed = parseProviderUsage({
      usage: { weekly: { status: 'rate-limited', percent: 96 } },
    });
    expect(parsed?.status).toBe('rate-limited');
    expect(parsed?.resetsAt).toBeUndefined();
  });

  it('treats an unknown status as ok rather than inventing a refusal', () => {
    expect(
      parseProviderUsage({ usage: { weekly: { status: 'degraded', percent: 12 } } })?.status
    ).toBe('ok');
  });

  it('prefers weekly when several windows are reported', () => {
    const parsed = parseProviderUsage({
      usage: { monthly: { percent: 40 }, weekly: { percent: 9.5 } },
    });
    expect(parsed?.window).toBe('weekly');
    expect(parsed?.percent).toBe(9.5);
  });

  it('falls back to another window so a future monthly needs no code change', () => {
    const parsed = parseProviderUsage({ usage: { monthly: { percent: 40 } } });
    expect(parsed).toMatchObject({ window: 'monthly', percent: 40 });
  });

  it('accepts a payload without the usage envelope', () => {
    expect(parseProviderUsage({ weekly: { percent: 3 } })?.percent).toBe(3);
  });

  it('reports NOTHING rather than 0% when the payload carries no usable percent', () => {
    // "We don't know" and "nothing used" must not look alike on a surface
    // whose whole job is to say how much of the allowance is gone.
    expect(parseProviderUsage({ usage: { weekly: { status: 'ok' } } })).toBeNull();
    expect(parseProviderUsage({ usage: { weekly: { percent: 'lots' } } })).toBeNull();
    expect(parseProviderUsage({ usage: { weekly: { percent: Number.NaN } } })).toBeNull();
    expect(parseProviderUsage({ usage: {} })).toBeNull();
    expect(parseProviderUsage(null)).toBeNull();
    expect(parseProviderUsage('nope')).toBeNull();
  });

  it('keeps an overrun percent as reported', () => {
    expect(parseProviderUsage({ usage: { weekly: { percent: 104 } } })?.percent).toBe(104);
  });
});

describe('formatBudgetResets', () => {
  it('counts down in minutes, hours, then days', () => {
    expect(formatBudgetResets(iso(45 * 60_000), NOW)).toBe('resets in 45m');
    expect(formatBudgetResets(iso(18 * 3_600_000), NOW)).toBe('resets in 18h');
    expect(formatBudgetResets(iso(6 * 86_400_000), NOW)).toBe('resets in 6d');
  });

  it('never counts up past the reset instant', () => {
    expect(formatBudgetResets(iso(-2 * 3_600_000), NOW)).toBe('resetting now');
  });

  it('rounds a sub-minute window up to 1m rather than to 0m', () => {
    expect(formatBudgetResets(iso(20_000), NOW)).toBe('resets in 1m');
  });

  it('omits the fragment when the provider named no instant', () => {
    expect(formatBudgetResets(undefined, NOW)).toBeUndefined();
    expect(formatBudgetResets('not-a-date', NOW)).toBeUndefined();
  });
});

describe('formatBudgetPercent', () => {
  it('keeps one decimal below 10 and rounds above it', () => {
    expect(formatBudgetPercent(9.5)).toBe('9.5');
    expect(formatBudgetPercent(63.2)).toBe('63');
    expect(formatBudgetPercent(2)).toBe('2');
  });

  it('floors a negative or non-finite reading at zero', () => {
    expect(formatBudgetPercent(-4)).toBe('0');
    expect(formatBudgetPercent(Number.NaN)).toBe('0');
  });

  it('agrees with the webcomponents formatter it is pinned to', () => {
    // The two are duplicated on purpose — the shell command must not pull a
    // DOM-bound component library into the kernel-worker bundle — so this test
    // is what keeps a pill and a terminal reporting the same figure. Imported
    // by PATH, not through the barrel, which needs `CSSStyleSheet`.
    for (const percent of [0, 0.04, 2, 9.5, 9.96, 10, 63.2, 80, 95, 96.6, 104]) {
      expect(formatBudgetPercent(percent)).toBe(presentationalPercent(percent));
    }
  });

  it('agrees with the webcomponents level ladder', () => {
    const cases: Array<{ percent: number; status?: 'ok' | 'rate-limited' }> = [
      { percent: 0 },
      { percent: 9.5 },
      { percent: 79.9 },
      { percent: 80 },
      { percent: 94.9 },
      { percent: 95 },
      { percent: 104 },
      { percent: 12, status: 'rate-limited' },
    ];
    for (const window of cases) {
      expect(budgetLevel(window)).toBe(presentationalLevel(window));
    }
    expect([BUDGET_WARN_PERCENT, BUDGET_CRITICAL_PERCENT]).toEqual([
      PRESENTATIONAL_WARN,
      PRESENTATIONAL_CRITICAL,
    ]);
  });
});

describe('describeBudgetWindow', () => {
  it('says USED, and names the refusal before the reset', () => {
    expect(
      describeBudgetWindow(
        { percent: 96, status: 'rate-limited', window: 'weekly', resetsAt: iso(18 * 3_600_000) },
        NOW
      )
    ).toBe('96% of weekly budget used · rate-limited · resets in 18h');
  });

  it('drops the fragments that do not apply', () => {
    expect(describeBudgetWindow({ percent: 9.5, status: 'ok', window: 'weekly' }, NOW)).toBe(
      '9.5% of weekly budget used'
    );
  });
});
