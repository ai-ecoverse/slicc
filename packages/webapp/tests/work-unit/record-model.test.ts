/**
 * Per-cone model selection on the record (#2310): the read path, the
 * write path, and the migration of records saved before `model` existed.
 */

import { describe, expect, it } from 'vitest';
import {
  modelFor,
  modelIdFor,
  modelProviderFor,
  normalizeScoopRecord,
  setUnitModel,
  setUnitThinking,
  thinkingFor,
} from '../../src/work-unit/record.js';
import { childRecord, rootRecord } from './fixtures.js';

describe('work-unit model + thinking on the record (#2310)', () => {
  it('round-trips a model through a JSON persistence hop', () => {
    const cone = setUnitModel(rootRecord(), { provider: 'anthropic', id: 'claude-opus-4-6' });
    const restored = normalizeScoopRecord(JSON.parse(JSON.stringify(cone)));

    expect(modelFor(restored)).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
    expect(modelIdFor(restored)).toBe('claude-opus-4-6');
    expect(modelProviderFor(restored)).toBe('anthropic');
  });

  it('round-trips thinking next to the model, not in a side channel', () => {
    const cone = setUnitThinking(rootRecord(), { level: 'xhigh', effortOverride: 'max' });
    const restored = normalizeScoopRecord(JSON.parse(JSON.stringify(cone)));

    expect(restored.thinking).toEqual({ level: 'xhigh', effortOverride: 'max' });
    expect(thinkingFor(restored)).toEqual({ level: 'xhigh', effortOverride: 'max' });
    expect(restored.config?.thinkingLevel).toBeUndefined();
  });

  it('migrates a record with only the legacy config pin', () => {
    const legacy = rootRecord({
      config: {
        modelId: 'claude-sonnet-4-6',
        modelProviderId: 'adobe',
        thinkingLevel: 'high',
        effortOverride: 'max',
      },
    });

    normalizeScoopRecord(legacy);

    expect(legacy.model).toEqual({ provider: 'adobe', id: 'claude-sonnet-4-6' });
    expect(legacy.thinking).toEqual({ level: 'high', effortOverride: 'max' });
    // Exactly one home for each value: a stale duplicate in `config` is how a
    // model swap silently keeps the old one.
    expect(legacy.config?.modelId).toBeUndefined();
    expect(legacy.config?.modelProviderId).toBeUndefined();
    expect(legacy.config?.thinkingLevel).toBeUndefined();
    expect(legacy.config?.effortOverride).toBeUndefined();
  });

  it('leaves a record with no pin without a model, for the orchestrator to backfill', () => {
    const legacy = rootRecord();
    normalizeScoopRecord(legacy);
    expect(legacy.model).toBeUndefined();
    expect(modelFor(legacy)).toBeUndefined();
  });

  it('keeps a provider-less legacy pin resolvable instead of inventing a provider', () => {
    // Inventing the selected provider here is exactly the #2195 mis-billing:
    // a cheap cross-provider id would be pinned to whatever is selected now.
    const legacy = childRecord('cone_1', {
      config: { modelId: 'gpt-4.1' },
    });

    normalizeScoopRecord(legacy);

    expect(legacy.model).toBeUndefined();
    expect(modelFor(legacy)).toBeUndefined();
    expect(modelIdFor(legacy)).toBe('gpt-4.1');
    expect(modelProviderFor(legacy)).toBeUndefined();
  });

  it('does not let a migration overwrite a model the record already carries', () => {
    const record = rootRecord({
      model: { provider: 'anthropic', id: 'claude-opus-4-6' },
      config: { modelId: 'gpt-4.1', modelProviderId: 'openai' },
    });

    normalizeScoopRecord(record);

    expect(record.model).toEqual({ provider: 'anthropic', id: 'claude-opus-4-6' });
    expect(record.config?.modelId).toBeUndefined();
  });

  it('clears the model and the thinking level when set to undefined', () => {
    const record = setUnitThinking(
      setUnitModel(rootRecord(), { provider: 'adobe', id: 'claude-opus-4-8' }),
      { level: 'high' }
    );

    setUnitModel(record, undefined);
    setUnitThinking(record, undefined);

    expect(record.model).toBeUndefined();
    expect(record.thinking).toBeUndefined();
    expect(thinkingFor(record)).toEqual({});
  });

  it('copies the model value instead of aliasing the caller’s object', () => {
    const picked = { provider: 'anthropic', id: 'claude-opus-4-6' };
    const record = setUnitModel(rootRecord(), picked);
    picked.id = 'claude-haiku-4-5';
    expect(record.model?.id).toBe('claude-opus-4-6');
  });
});
