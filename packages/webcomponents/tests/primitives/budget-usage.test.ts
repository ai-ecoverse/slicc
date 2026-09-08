import { describe, expect, it } from 'vitest';
import {
  BUDGET_CRITICAL_PERCENT,
  BUDGET_WARN_PERCENT,
  budgetHue,
  budgetLevel,
  budgetRatio,
  budgetTipFragments,
  budgetWindowLabel,
  formatBudgetFigure,
  formatBudgetPercent,
} from '../../src/primitives/budget-usage.js';

describe('budget-usage', () => {
  describe('budgetLevel', () => {
    it('reads ok below the warn threshold', () => {
      expect(budgetLevel({ percent: 0 })).toBe('ok');
      expect(budgetLevel({ percent: 9.5 })).toBe('ok');
      expect(budgetLevel({ percent: BUDGET_WARN_PERCENT - 0.1 })).toBe('ok');
    });

    it('warns from the warn threshold up to critical', () => {
      expect(budgetLevel({ percent: BUDGET_WARN_PERCENT })).toBe('warn');
      expect(budgetLevel({ percent: 92 })).toBe('warn');
      expect(budgetLevel({ percent: BUDGET_CRITICAL_PERCENT - 0.1 })).toBe('warn');
    });

    it('goes critical at the critical threshold', () => {
      expect(budgetLevel({ percent: BUDGET_CRITICAL_PERCENT })).toBe('critical');
      expect(budgetLevel({ percent: 104 })).toBe('critical');
    });

    it('treats rate-limited as critical whatever the percent claims', () => {
      // The provider's own percent can lag its refusal — a window that is
      // already turning calls away must not read as healthy because the
      // number it last reported was 12%.
      expect(budgetLevel({ percent: 12, status: 'rate-limited' })).toBe('critical');
    });
  });

  describe('budgetRatio', () => {
    it('maps percent onto a 0..1 meter fill', () => {
      expect(budgetRatio(0)).toBe(0);
      expect(budgetRatio(50)).toBe(0.5);
      expect(budgetRatio(100)).toBe(1);
    });

    it('clamps an overrun window and a negative reading', () => {
      expect(budgetRatio(104)).toBe(1);
      expect(budgetRatio(-3)).toBe(0);
    });

    it('draws nothing for a non-finite percent rather than a full bar', () => {
      expect(budgetRatio(Number.NaN)).toBe(0);
      expect(budgetRatio(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe('formatBudgetPercent', () => {
    it('keeps one decimal below 10 and rounds above it', () => {
      expect(formatBudgetPercent(9.5)).toBe('9.5');
      expect(formatBudgetPercent(0.04)).toBe('0');
      expect(formatBudgetPercent(63.2)).toBe('63');
      expect(formatBudgetPercent(96.6)).toBe('97');
    });

    it('drops a trailing zero decimal', () => {
      expect(formatBudgetPercent(2)).toBe('2');
    });

    it('does NOT clamp an overrun figure', () => {
      // The bar clamps; the number is a fact the provider reported.
      expect(formatBudgetFigure(104)).toBe('104%');
    });

    it('floors a negative or non-finite reading at zero', () => {
      expect(formatBudgetPercent(-4)).toBe('0');
      expect(formatBudgetPercent(Number.NaN)).toBe('0');
    });
  });

  describe('copy', () => {
    it('defaults the window name to weekly', () => {
      expect(budgetWindowLabel({ percent: 9.5 })).toBe('weekly budget');
      expect(budgetWindowLabel({ percent: 9.5, window: 'monthly' })).toBe('monthly budget');
    });

    it('says USED, never remaining', () => {
      expect(budgetTipFragments({ percent: 9.5 })).toEqual(['9.5% of weekly budget used']);
    });

    it('names the refusal before the reset', () => {
      expect(
        budgetTipFragments({ percent: 96, status: 'rate-limited', resets: 'resets in 18h' })
      ).toEqual(['96% of weekly budget used', 'rate-limited', 'resets in 18h']);
    });

    it('omits the reset fragment when the host formatted none', () => {
      expect(budgetTipFragments({ percent: 63.2, status: 'ok' })).toEqual([
        '63% of weekly budget used',
      ]);
    });
  });

  describe('budgetHue', () => {
    it('maps each level onto a theme token', () => {
      expect(budgetHue('ok')).toBe('var(--green)');
      expect(budgetHue('warn')).toBe('var(--waffle)');
      expect(budgetHue('critical')).toBe('var(--rose)');
    });
  });
});
