import { describe, expect, it } from 'vitest';
import type { RegisteredScoop } from '../../../src/scoops/types.js';
import {
  defaultRootOf,
  orderForSwitcher,
  switcherLabelFor,
  threadContextFor,
  unitForContext,
  unitSlugFor,
} from '../../../src/ui/wc/wc-unit-context.js';
import { DEFAULT_ROOT_STORAGE_KEY } from '../../../src/work-unit/default-root.js';
import { installFakeLocalStorage } from '../../helpers/fake-local-storage.js';

function unit(over: Partial<RegisteredScoop>): RegisteredScoop {
  return {
    jid: over.jid ?? 'jid',
    name: 'Name',
    folder: 'folder',
    isCone: over.parentJid === null,
    type: over.parentJid === null ? 'cone' : 'scoop',
    requiresTrigger: false,
    assistantLabel: 'label',
    addedAt: '2026-01-01T00:00:00.000Z',
    parentJid: 'cone_1',
    ...over,
  };
}

const primary = unit({
  jid: 'cone_1',
  parentJid: null,
  folder: 'cone',
  name: 'Cone',
  assistantLabel: 'sliccy',
});
const research = unit({
  jid: 'cone_2',
  parentJid: null,
  folder: 'cone-research',
  name: 'Research',
  assistantLabel: 'Research',
  addedAt: '2026-01-02T00:00:00.000Z',
});
const worker = unit({
  jid: 'scoop_1',
  folder: 'worker-scoop',
  name: 'worker',
  assistantLabel: 'worker',
});
const helper = unit({
  jid: 'scoop_2',
  parentJid: 'cone_2',
  folder: 'helper-scoop',
  name: 'helper',
  assistantLabel: 'helper',
});

describe('wc-unit-context', () => {
  it('labels roots by assistant label and children by name', () => {
    expect(switcherLabelFor(primary)).toBe('sliccy');
    expect(switcherLabelFor(research)).toBe('Research');
    expect(switcherLabelFor(worker)).toBe('worker');
  });

  it('keeps the primary cone on the historical context and slug', () => {
    expect(threadContextFor(primary)).toBe('cone');
    expect(unitSlugFor(primary)).toBe('cone');
    expect(threadContextFor(research)).toBe('cone:cone-research');
    expect(unitSlugFor(research)).toBe('cone-research');
    expect(threadContextFor(worker)).toBe('scoop:worker');
    expect(unitSlugFor(worker)).toBe('worker');
  });

  it('resolves every context shape back to its unit', () => {
    const all = [worker, research, primary, helper];
    expect(unitForContext(all, 'cone')?.jid).toBe('cone_1');
    expect(unitForContext(all, 'cone:cone-research')?.jid).toBe('cone_2');
    expect(unitForContext(all, 'cone:nope')).toBeUndefined();
    expect(unitForContext(all, 'scoop:helper')?.jid).toBe('scoop_2');
    expect(unitForContext(all, 'scoop:cone')).toBeUndefined();
    // an unknown plain context falls back to the default root
    expect(unitForContext(all, 'whatever')?.jid).toBe('cone_1');
  });

  it('round-trips the bare `cone` context even when another root is starred', () => {
    // `threadContextFor(primary)` serializes to `cone`; if that resolved
    // through the event default, sharing or reloading the primary cone's own
    // URL would open the starred cone instead (#2273).
    const storage = installFakeLocalStorage({ [DEFAULT_ROOT_STORAGE_KEY]: research.jid });
    try {
      const all = [worker, research, primary, helper];
      expect(unitForContext(all, 'cone')?.jid).toBe(primary.jid);
      expect(unitForContext(all, 'cone:cone-research')?.jid).toBe(research.jid);
      // only an unrecognised context defers to the configured default
      expect(unitForContext(all, 'whatever')?.jid).toBe(research.jid);
      expect(defaultRootOf(all)?.jid).toBe(research.jid);
    } finally {
      storage.restore();
    }
  });

  it('prefers the primary root, else the oldest root, as default', () => {
    expect(defaultRootOf([worker, research, primary])?.jid).toBe('cone_1');
    expect(defaultRootOf([worker, research])?.jid).toBe('cone_2');
    expect(defaultRootOf([worker])).toBeUndefined();
  });

  it('orders roots (oldest first) ahead of children in registry order', () => {
    expect(orderForSwitcher([helper, research, worker, primary]).map((s) => s.jid)).toEqual([
      'cone_1',
      'cone_2',
      'scoop_2',
      'scoop_1',
    ]);
  });
});
