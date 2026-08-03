import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, getPreset, LAYOUT_PRESETS } from '../../../src/ui/wc/layout-spec.js';

function surfaceIds(spec: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; surfaceId?: string; children?: unknown[] };
    if (n.type === 'leaf' && n.surfaceId) ids.push(n.surfaceId);
    else if (n.type === 'split') for (const c of n.children ?? []) walk(c);
  };
  const tree = (spec as { zones: Record<string, unknown> }).zones;
  for (const zone of Object.values(tree)) walk(zone);
  return ids;
}

describe('layout-spec', () => {
  it('default is focus and matches today: chat alone, left, single column', () => {
    expect(DEFAULT_LAYOUT).toBe('focus');
    const focus = LAYOUT_PRESETS.focus;
    expect(surfaceIds(focus.tree)).toEqual(['chat']);
    expect(focus.tree.zones.left).toEqual({ type: 'leaf', surfaceId: 'chat' });
  });

  it('dashboard has a populated middle zone alongside chat', () => {
    const d = LAYOUT_PRESETS.dashboard;
    expect(surfaceIds(d.tree)).toContain('chat');
    expect(d.tree.zones.left).toEqual({ type: 'leaf', surfaceId: 'chat' });
    expect(d.tree.colFr.middle).toBeGreaterThan(d.tree.colFr.left);
  });

  it('getPreset returns null for unknown names', () => {
    expect(getPreset('nope')).toBeNull();
    expect(getPreset('stage')?.name).toBe('stage');
  });

  it('stage places chat on the right', () => {
    expect(LAYOUT_PRESETS.stage.tree.zones.right).toEqual({ type: 'leaf', surfaceId: 'chat' });
    expect(LAYOUT_PRESETS.stage.tree.zones.left).toBeNull();
  });

  it('demo and editor are no longer valid preset names (both removed modes)', () => {
    expect(getPreset('demo')).toBeNull();
    expect(getPreset('editor')).toBeNull();
  });

  it('every preset name is reachable via getPreset', () => {
    for (const name of Object.keys(LAYOUT_PRESETS)) {
      expect(getPreset(name)?.name).toBe(name);
    }
  });
});
