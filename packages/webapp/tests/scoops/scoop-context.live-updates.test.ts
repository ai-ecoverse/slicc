/**
 * Hot-swaps onto a running agent (`scoop-context/live-updates.ts`, #2334).
 *
 * These paths used to be reachable only through a fully-initialized
 * `ScoopContext`; carving them out exposed the seam, so cover it directly:
 * a model swap re-resolves the level from the record's *intent*, the
 * deployment-wide effort lock beats a UI request, and a skills reload
 * rebuilds the prompt from re-read memories.
 */

import type { Api } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Model } from '../../src/core/index.js';
import type { VirtualFS } from '../../src/fs/index.js';
import {
  applyModelUpdate,
  applyThinkingLevel,
  rebuildSystemPrompt,
} from '../../src/scoops/scoop-context/live-updates.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { toDescriptor } from '../../src/work-unit/descriptor.js';

/** Only the fields the resolver reads; the rest of `Model` is irrelevant here. */
const model = (fields: Record<string, unknown>) => fields as unknown as Model<Api>;

const REASONING = model({ id: 'm-reasoning', provider: 'p', reasoning: true, contextWindow: 1000 });
const REASONING_XHIGH = model({
  ...REASONING,
  id: 'm-xhigh',
  thinkingLevelMap: { xhigh: 'xhigh' },
});
const PLAIN = model({ id: 'm-plain', provider: 'p', reasoning: false, contextWindow: 1000 });

let resolved: unknown = REASONING;

vi.mock('../../src/providers/account-store.js', () => ({
  resolveModelById: () => resolved,
  resolveCurrentModel: () => resolved,
  getApiKey: () => 'k',
  getApiKeyForProvider: () => 'k',
  modelRunsOnProvider: () => true,
  getSelectedProvider: () => 'p',
}));

vi.mock('../../src/scoops/skills.js', async () => ({
  loadSkills: vi.fn(async () => [{ name: 'demo', description: 'a skill', path: '/s/demo' }]),
  formatSkillsForPrompt: (skills: Array<{ name: string }>) =>
    skills.length ? `\n\nSKILLS: ${skills.map((s) => s.name).join(',')}` : '',
  createDefaultSkills: vi.fn(async () => {}),
}));

function scoopRecord(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  } as RegisteredScoop;
}

function fakeAgent(state: Partial<Agent['state']> = {}): Agent {
  return { state: { model: REASONING, thinkingLevel: 'off', systemPrompt: '', ...state } } as Agent;
}

/** Minimal `localStorage` — the effort lock is the only key read here. */
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
});

function lockEffort(level: string): void {
  store.set('slicc_locked_effort_level', level);
}

beforeEach(() => {
  resolved = REASONING;
  store.clear();
});

describe('applyModelUpdate', () => {
  it('re-reads the level from the record, not the already-clamped agent state', () => {
    // Intent is xhigh; the agent was clamped to high on a model without it.
    const scoop = scoopRecord({ thinking: { level: 'xhigh' } });
    const agent = fakeAgent({ thinkingLevel: 'high' });

    resolved = REASONING_XHIGH;
    applyModelUpdate(agent, scoop);

    expect(agent.state.model).toBe(REASONING_XHIGH);
    expect(agent.state.thinkingLevel).toBe('xhigh');
  });

  it('clamps xhigh back to high on a model that does not advertise it', () => {
    const agent = fakeAgent({ thinkingLevel: 'xhigh' });
    applyModelUpdate(agent, scoopRecord({ thinking: { level: 'xhigh' } }));
    expect(agent.state.thinkingLevel).toBe('high');
  });

  it('clears the effort override when the new model cannot reason', () => {
    const scoop = scoopRecord({ thinking: { level: 'high', effortOverride: 'max' } });
    resolved = PLAIN;
    const agent = fakeAgent();

    expect(applyModelUpdate(agent, scoop)).toBeUndefined();
    expect(agent.state.thinkingLevel).toBe('off');
  });

  it('keeps the effort override on a reasoning model', () => {
    const scoop = scoopRecord({ thinking: { level: 'high', effortOverride: 'max' } });
    expect(applyModelUpdate(fakeAgent(), scoop)).toBe('max');
  });

  it('the deployment-wide effort lock beats the record', () => {
    lockEffort('low');
    const agent = fakeAgent();
    applyModelUpdate(agent, scoopRecord({ thinking: { level: 'high' } }));
    expect(agent.state.thinkingLevel).toBe('low');
  });
});

describe('applyThinkingLevel', () => {
  it('applies a requested level after model-aware resolution', () => {
    const agent = fakeAgent();
    expect(applyThinkingLevel(agent, 'medium')).toBe('medium');
    expect(agent.state.thinkingLevel).toBe('medium');
  });

  it('snaps to off on a non-reasoning model', () => {
    const agent = fakeAgent({ model: PLAIN });
    expect(applyThinkingLevel(agent, 'high')).toBe('off');
  });

  it('ignores the request while an effort lock is in force', () => {
    lockEffort('high');
    const agent = fakeAgent({ thinkingLevel: 'high' });
    expect(applyThinkingLevel(agent, 'off')).toBe('high');
    expect(agent.state.thinkingLevel).toBe('high');
  });

  it('ignores an unrecognized lock value rather than applying it', () => {
    lockEffort('ludicrous');
    const agent = fakeAgent();
    expect(applyThinkingLevel(agent, 'low')).toBe('low');
  });
});

describe('rebuildSystemPrompt', () => {
  it('rebuilds from re-read memories and freshly loaded skills', async () => {
    const scoop = scoopRecord();
    const agent = fakeAgent({ systemPrompt: 'stale' });
    const fs = {
      readFile: vi.fn(async () => 'CONE NOTES'),
    } as unknown as VirtualFS;

    await rebuildSystemPrompt(agent, {
      scoop,
      unit: toDescriptor(scoop),
      fs,
      skillsFs: null,
      getGlobalMemory: async () => 'GLOBAL NOTES',
    });

    expect(agent.state.systemPrompt).not.toBe('stale');
    expect(agent.state.systemPrompt).toContain('GLOBAL NOTES');
    expect(agent.state.systemPrompt).toContain('CONE NOTES');
    expect(agent.state.systemPrompt).toContain('SKILLS: demo');
  });

  it('survives a unit with no memory file yet', async () => {
    const scoop = scoopRecord();
    const agent = fakeAgent();
    const fs = {
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    } as unknown as VirtualFS;

    await rebuildSystemPrompt(agent, {
      scoop,
      unit: toDescriptor(scoop),
      fs,
      skillsFs: null,
      getGlobalMemory: async () => '',
    });

    expect(agent.state.systemPrompt).toContain('SKILLS: demo');
  });
});
