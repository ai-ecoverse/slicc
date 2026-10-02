import { describe, expect, it } from 'vitest';
import {
  escapeCssAttr,
  escapeYaml,
  formatAriaStates,
  renderNode,
} from '../../../../src/shell/supplemental-commands/playwright/snapshot.js';

describe('playwright snapshot pure helpers', () => {
  it('escapes YAML special characters', () => {
    expect(escapeYaml('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('escapes CSS attribute values', () => {
    expect(escapeCssAttr('say "hi"\\')).toBe('say \\"hi\\"\\\\');
  });

  it('assigns refs and selectors for actionable nodes', () => {
    const refToSelector = new Map<string, string>();
    const refToBackendNodeId = new Map<string, number>();
    const lines = renderNode(
      {
        role: 'button',
        name: 'Save',
        backendNodeId: 42,
        children: [{ role: 'presentation', name: '', children: [] }],
      },
      refToSelector,
      refToBackendNodeId,
      { value: 0 }
    );

    expect(lines).toEqual(['- button "Save" [ref=e1]', '  - presentation']);
    expect(refToSelector.get('e1')).toContain('button[aria-label="Save"]');
    expect(refToBackendNodeId.get('e1')).toBe(42);
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
      {
        role: 'radio',
        name: 'Medium',
        description: 'checked',
        backendNodeId: 11,
        children: [],
      },
      new Map(),
      new Map(),
      { value: 0 }
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
        backendNodeId: 40,
        children: [],
      },
      new Map(),
      new Map(),
      { value: 0 }
    );
    expect(lines).toEqual(['- button "Show filters" [ref=e1] [expanded]: "open"']);
  });

  it('prints collapsed disclosures as [expanded=false]', () => {
    const lines = renderNode(
      {
        role: 'button',
        name: 'Show filters',
        description: 'collapsed',
        backendNodeId: 40,
        children: [],
      },
      new Map(),
      new Map(),
      { value: 0 }
    );
    expect(lines).toEqual(['- button "Show filters" [ref=e1] [expanded=false]']);
  });

  it('omits state brackets when description has no accessibility states', () => {
    const lines = renderNode(
      {
        role: 'checkbox',
        name: 'Mushroom',
        backendNodeId: 23,
        children: [],
      },
      new Map(),
      new Map(),
      { value: 0 }
    );
    expect(lines).toEqual(['- checkbox "Mushroom" [ref=e1]']);
  });
});
