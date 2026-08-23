import { describe, expect, it } from 'vitest';
import {
  AGENT_ADJECTIVES,
  AGENT_FLAVORS,
  AGENT_NAME_COMBINATIONS,
} from '../../src/scoops/agent-names.js';

describe('agent-names word pools', () => {
  it('yields at least a million <adjective>-<flavor> combinations', () => {
    expect(AGENT_NAME_COMBINATIONS).toBe(AGENT_ADJECTIVES.length * AGENT_FLAVORS.length);
    expect(AGENT_NAME_COMBINATIONS).toBeGreaterThanOrEqual(1_000_000);
  });

  it('keeps every token single-word lowercase so names match /^agent-[a-z]+-[a-z]+$/', () => {
    for (const w of [...AGENT_ADJECTIVES, ...AGENT_FLAVORS]) expect(w).toMatch(/^[a-z]+$/);
  });

  it('has no duplicates within or across the two pools', () => {
    expect(new Set(AGENT_ADJECTIVES).size).toBe(AGENT_ADJECTIVES.length);
    expect(new Set(AGENT_FLAVORS).size).toBe(AGENT_FLAVORS.length);
    const adjectives = new Set(AGENT_ADJECTIVES);
    expect(AGENT_FLAVORS.filter((w) => adjectives.has(w))).toEqual([]);
  });
});
