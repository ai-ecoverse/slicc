// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { applyThreadContext } from '../../../src/ui/wc/wc-live-thinking-hydration.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import { recordToWorkUnitSummary } from '../../../src/work-unit/client/from-record.js';

vi.mock('../../../src/ui/provider-settings.js', () => ({
  resolveCurrentModel: () => ({ id: 'global-fallback', name: 'Global Fallback', reasoning: true }),
  resolveModelById: (id: string, provider?: string) => ({
    id,
    name: `${provider ?? 'selected'}/${id}`,
    reasoning: true,
  }),
}));

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
} as unknown as Storage);

function refs(): WcShellRefs {
  const make = (tag: string): HTMLElement => document.createElement(tag);
  return {
    composer: make('slicc-composer'),
    inputCard: make('slicc-input-card'),
    composerMeta: make('slicc-composer-meta'),
    thread: make('slicc-chat-thread'),
    switcher: make('slicc-agent-tabs'),
    shader: make('slicc-shader'),
    frame: make('div'),
    freezer: make('slicc-freezer'),
  } as unknown as WcShellRefs;
}

const cone: RegisteredScoop = {
  jid: 'cone_1',
  name: 'Cone',
  folder: 'cone',
  parentJid: null,
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: '2026-08-22T00:00:00.000Z',
  model: { provider: 'anthropic', id: 'claude-opus-4-6' },
};

const scoop: RegisteredScoop = {
  ...cone,
  jid: 'scoop_1',
  name: 'worker',
  folder: 'worker',
  parentJid: cone.jid,

  model: { provider: 'adobe', id: 'claude-sonnet-4-6' },
  thinking: { level: 'high' },
};

function summaries(records: readonly RegisteredScoop[]) {
  return records.map((record) => recordToWorkUnitSummary(record, {}));
}

function byId(records: RegisteredScoop[]) {
  return (id: string) => records.find((record) => record.jid === id);
}

describe('composer model pill per selected unit (#2310)', () => {
  it('shows the selected cone’s own model', async () => {
    const r = refs();
    await applyThreadContext(
      r,
      summaries([cone])[0],
      summaries([cone, scoop]),
      byId([cone, scoop])
    );
    expect(r.composerMeta.getAttribute('model')).toBe('anthropic/claude-opus-4-6');
  });

  it('shows the owning cone’s model for a selected scoop, with the scoop’s own thinking', async () => {
    const r = refs();
    await applyThreadContext(
      r,
      summaries([scoop])[0],
      summaries([cone, scoop]),
      byId([cone, scoop])
    );
    expect(r.composerMeta.getAttribute('model')).toBe('anthropic/claude-opus-4-6');
    expect(r.composerMeta.getAttribute('thinking')).toBe('high');

    expect(r.composer.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the thinking pill when no record answers, never writing off (#2382 D2b)', async () => {
    const r = refs();
    await applyThreadContext(r, summaries([scoop])[0], summaries([cone, scoop]), byId([scoop]));
    expect(r.composerMeta.getAttribute('thinking')).toBe('high');

    await applyThreadContext(r, summaries([cone])[0], summaries([cone, scoop]));
    expect(r.composerMeta.getAttribute('thinking')).toBe('high');
  });

  it('falls back to the selected unit when its owning cone is not in the roster', async () => {
    const r = refs();

    await applyThreadContext(r, summaries([scoop])[0], summaries([scoop]), byId([scoop]));
    expect(r.composerMeta.getAttribute('model')).toBe('adobe/claude-sonnet-4-6');
  });
});
