import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPanel,
  hasPanel,
  listPanels,
  listPanelsByOrigin,
  type PanelRegistration,
  type PanelRegistryChangeDetail,
  panelRegistryEvents,
  registerPanel,
  registerPanelElement,
  resetPanelRegistry,
  unregisterPanel,
} from '../../src/panel/panel-registry.js';
import { type PanelMeta, SliccPanel } from '../../src/panel/slicc-panel.js';

function reg(id: string, over: Partial<PanelRegistration> = {}): PanelRegistration {
  return {
    meta: { id, title: id },
    source: { kind: 'element', tag: `${id}-tag` },
    origin: 'builtin',
    ...over,
  };
}

// A module-level registry leaks across test files; a stale entry from an
// unrelated suite is a genuinely confusing failure.
afterEach(() => resetPanelRegistry());

describe('registerPanel', () => {
  it('stores a registration retrievable by id', () => {
    expect(registerPanel(reg('files'))).toBe(true);
    expect(hasPanel('files')).toBe(true);
    expect(getPanel('files')?.meta.title).toBe('files');
  });

  it('returns undefined / false for an unknown id rather than throwing', () => {
    expect(getPanel('nope')).toBeUndefined();
    expect(hasPanel('nope')).toBe(false);
  });

  it('REPLACES on a duplicate id and reports the clash via the return value', () => {
    // Replace-and-report is deliberate: every caller is a legitimate
    // re-registration path (HMR, sprinkle discovery resync, the agent rewriting
    // a panel it just authored). Throwing would break boot on a duplicate;
    // ignoring would leave a stale implementation live after an edit.
    expect(registerPanel(reg('term', { meta: { id: 'term', title: 'Old' } }))).toBe(true);
    expect(registerPanel(reg('term', { meta: { id: 'term', title: 'New' } }))).toBe(false);
    expect(getPanel('term')?.meta.title).toBe('New');
    expect(listPanels()).toHaveLength(1);
  });
});

describe('registerPanelElement', () => {
  it('takes id and metadata from the class static, so identity lives in one place', () => {
    class FilesPanel extends SliccPanel {
      static readonly panelMeta: PanelMeta = { id: 'files', title: 'Files', icon: 'folder' };
    }
    expect(registerPanelElement('slicc-files-panel', FilesPanel)).toBe(true);

    const entry = getPanel('files');
    expect(entry?.meta.icon).toBe('folder');
    expect(entry?.source).toEqual({ kind: 'element', tag: 'slicc-files-panel' });
    expect(entry?.origin).toBe('builtin');
  });

  it('refuses a class with no usable panelMeta instead of registering a broken entry', () => {
    class NoMeta extends SliccPanel {}
    expect(registerPanelElement('slicc-no-meta', NoMeta)).toBe(false);
    expect(listPanels()).toHaveLength(0);
  });

  it('carries a non-builtin origin through', () => {
    class AgentPanel extends SliccPanel {
      static readonly panelMeta: PanelMeta = { id: 'kpi', title: 'KPIs' };
    }
    registerPanelElement('slicc-kpi-panel', AgentPanel, 'agent');
    expect(getPanel('kpi')?.origin).toBe('agent');
  });
});

describe('sandboxed sources', () => {
  it('registers a sprinkle-backed panel by VFS entry', () => {
    registerPanel({
      meta: { id: 'sprinkle:weather', title: 'weather', realm: 'sandboxed' },
      source: { kind: 'sandboxed', entry: '/shared/sprinkles/weather.shtml' },
      origin: 'sprinkle',
    });
    const entry = getPanel('sprinkle:weather');
    expect(entry?.source).toEqual({
      kind: 'sandboxed',
      entry: '/shared/sprinkles/weather.shtml',
    });
  });
});

describe('unregisterPanel', () => {
  it('removes an entry and reports whether it did', () => {
    registerPanel(reg('memory'));
    expect(unregisterPanel('memory')).toBe(true);
    expect(hasPanel('memory')).toBe(false);
    expect(unregisterPanel('memory')).toBe(false);
  });
});

describe('listing', () => {
  it('preserves insertion order', () => {
    registerPanel(reg('a'));
    registerPanel(reg('b'));
    registerPanel(reg('c'));
    expect(listPanels().map((p) => p.meta.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns a copy so a caller cannot mutate registry state', () => {
    registerPanel(reg('a'));
    const first = listPanels();
    first.push(reg('injected'));
    expect(listPanels()).toHaveLength(1);
  });

  it('is safe to register while iterating a previous snapshot', () => {
    registerPanel(reg('a'));
    for (const _entry of listPanels()) registerPanel(reg('b'));
    expect(listPanels()).toHaveLength(2);
  });

  it('groups by origin for the add-panel menu', () => {
    registerPanel(reg('chat'));
    registerPanel(reg('sprinkle:kpi', { origin: 'sprinkle' }));
    registerPanel(reg('sprinkle:weather', { origin: 'sprinkle' }));
    registerPanel(reg('custom', { origin: 'agent' }));

    expect(listPanelsByOrigin('builtin').map((p) => p.meta.id)).toEqual(['chat']);
    expect(listPanelsByOrigin('sprinkle')).toHaveLength(2);
    expect(listPanelsByOrigin('agent').map((p) => p.meta.id)).toEqual(['custom']);
  });
});

describe('change events', () => {
  it('emits on register — so a live add-panel menu re-renders when discovery lands late', () => {
    // Sprinkle discovery is VFS-backed and kernel-gated, so the rail is
    // routinely populated after first paint.
    const seen: PanelRegistryChangeDetail[] = [];
    const onChange = (e: Event) => seen.push((e as CustomEvent<PanelRegistryChangeDetail>).detail);
    panelRegistryEvents.addEventListener('panel-registry-change', onChange);

    registerPanel(reg('files'));
    unregisterPanel('files');

    panelRegistryEvents.removeEventListener('panel-registry-change', onChange);
    expect(seen).toEqual([
      { id: 'files', change: 'registered' },
      { id: 'files', change: 'unregistered' },
    ]);
  });

  it('does not emit unregistered for an id that was not present', () => {
    const onChange = vi.fn();
    panelRegistryEvents.addEventListener('panel-registry-change', onChange);
    unregisterPanel('ghost');
    panelRegistryEvents.removeEventListener('panel-registry-change', onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits a registered event even when the id replaced an existing one', () => {
    registerPanel(reg('term'));
    const onChange = vi.fn();
    panelRegistryEvents.addEventListener('panel-registry-change', onChange);
    registerPanel(reg('term'));
    panelRegistryEvents.removeEventListener('panel-registry-change', onChange);
    // The menu still needs to re-read: metadata (title/icon) may have changed.
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('resetPanelRegistry', () => {
  it('clears every entry and notifies for each', () => {
    registerPanel(reg('a'));
    registerPanel(reg('b'));
    const seen: string[] = [];
    const onChange = (e: Event) =>
      seen.push((e as CustomEvent<PanelRegistryChangeDetail>).detail.id);
    panelRegistryEvents.addEventListener('panel-registry-change', onChange);

    resetPanelRegistry();

    panelRegistryEvents.removeEventListener('panel-registry-change', onChange);
    expect(listPanels()).toHaveLength(0);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
