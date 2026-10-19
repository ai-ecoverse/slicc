import { describe, expect, it } from 'vitest';
import { knownProviderLabel, providerLabel } from '../../src/base/provider-labels.js';
import { getProviderConfig } from '../../src/providers/account-store.js';

describe('provider labels', () => {
  it('names curated ids and leaves the rest to the caller', () => {
    expect(knownProviderLabel('openai')).toBe('OpenAI');
    expect(knownProviderLabel('local')).toBeUndefined();
    expect(knownProviderLabel('mystery-llm')).toBeUndefined();
    expect(providerLabel('mystery-llm')).toBe('mystery-llm');
  });

  it('gives an unregistered provider its curated name before title-casing the id', () => {
    expect(getProviderConfig('openai').name).toBe('OpenAI');
    expect(getProviderConfig('mystery-llm').name).toBe('Mystery Llm');
  });
});
