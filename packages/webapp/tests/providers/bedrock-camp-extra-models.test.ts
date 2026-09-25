import { describe, expect, it } from 'vitest';
import {
  BEDROCK_CAMP_GPT6_ASTRA_EFFORT_MAP,
  BEDROCK_CAMP_GPT6_EFFORT_MAP,
  isBedrockCampCompatible,
} from '../../src/providers/built-in/bedrock-camp-compat.js';
import {
  BEDROCK_CAMP_EXTRA_MODELS,
  mergeBedrockCampCatalogue,
} from '../../src/providers/built-in/bedrock-camp-extra-models.js';
import {
  claudeRejectsTemperature,
  claudeSupportsAdaptiveThinking,
  claudeSupportsNativeXhighEffort,
  claudeSupportsPromptCaching,
} from '../../src/providers/claude-model-version.js';

const byId = (id: string) => BEDROCK_CAMP_EXTRA_MODELS.find((m) => m.id === id);

describe('BEDROCK_CAMP_EXTRA_MODELS', () => {
  it('lists Opus 5.5 on every inference profile AWS serves it from', () => {
    const ids = BEDROCK_CAMP_EXTRA_MODELS.map((m) => m.id).filter((id) =>
      id.endsWith('anthropic.claude-opus-5-5')
    );
    expect(ids.sort()).toEqual([
      'au.anthropic.claude-opus-5-5',
      'eu.anthropic.claude-opus-5-5',
      'global.anthropic.claude-opus-5-5',
      'jp.anthropic.claude-opus-5-5',
      'us.anthropic.claude-opus-5-5',
    ]);
  });

  it('prices global at list price and regional profiles at the 10% premium', () => {
    expect(byId('global.anthropic.claude-opus-5-5')?.cost).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    });
    expect(byId('us.anthropic.claude-opus-5-5')?.cost).toEqual({
      input: 4.4,
      output: 22,
      cacheRead: 0.22,
      cacheWrite: 5.5,
    });
  });

  it('labels each profile in the display name', () => {
    expect(byId('eu.anthropic.claude-opus-5-5')?.name).toBe('Claude Opus 5.5 (EU)');
    expect(byId('global.anthropic.claude-opus-5-5')?.name).toBe('Claude Opus 5.5 (Global)');
  });

  it('only contains ids the picker filter accepts', () => {
    for (const m of BEDROCK_CAMP_EXTRA_MODELS) {
      expect(isBedrockCampCompatible(m), m.id).toBe(true);
    }
  });

  it('carries the capabilities verified live for Opus 5.5', () => {
    // Bedrock answered 400 to `temperature` and to `thinking.type.enabled`,
    // accepted adaptive thinking up to effort `max`, and cached via cachePoint.
    const id = 'us.anthropic.claude-opus-5-5';
    expect(claudeRejectsTemperature(id)).toBe(true);
    expect(claudeSupportsAdaptiveThinking(id)).toBe(true);
    expect(claudeSupportsNativeXhighEffort(id)).toBe(true);
    expect(claudeSupportsPromptCaching(id)).toBe(true);
    expect(byId(id)?.reasoning).toBe(true);
    expect(byId(id)?.thinkingLevelMap).toEqual({ xhigh: 'xhigh', max: 'max' });
  });
});

// Figures from pi's hosted `amazon-bedrock` catalogue; GPT-6's long-context
// tier from models.dev. See the source comments in the spec list.
describe('models admitted for the benchmark', () => {
  const BASE_IDS = [
    'anthropic.claude-fable-5-1',
    'openai.gpt-6-sol',
    'openai.gpt-6-luna',
    'openai.gpt-6-astra',
    'moonshotai.kimi-k3',
  ];

  it.each(BASE_IDS.map((b) => [b]))(
    'lists %s on exactly the global. and us. profiles',
    (baseId) => {
      const ids = BEDROCK_CAMP_EXTRA_MODELS.map((m) => m.id).filter((id) =>
        id.endsWith(`.${baseId}`)
      );
      expect(ids.sort()).toEqual([`global.${baseId}`, `us.${baseId}`]);
    }
  );

  it.each([
    ['anthropic.claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
    ['moonshotai.kimi-k3', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ])('prices %s from the catalogue, US at +10%%', (baseId, global) => {
    expect(byId(`global.${baseId}`)?.cost).toEqual(global);
    const us = byId(`us.${baseId}`)?.cost;
    expect(us?.input).toBeCloseTo(global.input * 1.1, 10);
    expect(us?.output).toBeCloseTo(global.output * 1.1, 10);
    expect(us?.cacheRead).toBeCloseTo(global.cacheRead * 1.1, 10);
    expect(us?.cacheWrite).toBeCloseTo(global.cacheWrite * 1.1, 10);
  });

  it('matches the published US Kimi K3 price exactly', () => {
    expect(byId('us.moonshotai.kimi-k3')?.cost).toEqual({
      input: 3.3,
      output: 16.5,
      cacheRead: 0.33,
      cacheWrite: 4.125,
    });
  });

  it.each([
    [
      'openai.gpt-6-sol',
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
    ],
    [
      'openai.gpt-6-luna',
      { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
    ],
    [
      'openai.gpt-6-astra',
      { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
    ],
  ])('prices %s with its long-context tier above 272k input', (baseId, base, tier) => {
    expect(byId(`global.${baseId}`)?.cost).toEqual({
      ...base,
      tiers: [{ inputTokensAbove: 272_000, ...tier }],
    });
  });

  it('keeps sub-cent regional prices exact (no three-decimal rounding)', () => {
    // pi and models.dev both list $0.1375 for the `us.` GPT-6 Luna cache write.
    expect(byId('us.openai.gpt-6-luna')?.cost).toEqual({
      input: 0.11,
      output: 0.55,
      cacheRead: 0.011,
      cacheWrite: 0.1375,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 0.22,
          output: 0.825,
          cacheRead: 0.022,
          cacheWrite: 0.275,
        },
      ],
    });
  });

  it('never prices a model at zero', () => {
    // The benchmark bills from these numbers; a zero would make a model look free.
    for (const m of BEDROCK_CAMP_EXTRA_MODELS) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        expect(m.cost[key], `${m.id} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('does not share cost objects between profiles', () => {
    const global = byId('global.openai.gpt-6-sol');
    const us = byId('us.openai.gpt-6-sol');
    expect(global?.cost.tiers).not.toBe(us?.cost.tiers);
  });

  it('carries the limits from the catalogue', () => {
    expect(byId('global.anthropic.claude-fable-5-1')).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    for (const v of ['sol', 'luna', 'astra']) {
      expect(byId(`us.openai.gpt-6-${v}`)).toMatchObject({
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      });
    }
    expect(byId('us.moonshotai.kimi-k3')).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 128_000,
    });
  });

  it('names each model the way the catalogue does', () => {
    expect(byId('global.anthropic.claude-fable-5-1')?.name).toBe('Claude Fable 5.1 (Global)');
    expect(byId('us.openai.gpt-6-astra')?.name).toBe('GPT-6 Astra (US)');
    expect(byId('global.moonshotai.kimi-k3')?.name).toBe('Kimi K3 (Global)');
  });

  it('carries the capabilities verified live for Fable 5.1', () => {
    // `thinking.type.enabled` and `.disabled` 400, adaptive up to effort `max`
    // is accepted, and `temperature` 400s.
    const id = 'us.anthropic.claude-fable-5-1';
    expect(claudeRejectsTemperature(id)).toBe(true);
    expect(claudeSupportsAdaptiveThinking(id)).toBe(true);
    expect(claudeSupportsNativeXhighEffort(id)).toBe(true);
    expect(claudeSupportsPromptCaching(id)).toBe(true);
    expect(byId(id)?.thinkingLevelMap).toEqual({ off: null, xhigh: 'xhigh', max: 'max' });
  });

  it("gives GPT-6 the live-verified effort levels, not pi's xhigh-only map", () => {
    for (const v of ['sol', 'luna']) {
      expect(byId(`global.openai.gpt-6-${v}`)?.thinkingLevelMap).toEqual(
        BEDROCK_CAMP_GPT6_EFFORT_MAP
      );
    }
    expect(byId('us.openai.gpt-6-astra')?.thinkingLevelMap).toEqual(
      BEDROCK_CAMP_GPT6_ASTRA_EFFORT_MAP
    );
  });

  it('gives Kimi K3 no thinkingLevelMap, since Bedrock ignores every effort shape', () => {
    expect(byId('global.moonshotai.kimi-k3')).not.toHaveProperty('thinkingLevelMap');
  });
});

describe('mergeBedrockCampCatalogue', () => {
  it('appends extras the catalogue does not know', () => {
    const merged = mergeBedrockCampCatalogue([{ id: 'a', v: 1 }], [{ id: 'b', v: 2 }]);
    expect(merged).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
  });

  it("keeps pi-ai's entry when both list the same id", () => {
    const merged = mergeBedrockCampCatalogue(
      [{ id: 'us.anthropic.claude-opus-5-5', v: 'pi-ai' }],
      [{ id: 'us.anthropic.claude-opus-5-5', v: 'extra' }]
    );
    expect(merged).toEqual([{ id: 'us.anthropic.claude-opus-5-5', v: 'pi-ai' }]);
  });

  // pi's hosted Bedrock catalogue (the default-on live overlay) lists GPT-6
  // without its long-context tier, and its entry wins the collision.
  describe('long-context tiers', () => {
    const extra = byId('us.openai.gpt-6-sol')!;
    const base = { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 };

    it('grafts the extra tiers onto a same-priced catalogue entry that has none', () => {
      const [merged] = mergeBedrockCampCatalogue(
        [{ ...extra, name: 'from pi', cost: { ...base } }],
        [extra]
      );
      expect(merged.name).toBe('from pi');
      expect(merged.cost).toEqual({ ...base, tiers: extra.cost.tiers });
      expect(merged.cost.tiers).not.toBe(extra.cost.tiers);
    });

    it("keeps the catalogue's own tiers", () => {
      const own = [{ inputTokensAbove: 200_000, input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }];
      const [merged] = mergeBedrockCampCatalogue(
        [{ ...extra, cost: { ...base, tiers: own } }],
        [extra]
      );
      expect(merged.cost.tiers).toBe(own);
    });

    it('does not graft onto a catalogue entry whose base prices differ', () => {
      const repriced = { ...base, input: 1.1 };
      const [merged] = mergeBedrockCampCatalogue([{ ...extra, cost: repriced }], [extra]);
      expect(merged.cost).toEqual(repriced);
    });

    it('leaves collisions without extra tiers untouched', () => {
      const kimi = byId('us.moonshotai.kimi-k3')!;
      const fromPi = { ...kimi, cost: { ...kimi.cost } };
      const [merged] = mergeBedrockCampCatalogue([fromPi], [kimi]);
      expect(merged).toBe(fromPi);
    });
  });
});
