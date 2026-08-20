/**
 * `/etc/models` — the allow-list that decides which `provider:model`
 * combinations a scoop may be spawned with while a given provider is selected.
 *
 * Parsing and evaluation are pure, so they are tested directly here; the
 * resolver integration (deny-by-default cross-provider, the copy-pasteable
 * rejection line) lives in cross-provider-model-resolution.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyModelPolicy,
  isModelAllowedByPolicy,
  isModelDeniedByPolicy,
  parseModelPolicy,
  policyHintFor,
} from '../../src/providers/model-policy.js';

const POLICY = `
# comment line
[adobe]
openrouter:*                 # trailing comment
anthropic:claude-opus-4-6
-openrouter:openai/o3-pro
-adobe:claude-opus-5

[anthropic]
adobe:claude-haiku-4-5
`;

describe('parseModelPolicy', () => {
  it('groups entries under the selected provider they apply to', () => {
    const policy = parseModelPolicy(POLICY);
    expect(Object.keys(policy.sections).sort()).toEqual(['adobe', 'anthropic']);
    expect(policy.sections.anthropic).toEqual([
      { providerId: 'adobe', modelId: 'claude-haiku-4-5', deny: false },
    ]);
  });

  it('reads `-` as a denial and strips trailing comments', () => {
    const policy = parseModelPolicy(POLICY);
    expect(policy.sections.adobe).toContainEqual({
      providerId: 'openrouter',
      modelId: '*',
      deny: false,
    });
    expect(policy.sections.adobe).toContainEqual({
      providerId: 'openrouter',
      modelId: 'openai/o3-pro',
      deny: true,
    });
  });

  it('skips a malformed entry without voiding the rest of the section', () => {
    const policy = parseModelPolicy('[adobe]\nnot-a-qualified-id\nopenrouter:gpt-5\n');
    expect(policy.sections.adobe).toEqual([
      { providerId: 'openrouter', modelId: 'gpt-5', deny: false },
    ]);
  });

  it('ignores entries that precede any section header', () => {
    const policy = parseModelPolicy('openrouter:*\n[adobe]\nopenrouter:gpt-5\n');
    expect(policy.sections.adobe).toHaveLength(1);
  });

  it('keeps an empty section distinct from a missing one', () => {
    const policy = parseModelPolicy('[adobe]\n');
    expect(policy.sections.adobe).toEqual([]);
    expect(policy.sections.openrouter).toBeUndefined();
  });

  it('tolerates a non-string body', () => {
    expect(parseModelPolicy(undefined as unknown as string)).toEqual(emptyModelPolicy());
  });
});

describe('isModelAllowedByPolicy', () => {
  const policy = parseModelPolicy(POLICY);

  it("always allows the selected provider's own catalogue", () => {
    expect(isModelAllowedByPolicy(policy, 'adobe', 'adobe', 'claude-sonnet-4-6')).toBe(true);
    // …even with no file at all.
    expect(isModelAllowedByPolicy(emptyModelPolicy(), 'adobe', 'adobe', 'anything')).toBe(true);
  });

  it("denies another provider's model when nothing allows it (the default)", () => {
    expect(isModelAllowedByPolicy(emptyModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(false);
    // A section for a DIFFERENT selected provider must not leak across.
    expect(isModelAllowedByPolicy(policy, 'openrouter', 'adobe', 'claude-opus-4-6')).toBe(false);
  });

  it('allows a whole catalogue via `provider:*`', () => {
    expect(isModelAllowedByPolicy(policy, 'adobe', 'openrouter', 'anything-at-all')).toBe(true);
  });

  it('allows exactly one model via `provider:model`', () => {
    expect(isModelAllowedByPolicy(policy, 'adobe', 'anthropic', 'claude-opus-4-6')).toBe(true);
    expect(isModelAllowedByPolicy(policy, 'adobe', 'anthropic', 'claude-sonnet-4-6')).toBe(false);
  });

  it('lets a deny beat a wildcard allow', () => {
    expect(isModelAllowedByPolicy(policy, 'adobe', 'openrouter', 'openai/o3-pro')).toBe(false);
  });

  it("lets a deny subtract from the selected provider's own catalogue", () => {
    expect(isModelAllowedByPolicy(policy, 'adobe', 'adobe', 'claude-opus-5')).toBe(false);
  });

  it('applies a deny regardless of entry order', () => {
    const reversed = parseModelPolicy('[adobe]\n-openrouter:gpt-5\nopenrouter:*\n');
    expect(isModelAllowedByPolicy(reversed, 'adobe', 'openrouter', 'gpt-5')).toBe(false);
    expect(isModelAllowedByPolicy(reversed, 'adobe', 'openrouter', 'gpt-4o')).toBe(true);
  });

  it('supports denying a whole catalogue with `-provider:*`', () => {
    const policyWithBlanketDeny = parseModelPolicy('[adobe]\n-adobe:*\n');
    expect(isModelAllowedByPolicy(policyWithBlanketDeny, 'adobe', 'adobe', 'claude-opus-5')).toBe(
      false
    );
  });
});

describe('isModelDeniedByPolicy (the picker half)', () => {
  const policy = parseModelPolicy(POLICY);

  it('reports only EXPLICIT denials', () => {
    expect(isModelDeniedByPolicy(policy, 'adobe', 'adobe', 'claude-opus-5')).toBe(true);
    expect(isModelDeniedByPolicy(policy, 'adobe', 'openrouter', 'openai/o3-pro')).toBe(true);
  });

  it('does NOT report a merely un-allowed cross-provider model', () => {
    // The allow-list half is deliberately not applied to the picker: it would
    // hide every other account and make switching providers impossible.
    expect(isModelAllowedByPolicy(emptyModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(false);
    expect(isModelDeniedByPolicy(emptyModelPolicy(), 'adobe', 'openrouter', 'gpt-5')).toBe(false);
  });
});

describe('policyHintFor', () => {
  it('names the file, the section and both spellings of the entry', () => {
    const hint = policyHintFor('adobe', 'openrouter', 'gpt-5');
    expect(hint).toContain('/etc/models');
    expect(hint).toContain('[adobe]');
    expect(hint).toContain('openrouter:gpt-5');
    expect(hint).toContain('openrouter:*');
  });
});
