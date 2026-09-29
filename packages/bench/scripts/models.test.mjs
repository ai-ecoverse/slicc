import { describe, expect, it } from 'vitest';
import { canonicalModel, modelColors, modelComparisons, parseModel } from './models.mjs';

const hsl = (css) => {
  const [h, s, l] = css.match(/[\d.]+/g).map(Number);
  return { h, s, l };
};

describe('parseModel', () => {
  it('reads provider, family, tier, version and variant', () => {
    expect(parseModel('claude-opus-5-5@max')).toMatchObject({
      base: 'claude-opus-5-5',
      variant: 'max',
      provider: 'anthropic',
      family: 'opus',
      tier: 3,
      version: [5, 5],
    });
    expect(parseModel('claude-sonnet-5')).toMatchObject({
      family: 'sonnet',
      tier: 2,
      version: [5, 0],
    });
    expect(parseModel('gpt-6-luna')).toMatchObject({
      provider: 'openai',
      family: 'luna',
      tier: 1,
      version: [6, 0],
    });
    expect(parseModel('gpt-5.6-sol')).toMatchObject({ family: 'sol', tier: 3, version: [5, 6] });
    expect(parseModel('kimi-k3')).toMatchObject({
      provider: 'moonshot',
      tier: null,
      version: [3, 0],
    });
    expect(parseModel('mystery')).toMatchObject({ provider: 'other', tier: null });
  });

  it('treats @default as the plain model', () => {
    expect(canonicalModel('claude-opus-5-5@default')).toBe('claude-opus-5-5');
    expect(canonicalModel('claude-opus-5-5@low')).toBe('claude-opus-5-5@low');
    expect(parseModel('claude-opus-5-5@default')).toMatchObject({
      spec: 'claude-opus-5-5',
      variant: 'default',
    });
  });
});

describe('modelColors', () => {
  const specs = [
    'claude-opus-5-5',
    'claude-opus-5-5@low',
    'claude-opus-5-5@max',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'gpt-6-luna',
    'gpt-6-sol',
    'kimi-k3',
  ];
  const c = modelColors(specs);
  const light = (m) => hsl(c.get(m).light);

  it('keeps each provider within one hue family, well apart from the others', () => {
    const hues = (ms) => ms.map((m) => light(m).h);
    const anthropic = hues(['claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5']);
    const openai = hues(['gpt-6-luna', 'gpt-6-sol']);
    expect(Math.max(...anthropic) - Math.min(...anthropic)).toBeLessThanOrEqual(28);
    expect(Math.max(...openai) - Math.min(...openai)).toBeLessThanOrEqual(28);
    expect(Math.min(...openai) - Math.max(...anthropic)).toBeGreaterThan(100);
    expect(light('kimi-k3').h).toBeGreaterThan(Math.max(...openai) + 60);

    expect(light('claude-sonnet-5').h).toBe(light('claude-sonnet-5-5').h);
  });

  it('gives each model its own shade and variants a nearby one', () => {
    expect(light('claude-opus-5-5').l).not.toBe(light('claude-sonnet-5-5').l);
    expect(light('claude-opus-5-5@low').l).toBeGreaterThan(light('claude-opus-5-5').l);
    expect(light('claude-opus-5-5@max').l).toBeLessThan(light('claude-opus-5-5').l);
    expect(light('claude-opus-5-5@low').h).toBe(light('claude-opus-5-5').h);
  });

  it('makes older generations less colorful than newer ones', () => {
    expect(light('claude-sonnet-5').s).toBeLessThan(light('claude-sonnet-5-5').s);
    expect(light('claude-opus-5-5').s).toBe(light('claude-sonnet-5-5').s);
  });

  it('has a dark-theme variant for every model', () => {
    for (const m of c.keys()) expect(hsl(c.get(m).dark).l).toBeGreaterThan(light(m).l);
  });
});

describe('modelComparisons', () => {
  const pairs = modelComparisons([
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-opus-5-5@default',
    'claude-opus-5-5@low',
    'claude-opus-5-5@max',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'kimi-k3',
  ]);
  const of = (kind) => pairs.filter((p) => p.kind === kind).map((p) => `${p.from} → ${p.to}`);

  it('compares a model with its newest older version', () => {
    expect(of('version')).toEqual(['claude-sonnet-5 → claude-sonnet-5-5']);
  });

  it('compares siblings across providers by tier', () => {
    expect(of('sibling').sort()).toEqual([
      'gpt-6-astra → claude-fable-5-1',
      'gpt-6-sol → claude-opus-5-5',
    ]);
  });

  it('compares each tier with the next one up at the same provider, once per pair', () => {
    expect(of('rung').sort()).toEqual(
      [
        'claude-opus-5-5 → claude-fable-5-1',
        'claude-sonnet-5 → claude-opus-5-5',
        'claude-sonnet-5-5 → claude-opus-5-5',
        'gpt-6-sol → gpt-6-astra',
      ].sort()
    );
  });

  it('compares thinking variants with the same model at its default', () => {
    expect(of('effort').sort()).toEqual([
      'claude-opus-5-5 → claude-opus-5-5@low',
      'claude-opus-5-5 → claude-opus-5-5@max',
    ]);
  });

  it('never pairs a model with itself, and folds @default into the plain model', () => {
    expect(pairs.some((p) => p.from === p.to)).toBe(false);
    expect(pairs.some((p) => p.from.endsWith('@default') || p.to.endsWith('@default'))).toBe(false);
  });
});
