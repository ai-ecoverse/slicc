// @vitest-environment jsdom

/**
 * The composer's model pill follows the unit the PICKER edits (#2310): a
 * selected cone shows its own model, a selected scoop shows the model of the
 * cone that owns it — because a pick made while a scoop is selected lands on
 * that cone and scoops are never retargeted.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import { applyThreadContext } from '../../../src/ui/wc/wc-live-thinking-hydration.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

vi.mock('../../../src/ui/provider-settings.js', () => ({
  resolveCurrentModel: () => ({ id: 'global-fallback', name: 'Global Fallback', reasoning: true }),
  resolveModelById: (id: string, provider?: string) => ({
    id,
    name: `${provider ?? 'selected'}/${id}`,
    reasoning: true,
  }),
}));

// This project's jsdom instance exposes no storage; the pill only reads the
// locked-effort key, so a null-returning stub is the whole dependency.
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
} as unknown as Storage);

function refs(): WcShellRefs {
  const make = (tag: string): HTMLElement => document.createElement(tag);
  return {
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
  isCone: true,
  type: 'cone',
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
  isCone: false,
  type: 'scoop',
  parentJid: cone.jid,
  // Copied at creation, kept after the cone moved on — the picker must not
  // pretend this is what it edits.
  model: { provider: 'adobe', id: 'claude-sonnet-4-6' },
  thinking: { level: 'high' },
};

describe('composer model pill per selected unit (#2310)', () => {
  it('shows the selected cone’s own model', async () => {
    const r = refs();
    await applyThreadContext(r, cone, [cone, scoop]);
    expect(r.composerMeta.getAttribute('model')).toBe('anthropic/claude-opus-4-6');
  });

  it('shows the owning cone’s model for a selected scoop, with the scoop’s own thinking', async () => {
    const r = refs();
    await applyThreadContext(r, scoop, [cone, scoop]);
    expect(r.composerMeta.getAttribute('model')).toBe('anthropic/claude-opus-4-6');
    expect(r.composerMeta.getAttribute('thinking')).toBe('high');
  });

  it('falls back to the selected unit when no roster is given', async () => {
    const r = refs();
    await applyThreadContext(r, scoop);
    expect(r.composerMeta.getAttribute('model')).toBe('adobe/claude-sonnet-4-6');
  });
});
