import { describe, expect, it } from 'vitest';
import { type FamilyCost, findFamilyCost } from '../../src/providers/family-cost.js';

type KnownModel = { id: string; cost: FamilyCost };

const zero: FamilyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function mapOf(models: KnownModel[]): Map<string, KnownModel> {
  return new Map(models.map((m) => [m.id, m]));
}

describe('findFamilyCost', () => {
  it('inherits pricing from a known model in the same family', () => {
    const opusCost: FamilyCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    const map = mapOf([
      { id: 'claude-opus-4-8', cost: opusCost },
      { id: 'claude-sonnet-4-6', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    ]);

    expect(findFamilyCost('claude-opus-5', map)).toEqual(opusCost);
  });

  it('returns zeros when no model in the family is known', () => {
    const map = mapOf([
      { id: 'claude-sonnet-4-6', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    ]);

    expect(findFamilyCost('claude-opus-5', map)).toEqual(zero);
  });

  it('picks the highest known version in the family', () => {
    const highCost: FamilyCost = { input: 9, output: 45, cacheRead: 0.9, cacheWrite: 11.25 };
    const map = mapOf([
      { id: 'claude-opus-4-6', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { id: 'claude-opus-4-8', cost: highCost },
      { id: 'claude-opus-4-7', cost: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0 } },
    ]);

    expect(findFamilyCost('claude-opus-5', map)).toEqual(highCost);
  });

  it('compares minor versions when the major matches', () => {
    const map = mapOf([
      { id: 'claude-sonnet-4-5', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { id: 'claude-sonnet-4-6', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    ]);
    expect(findFamilyCost('claude-sonnet-4-9', map)).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it('returns zeros for a non-Claude model id', () => {
    const map = mapOf([
      { id: 'claude-opus-4-8', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
    ]);
    expect(findFamilyCost('gpt-5', map)).toEqual(zero);
  });

  it('returns zeros for an empty model map', () => {
    expect(findFamilyCost('claude-opus-5', mapOf([]))).toEqual(zero);
  });
});
