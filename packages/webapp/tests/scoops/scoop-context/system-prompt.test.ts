import { describe, expect, it } from 'vitest';
import { AGENT_SAFETY_TRAILER } from '../../../src/scoops/agent-prompt-text.js';
import { buildScoopSystemPrompt } from '../../../src/scoops/scoop-context/system-prompt.js';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { toDescriptor } from '../../../src/work-unit/descriptor.js';
import { childRecord } from '../../work-unit/fixtures.js';

function promptFor(folder: string, config: RegisteredScoop['config']): string {
  const scoop = childRecord('cone_1', { folder, assistantLabel: folder, config });
  return buildScoopSystemPrompt(scoop, toDescriptor(scoop), 'global', 'local', []);
}

describe('buildScoopSystemPrompt cache stability', () => {
  it('drops the scratch folder from a cache-stable prompt', () => {
    const a = promptFor('agent-quiet-vanilla', { cacheStablePrompt: true });
    const b = promptFor('agent-loud-chocolate', { cacheStablePrompt: true });
    expect(a).toBe(b);
    expect(a).not.toContain('agent-quiet-vanilla');
    expect(a).not.toContain('agent-loud-chocolate');
    expect(a).toContain('named in the user message');
    expect(a).toContain('global');
    expect(a).not.toContain('local');
    expect(a).toContain(AGENT_SAFETY_TRAILER);
    expect(a).toContain('# agent');
  });

  it('keeps the folder in the default prompt', () => {
    const a = promptFor('agent-quiet-vanilla', {});
    const b = promptFor('agent-loud-chocolate', {});
    expect(a).not.toBe(b);
    expect(a).toContain('/scoops/agent-quiet-vanilla/');
    expect(a).toContain('local');
    expect(a).not.toContain(AGENT_SAFETY_TRAILER);
  });

  it('uses the override or the minimal prompt, and always the safety trailer', () => {
    const override = promptFor('agent-quiet-vanilla', { systemPromptOverride: 'Decide.' });
    const minimal = promptFor('agent-loud-chocolate', { minimalSystemPrompt: true });
    expect(override).toContain('Decide.');
    expect(override).toContain(AGENT_SAFETY_TRAILER);
    expect(override).not.toContain('Self-Licking');
    expect(override).not.toContain('agent-quiet-vanilla');
    expect(minimal).toContain('StructuredOutput');
    expect(minimal).toContain(AGENT_SAFETY_TRAILER);
    expect(minimal).not.toContain('agent-loud-chocolate');
    expect(minimal).not.toContain('Self-Licking');
  });
});
