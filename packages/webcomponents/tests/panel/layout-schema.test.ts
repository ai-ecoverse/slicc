import { describe, expect, it } from 'vitest';
import {
  type CenterNode,
  emptyLayout,
  isPanelLocked,
  isSplitNode,
  LAYOUT_SCHEMA_VERSION,
  type LayoutDocument,
  layoutPanelIds,
  parseLayoutDocument,
  resolveLayout,
  sizeToFlex,
  variantMatches,
  walkCenter,
} from '../../src/panel/layout-schema.js';

const ENV = { width: 1280, height: 900 } as const;

function doc(over: Partial<LayoutDocument> = {}): LayoutDocument {
  return {
    version: LAYOUT_SCHEMA_VERSION,
    id: 'test',
    base: {
      docks: [{ edge: 'left', size: '44px', panels: ['sessions-rail'] }],
      center: { panel: 'chat' },
    },
    ...over,
  };
}

describe('emptyLayout', () => {
  it('is a valid, empty, current-version document', () => {
    const empty = emptyLayout();
    expect(empty.version).toBe(LAYOUT_SCHEMA_VERSION);
    expect(empty.base).toEqual({});
    expect(parseLayoutDocument(empty)).toBe(empty);
  });
});

describe('isSplitNode / walkCenter', () => {
  it('discriminates leaves from splits', () => {
    expect(isSplitNode({ panel: 'chat' })).toBe(false);
    expect(isSplitNode({ split: 'row', children: [] })).toBe(true);
  });

  it('visits every leaf depth-first, left to right', () => {
    const tree: CenterNode = {
      split: 'row',
      children: [
        { panel: 'a' },
        { split: 'col', children: [{ panel: 'b' }, { panel: 'c' }] },
        { panel: 'd' },
      ],
    };
    const seen: string[] = [];
    walkCenter(tree, (leaf) => seen.push(leaf.panel));
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('variantMatches', () => {
  it('matches on width bounds, inclusively', () => {
    expect(variantMatches({ maxWidth: 700 }, { width: 700, height: 500 })).toBe(true);
    expect(variantMatches({ maxWidth: 700 }, { width: 701, height: 500 })).toBe(false);
    expect(variantMatches({ minWidth: 700 }, { width: 700, height: 500 })).toBe(true);
    expect(variantMatches({ minWidth: 701 }, { width: 700, height: 500 })).toBe(false);
  });

  it('matches on height bounds', () => {
    expect(variantMatches({ maxHeight: 400 }, { width: 900, height: 400 })).toBe(true);
    expect(variantMatches({ minHeight: 500 }, { width: 900, height: 400 })).toBe(false);
  });

  it('ANDs every present predicate', () => {
    const when = { minWidth: 500, maxWidth: 900, minHeight: 300 };
    expect(variantMatches(when, { width: 700, height: 400 })).toBe(true);
    expect(variantMatches(when, { width: 700, height: 200 })).toBe(false);
    expect(variantMatches(when, { width: 1000, height: 400 })).toBe(false);
  });

  it('derives orientation from the box, treating square as landscape', () => {
    expect(variantMatches({ orientation: 'landscape' }, { width: 800, height: 600 })).toBe(true);
    expect(variantMatches({ orientation: 'portrait' }, { width: 600, height: 800 })).toBe(true);
    expect(variantMatches({ orientation: 'landscape' }, { width: 500, height: 500 })).toBe(true);
    expect(variantMatches({ orientation: 'portrait' }, { width: 800, height: 600 })).toBe(false);
  });

  it('matches a platform predicate against the environment', () => {
    expect(variantMatches({ platform: 'extension' }, { ...ENV, platform: 'extension' })).toBe(true);
    expect(variantMatches({ platform: 'extension' }, { ...ENV, platform: 'web' })).toBe(false);
  });

  it('does NOT drop a platform-keyed variant when the env platform is unknown', () => {
    // A caller that can't determine its float shouldn't silently lose every
    // platform variant — that would be a confusing partial layout.
    expect(variantMatches({ platform: 'electron' }, ENV)).toBe(true);
  });

  it('an empty condition always matches', () => {
    expect(variantMatches({}, ENV)).toBe(true);
  });
});

describe('resolveLayout', () => {
  it('returns the base arrangement when no variants match', () => {
    const resolved = resolveLayout(doc(), ENV);
    expect(resolved.docks).toHaveLength(1);
    expect(resolved.center).toEqual({ panel: 'chat' });
    expect(resolved.appliedVariants).toEqual([]);
  });

  it('deep-clones so mutating the result cannot corrupt the document', () => {
    const source = doc();
    const resolved = resolveLayout(source, ENV);
    resolved.docks[0].panels.push('injected');
    expect(source.base.docks?.[0].panels).toEqual(['sessions-rail']);
  });

  it('REPLACES a whole section rather than deep-merging it', () => {
    // Deliberate: deep-merging two recursive split trees has no intuitive
    // semantics (what is a 2-child row merged into a 3-child col?), whereas
    // "the narrow layout declares its own center" reads obviously.
    const resolved = resolveLayout(
      doc({
        variants: [{ when: { maxWidth: 700 }, center: { panel: 'chat-only' } }],
      }),
      { width: 500, height: 800 }
    );
    expect(resolved.center).toEqual({ panel: 'chat-only' });
    // The section it did NOT declare is untouched.
    expect(resolved.docks).toHaveLength(1);
  });

  it('leaves a section alone when the variant omits it', () => {
    const resolved = resolveLayout(
      doc({ variants: [{ when: {}, floating: [{ panel: 'monitor' }] }] }),
      ENV
    );
    expect(resolved.center).toEqual({ panel: 'chat' });
    expect(resolved.floating).toEqual([{ panel: 'monitor' }]);
  });

  it('distinguishes an explicit empty section from an omitted one', () => {
    // `docks: []` means "no docks here" (hide the rails); omitting it means
    // "keep whatever was there".
    const cleared = resolveLayout(doc({ variants: [{ when: {}, docks: [] }] }), ENV);
    expect(cleared.docks).toEqual([]);
    const kept = resolveLayout(doc({ variants: [{ when: {} }] }), ENV);
    expect(kept.docks).toHaveLength(1);
  });

  it('MERGES panel overrides per id, so unrelated keys survive', () => {
    const resolved = resolveLayout(
      doc({
        panels: { chat: { movable: false }, 'sessions-rail': { visible: true } },
        variants: [{ when: {}, panels: { chat: { visible: false } } }],
      }),
      ENV
    );
    // The variant added `visible` without dropping the base's `movable`.
    expect(resolved.panels.chat).toEqual({ movable: false, visible: false });
    expect(resolved.panels['sessions-rail']).toEqual({ visible: true });
  });

  it('applies matching variants in declaration order, last write winning', () => {
    const resolved = resolveLayout(
      doc({
        variants: [
          { when: { maxWidth: 2000 }, center: { panel: 'first' } },
          { when: { maxWidth: 2000 }, center: { panel: 'second' } },
        ],
      }),
      ENV
    );
    expect(resolved.center).toEqual({ panel: 'second' });
    expect(resolved.appliedVariants).toEqual([0, 1]);
  });

  it('reports which variants matched, for diagnostics', () => {
    const resolved = resolveLayout(
      doc({
        variants: [
          { when: { maxWidth: 100 }, center: { panel: 'tiny' } },
          { when: { minWidth: 1000 }, center: { panel: 'wide' } },
        ],
      }),
      ENV
    );
    expect(resolved.appliedVariants).toEqual([1]);
  });

  it('carries the tree-wide lock through', () => {
    expect(resolveLayout(doc({ locked: true }), ENV).locked).toBe(true);
    expect(resolveLayout(doc(), ENV).locked).toBe(false);
  });
});

describe('layoutPanelIds', () => {
  it('collects docks, then the center depth-first, then floating', () => {
    const resolved = resolveLayout(
      doc({
        base: {
          docks: [
            { edge: 'top', panels: ['switcher', 'floatbar'] },
            { edge: 'left', panels: ['sessions-rail'] },
          ],
          center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] },
          floating: [{ panel: 'monitor' }],
        },
      }),
      ENV
    );
    expect(layoutPanelIds(resolved)).toEqual([
      'switcher',
      'floatbar',
      'sessions-rail',
      'chat',
      'files',
      'monitor',
    ]);
  });

  it('drops duplicates — a panel can only be in one place', () => {
    const resolved = resolveLayout(
      doc({
        base: {
          docks: [{ edge: 'left', panels: ['chat'] }],
          center: { panel: 'chat' },
        },
      }),
      ENV
    );
    expect(layoutPanelIds(resolved)).toEqual(['chat']);
  });

  it('is empty for an empty layout', () => {
    expect(layoutPanelIds(resolveLayout(emptyLayout(), ENV))).toEqual([]);
  });
});

describe('isPanelLocked', () => {
  it('is true for every panel when the tree is locked', () => {
    const resolved = resolveLayout(doc({ locked: true }), ENV);
    expect(isPanelLocked(resolved, 'chat')).toBe(true);
    expect(isPanelLocked(resolved, 'sessions-rail')).toBe(true);
  });

  it('honors a per-panel override', () => {
    const resolved = resolveLayout(doc({ panels: { chat: { locked: true } } }), ENV);
    expect(isPanelLocked(resolved, 'chat')).toBe(true);
    expect(isPanelLocked(resolved, 'sessions-rail')).toBe(false);
  });

  it('inherits DOWN from a locked dock, not sideways', () => {
    const resolved = resolveLayout(
      doc({
        base: {
          docks: [
            { edge: 'left', panels: ['a', 'b'], locked: true },
            { edge: 'right', panels: ['c'] },
          ],
          center: null,
        },
      }),
      ENV
    );
    expect(isPanelLocked(resolved, 'a')).toBe(true);
    expect(isPanelLocked(resolved, 'b')).toBe(true);
    expect(isPanelLocked(resolved, 'c')).toBe(false);
  });

  it('inherits DOWN through nested splits without affecting siblings', () => {
    const resolved = resolveLayout(
      doc({
        base: {
          center: {
            split: 'row',
            children: [
              { split: 'col', children: [{ panel: 'deep-a' }, { panel: 'deep-b' }], locked: true },
              { panel: 'free' },
            ],
          },
        },
      }),
      ENV
    );
    expect(isPanelLocked(resolved, 'deep-a')).toBe(true);
    expect(isPanelLocked(resolved, 'deep-b')).toBe(true);
    expect(isPanelLocked(resolved, 'free')).toBe(false);
  });

  it('honors a locked floating panel', () => {
    const resolved = resolveLayout(
      doc({ base: { center: null, floating: [{ panel: 'monitor', locked: true }] } }),
      ENV
    );
    expect(isPanelLocked(resolved, 'monitor')).toBe(true);
  });

  it('is false for a panel the layout does not place', () => {
    expect(isPanelLocked(resolveLayout(doc(), ENV), 'nowhere')).toBe(false);
  });
});

describe('sizeToFlex', () => {
  it('treats a bare number as a grow factor with zero basis (proportional splits)', () => {
    // Zero basis is what makes ratios resize predictably — the dock-tree's
    // resize math depends on the same property.
    expect(sizeToFlex(3)).toBe('3 1 0');
    expect(sizeToFlex('2')).toBe('2 1 0');
  });

  it('treats an fr unit as a grow factor', () => {
    expect(sizeToFlex('3fr')).toBe('3 1 0');
    expect(sizeToFlex('1.5fr')).toBe('1.5 1 0');
  });

  it('treats a CSS length as a fixed basis that neither grows nor shrinks', () => {
    // This is what keeps a 44px rail exactly 44px — the case the old fr-only
    // model could not express at all.
    expect(sizeToFlex('44px')).toBe('0 0 44px');
    expect(sizeToFlex('30%')).toBe('0 0 30%');
    expect(sizeToFlex('4rem')).toBe('0 0 4rem');
  });

  it('grows to fill when unspecified', () => {
    expect(sizeToFlex(undefined)).toBe('1 1 auto');
  });

  it('tolerates surrounding whitespace', () => {
    expect(sizeToFlex('  44px ')).toBe('0 0 44px');
    expect(sizeToFlex(' 2fr ')).toBe('2 1 0');
  });
});

describe('parseLayoutDocument', () => {
  it('accepts a well-formed document, returning it typed', () => {
    const valid = doc();
    expect(parseLayoutDocument(valid)).toBe(valid);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 42, 'layout', true]) {
      expect(parseLayoutDocument(bad)).toEqual({ error: expect.stringContaining('object') });
    }
  });

  it('requires a non-empty string id', () => {
    expect(parseLayoutDocument({ version: 1, base: {} })).toEqual({
      error: expect.stringContaining('id'),
    });
    expect(parseLayoutDocument({ version: 1, id: '  ', base: {} })).toEqual({
      error: expect.stringContaining('id'),
    });
  });

  it('requires a numeric version and refuses one from the future', () => {
    // Refusing a newer version is the point of having one: an older build must
    // not half-render a document written against a schema it doesn't know.
    expect(parseLayoutDocument({ id: 'x', base: {} })).toEqual({
      error: expect.stringContaining('version'),
    });
    const future = parseLayoutDocument({ version: LAYOUT_SCHEMA_VERSION + 1, id: 'x', base: {} });
    expect(future).toEqual({ error: expect.stringContaining('newer than supported') });
  });

  it('requires a base object', () => {
    expect(parseLayoutDocument({ version: 1, id: 'x' })).toEqual({
      error: expect.stringContaining('base'),
    });
  });

  it('rejects a bad dock edge or non-array panels', () => {
    expect(
      parseLayoutDocument({
        version: 1,
        id: 'x',
        base: { docks: [{ edge: 'middle', panels: [] }] },
      })
    ).toEqual({ error: expect.stringContaining('dock edge') });
    expect(
      parseLayoutDocument({
        version: 1,
        id: 'x',
        base: { docks: [{ edge: 'top', panels: 'chat' }] },
      })
    ).toEqual({ error: expect.stringContaining('panels') });
  });

  it('rejects a malformed center node, however deeply nested', () => {
    expect(parseLayoutDocument({ version: 1, id: 'x', base: { center: { nope: true } } })).toEqual({
      error: expect.stringContaining('`panel` string or a `split`'),
    });
    expect(
      parseLayoutDocument({ version: 1, id: 'x', base: { center: { split: 'row', children: [] } } })
    ).toEqual({ error: expect.stringContaining('non-empty `children`') });
    expect(
      parseLayoutDocument({
        version: 1,
        id: 'x',
        base: {
          center: {
            split: 'row',
            children: [{ panel: 'ok' }, { split: 'col', children: [{ bad: 1 }] }],
          },
        },
      })
    ).toEqual({ error: expect.stringContaining('`panel` string or a `split`') });
  });

  it('does NOT reject unknown panel ids or odd sizes — those degrade at render', () => {
    // A skill-shipped layout that is 90% loadable should load; failing the whole
    // document over one typo in one panel is worse than an empty slot.
    const loose = {
      version: 1,
      id: 'loose',
      base: { center: { panel: 'panel-that-does-not-exist', size: 'wat' } },
      panels: { whatever: { visible: true } },
    };
    expect(parseLayoutDocument(loose)).toBe(loose);
  });
});
