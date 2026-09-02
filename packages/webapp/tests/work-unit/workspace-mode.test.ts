import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHILD_WORKSPACE_MODE,
  includeMountsForMode,
  parseWorkspaceMode,
  resolveWorkspaceMode,
  unimplementedWorkspaceModeError,
  workspaceModeRank,
} from '../../src/work-unit/workspace-mode.js';

describe('workspace isolation mode (#2277)', () => {
  it("defaults omitted / empty to shared-readonly so today's scoops keep their sandbox", () => {
    expect(parseWorkspaceMode(undefined)).toEqual({ ok: true, mode: 'shared-readonly' });
    expect(parseWorkspaceMode('')).toEqual({ ok: true, mode: 'shared-readonly' });
    expect(DEFAULT_CHILD_WORKSPACE_MODE).toBe('shared-readonly');
  });

  it('accepts the implemented modes', () => {
    expect(parseWorkspaceMode('private')).toEqual({ ok: true, mode: 'private' });
    expect(parseWorkspaceMode('shared-readonly')).toEqual({
      ok: true,
      mode: 'shared-readonly',
    });
  });

  it('rejects snapshot and shared-live with the RFC-Q4 deferral', () => {
    const snap = parseWorkspaceMode('snapshot');
    expect(snap.ok).toBe(false);
    if (!snap.ok) {
      expect(snap.error).toContain('not implemented');
      expect(snap.error).toContain('RFC open question 4');
    }
    expect(parseWorkspaceMode('shared-live').ok).toBe(false);
    expect(() => resolveWorkspaceMode('snapshot')).toThrow(/Copy-on-write snapshots are deferred/);
    expect(unimplementedWorkspaceModeError('snapshot').message).toContain('private');
  });

  it('rejects unknown names rather than silently defaulting', () => {
    const parsed = parseWorkspaceMode('cow');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Unknown workspace isolation mode');
  });

  it('private is the only mode that turns off silent mount inclusion', () => {
    expect(includeMountsForMode('private')).toBe(false);
    expect(includeMountsForMode('shared-readonly')).toBe(true);
    expect(includeMountsForMode('snapshot')).toBe(true);
    expect(includeMountsForMode('shared-live')).toBe(true);
  });

  it('ranks sharing so a child cannot pick a more sharing mode than its parent', () => {
    expect(workspaceModeRank('private')).toBeLessThan(workspaceModeRank('shared-readonly'));
    expect(workspaceModeRank('shared-readonly')).toBeLessThan(workspaceModeRank('snapshot'));
    expect(workspaceModeRank('snapshot')).toBeLessThan(workspaceModeRank('shared-live'));
  });
});
