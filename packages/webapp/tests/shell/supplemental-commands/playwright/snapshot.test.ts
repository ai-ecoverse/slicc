import { describe, expect, it, vi } from 'vitest';
import {
  escapeYaml,
  formatAriaStates,
  framePrefixFor,
  recordRefSeq,
  renderNode,
  requireSnapshotRef,
  requireTabSnapshot,
  requireTopFrameRef,
  resolveSnapshotRef,
  tabRefState,
} from '../../../../src/shell/supplemental-commands/playwright/snapshot.js';
import type {
  SnapshotRef,
  TabHandle,
  TabSnapshot,
} from '../../../../src/shell/supplemental-commands/playwright/types.js';
import { createPlaywrightState } from '../../helpers/playwright-harness.js';

function snapshotWith(refs: Array<[string, SnapshotRef]>): TabSnapshot {
  return { url: 'https://x', title: 't', content: '', timestamp: 0, refs: new Map(refs) };
}

describe('playwright snapshot pure helpers', () => {
  it('escapes YAML special characters', () => {
    expect(escapeYaml('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('prints the ref the page minted and records it', () => {
    const refs = new Map<string, SnapshotRef>();
    const lines = renderNode(
      {
        role: 'button',
        name: 'Save',
        ref: 'e42',
        children: [{ role: 'presentation', name: '', children: [] }],
      },
      refs
    );

    expect(lines).toEqual(['- button "Save" [ref=e42]', '  - presentation']);
    expect(refs.get('e42')).toEqual({ role: 'button', name: 'Save', localRef: 'e42' });
  });

  it('prints no ref for nodes the page did not mint one for', () => {
    const refs = new Map<string, SnapshotRef>();
    const lines = renderNode({ role: 'button', name: 'Unminted', children: [] }, refs);
    expect(lines).toEqual(['- button "Unminted"']);
    expect(refs.size).toBe(0);
  });

  // Text runs carry no element of their own: a ref on one could only ever be
  // resolved by guessing (the bahn.de label that ate e30).
  it('never prints a ref on a text run', () => {
    const refs = new Map<string, SnapshotRef>();
    const lines = renderNode({ role: 'text', name: 'Nachname', ref: 'e30' }, refs);
    expect(lines).toEqual(['- text "Nachname"']);
    expect(refs.size).toBe(0);
  });

  it('prefixes child-frame refs and records the frame they live in', () => {
    const refs = new Map<string, SnapshotRef>();
    const lines = renderNode({ role: 'link', name: 'Pay', ref: 'e3' }, refs, '  ', 'f2', 'frame-9');
    expect(lines).toEqual(['  - link "Pay" [ref=f2e3]']);
    expect(refs.get('f2e3')).toEqual({
      role: 'link',
      name: 'Pay',
      localRef: 'e3',
      frameId: 'frame-9',
    });
  });

  it('formatAriaStates maps description tokens to Playwright aria attrs', () => {
    expect(formatAriaStates(undefined)).toBe('');
    expect(formatAriaStates('')).toBe('');
    expect(formatAriaStates('checked')).toBe(' [checked]');
    expect(formatAriaStates('checked=mixed')).toBe(' [checked=mixed]');
    expect(formatAriaStates('collapsed')).toBe(' [expanded=false]');
    expect(formatAriaStates('expanded')).toBe(' [expanded]');
    expect(formatAriaStates('checked, disabled, collapsed, level=2, pressed, selected')).toBe(
      ' [checked] [disabled] [expanded=false] [level=2] [pressed] [selected]'
    );
  });

  it('prints accessibility states after the ref so agents can see toggles', () => {
    const lines = renderNode(
      { role: 'radio', name: 'Medium', description: 'checked', ref: 'e1', children: [] },
      new Map()
    );
    expect(lines).toEqual(['- radio "Medium" [ref=e1] [checked]']);
  });

  it('places states after ref and before value (parser-safe order)', () => {
    const lines = renderNode(
      {
        role: 'button',
        name: 'Show filters',
        description: 'expanded',
        value: 'open',
        ref: 'e1',
        children: [],
      },
      new Map()
    );
    expect(lines).toEqual(['- button "Show filters" [ref=e1] [expanded]: "open"']);
  });

  it('prints collapsed disclosures as [expanded=false]', () => {
    const lines = renderNode(
      { role: 'button', name: 'Show filters', description: 'collapsed', ref: 'e1', children: [] },
      new Map()
    );
    expect(lines).toEqual(['- button "Show filters" [ref=e1] [expanded=false]']);
  });

  it('omits state brackets when description has no accessibility states', () => {
    const lines = renderNode(
      { role: 'checkbox', name: 'Mushroom', ref: 'e1', children: [] },
      new Map()
    );
    expect(lines).toEqual(['- checkbox "Mushroom" [ref=e1]']);
  });
});

describe('per-tab ref bookkeeping', () => {
  it('creates one ref state per tab and keeps it', () => {
    const state = createPlaywrightState();
    const a = tabRefState(state, 'tab-a');
    a.floor = 7;
    expect(tabRefState(state, 'tab-a')).toBe(a);
    expect(tabRefState(state, 'tab-b').floor).toBe(0);
  });

  it('assigns frame prefixes on first sight and never reuses one', () => {
    const refState = { floor: 0, framePrefixes: new Map<string, string>() };
    expect(framePrefixFor(refState, 'frame-a')).toBe('f1');
    expect(framePrefixFor(refState, 'frame-b')).toBe('f2');
    // A frame that appears earlier in a later snapshot keeps its prefix.
    expect(framePrefixFor(refState, 'frame-b')).toBe('f2');
    expect(framePrefixFor(refState, 'frame-a')).toBe('f1');
  });

  it('only ever raises the floor', () => {
    const refState = { floor: 10, framePrefixes: new Map<string, string>() };
    recordRefSeq(refState, { role: 'RootWebArea', name: '', refSeq: 4 });
    expect(refState.floor).toBe(10);
    recordRefSeq(refState, { role: 'RootWebArea', name: '', refSeq: 12 });
    expect(refState.floor).toBe(12);
    recordRefSeq(refState, { role: 'RootWebArea', name: '' });
    expect(refState.floor).toBe(12);
  });
});

describe('ref resolution', () => {
  const button: SnapshotRef = { role: 'button', name: 'Suchen', localRef: 'e33' };

  it('requires a snapshot for the tab', () => {
    expect(() => requireTabSnapshot(createPlaywrightState(), 'tab-1')).toThrow(
      'No snapshot available'
    );
  });

  it('rejects a ref the latest snapshot does not contain instead of guessing', () => {
    expect(() => requireSnapshotRef(snapshotWith([['e33', button]]), 'e30')).toThrow(
      /Unknown ref "e30": not in this tab's latest snapshot/
    );
  });

  it('resolves through the page with the local ref and frame', async () => {
    const resolveAriaRef = vi.fn(async () => ({ objectId: 'obj-7', backendNodeId: 70 }));
    const page = { resolveAriaRef } as unknown as TabHandle;
    const inFrame: SnapshotRef = { role: 'link', name: 'Pay', localRef: 'e3', frameId: 'fr' };
    const resolved = await resolveSnapshotRef(page, snapshotWith([['f1e3', inFrame]]), 'f1e3');
    expect(resolveAriaRef).toHaveBeenCalledWith('e3', 'fr');
    expect(resolved).toEqual({ objectId: 'obj-7', backendNodeId: 70, entry: inFrame });
  });

  it('names the element when its ref went stale', async () => {
    const stale = Object.assign(new Error('Ref "e33" is no longer on the page'), {
      name: 'StaleAriaRefError',
    });
    const page = {
      resolveAriaRef: vi.fn(async () => {
        throw stale;
      }),
    } as unknown as TabHandle;
    await expect(resolveSnapshotRef(page, snapshotWith([['e33', button]]), 'e33')).rejects.toThrow(
      'Ref "e33" (button "Suchen") is no longer on the page. Run "snapshot" for current refs.'
    );
  });

  it('passes other resolution failures through unchanged', async () => {
    const page = {
      resolveAriaRef: vi.fn(async () => {
        throw new Error('CDP session closed');
      }),
    } as unknown as TabHandle;
    await expect(resolveSnapshotRef(page, snapshotWith([['e33', button]]), 'e33')).rejects.toThrow(
      'CDP session closed'
    );
  });

  it('rejects child-frame refs for top-frame-only commands', () => {
    expect(() => requireTopFrameRef(button, 'e33', 'drag')).not.toThrow();
    expect(() => requireTopFrameRef({ ...button, frameId: 'fr' }, 'f1e33', 'drag')).toThrow(
      'drag does not support iframe refs ("f1e33")'
    );
  });
});
