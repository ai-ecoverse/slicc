import type { ConeEntry } from '@slicc/cloud-core';
import { describe, expect, it } from 'vitest';
import { checkCapsForRun } from '../src/cloud/caps.js';

const env = { CONE_CAP_RUNNING: '1', CONE_CAP_PAUSED: '5' };

function cone(id: string, state: ConeEntry['state']): ConeEntry {
  return {
    sandboxId: id,
    substrate: 'e2b',
    createdAt: '',
    lastSeen: '',
    joinUrl: '',
    state,
  };
}

describe('checkCapsForRun', () => {
  it('passes when nothing is running', () => {
    expect(checkCapsForRun([], env).ok).toBe(true);
  });
  it('rejects RUNNING_CAP when at running cap', () => {
    const result = checkCapsForRun([cone('s1', 'running')], env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('RUNNING_CAP');
  });
  it('rejects PAUSED_CAP when at paused cap', () => {
    const cones = Array.from({ length: 5 }, (_, i) => cone(`s${i}`, 'paused'));
    const result = checkCapsForRun(cones, env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('PAUSED_CAP');
  });
  it('passes within both caps', () => {
    const cones = [cone('s1', 'paused'), cone('s2', 'paused')];
    expect(checkCapsForRun(cones, env).ok).toBe(true);
  });
  it('ignores dead cones in counts', () => {
    const cones = [cone('s1', 'dead'), cone('s2', 'dead')];
    expect(checkCapsForRun(cones, env).ok).toBe(true);
  });
  it('counts reserved cones toward running cap', () => {
    const cones = [cone('s1', 'reserved')];
    const result = checkCapsForRun(cones, env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('RUNNING_CAP');
  });
  it('throws on invalid CONE_CAP_RUNNING (NaN)', () => {
    expect(() => checkCapsForRun([], { CONE_CAP_RUNNING: 'oops', CONE_CAP_PAUSED: '5' })).toThrow(
      /Invalid cap env CONE_CAP_RUNNING/
    );
  });
  it('throws on invalid CONE_CAP_PAUSED (empty string)', () => {
    expect(() => checkCapsForRun([], { CONE_CAP_RUNNING: '1', CONE_CAP_PAUSED: '' })).toThrow(
      /Invalid cap env CONE_CAP_PAUSED/
    );
  });
  it('throws on negative cap value', () => {
    expect(() => checkCapsForRun([], { CONE_CAP_RUNNING: '-1', CONE_CAP_PAUSED: '5' })).toThrow(
      /Invalid cap env CONE_CAP_RUNNING/
    );
  });
});
