import { describe, expect, it } from 'vitest';
import { effectiveToolSurface, isNoOpAllowList } from '../../src/scoops/agent-tool-surface.js';

describe('effectiveToolSurface', () => {
  it('treats an omitted surface as the full set', () => {
    expect(effectiveToolSurface(undefined)).toBe('full');
    expect(effectiveToolSurface({ allowedCommands: ['true'] })).toBe('full');
  });

  it('keeps only StructuredOutput for a no-op allow-list plus a schema', () => {
    expect(
      effectiveToolSurface({
        toolSurface: 'auto',
        allowedCommands: ['true'],
        structuredOutputSchema: { type: 'object' },
      })
    ).toBe('output');
    expect(
      effectiveToolSurface({
        toolSurface: 'auto',
        allowedCommands: [' true ', 'false', ':'],
        structuredOutputSchema: { type: 'object' },
      })
    ).toBe('output');
  });

  it('drops every tool for a no-op allow-list without a schema', () => {
    expect(effectiveToolSurface({ toolSurface: 'auto', allowedCommands: ['true'] })).toBe('none');
  });

  it('does not treat an empty list or a wildcard as a no-op', () => {
    expect(isNoOpAllowList(undefined)).toBe(false);
    expect(isNoOpAllowList([])).toBe(false);
    expect(isNoOpAllowList(['*'])).toBe(false);
    expect(isNoOpAllowList(['true', 'ls'])).toBe(false);
    expect(
      effectiveToolSurface({
        toolSurface: 'auto',
        allowedCommands: ['*'],
        structuredOutputSchema: { type: 'object' },
      })
    ).toBe('full');
  });

  it('requires a schema for an explicit output surface', () => {
    expect(effectiveToolSurface({ toolSurface: 'output' })).toBe('none');
    expect(
      effectiveToolSurface({ toolSurface: 'output', structuredOutputSchema: { type: 'object' } })
    ).toBe('output');
    expect(effectiveToolSurface({ toolSurface: 'full', allowedCommands: ['true'] })).toBe('full');
  });
});
