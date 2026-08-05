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

  it('ships exactly ONE preset — arrangements are the user’s to save', () => {
    // `focus` is both the default and the whole shipped set. Canned arrangements
    // beyond the boot shape are saved layouts, not app-guessed presets.
    expect(Object.keys(LAYOUT_PRESETS)).toEqual(['focus']);
  });

  it('getPreset returns null for anything else, including the removed presets', () => {
    expect(getPreset('nope')).toBeNull();
    for (const gone of ['split', 'dashboard', 'dev', 'stage', 'demo', 'editor']) {
      expect(getPreset(gone)).toBeNull();
    }
  });

  it('every preset name is reachable via getPreset', () => {
    for (const name of Object.keys(LAYOUT_PRESETS)) {
      expect(getPreset(name)?.name).toBe(name);
    }
  });
});
