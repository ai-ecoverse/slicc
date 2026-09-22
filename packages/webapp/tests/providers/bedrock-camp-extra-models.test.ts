import { describe, expect, it } from 'vitest';
import { isBedrockCampCompatible } from '../../src/providers/built-in/bedrock-camp-compat.js';
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
});
