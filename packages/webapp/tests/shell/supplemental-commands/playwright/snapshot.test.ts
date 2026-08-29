import { describe, expect, it } from 'vitest';
import {
  escapeCssAttr,
  escapeYaml,
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
});
