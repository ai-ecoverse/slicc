import { describe, expect, it } from 'vitest';
import {
  defaultChildPathsForMode,
  PRIMARY_WORKSPACE,
  SKILLS_LIBRARY_DIR,
  TMP_ROOT,
  tmpDirFor,
  toDescriptor,
  workspaceFor,
  workspaceHandleFor,
} from '../../src/work-unit/descriptor.js';
import { statusFromTab } from '../../src/work-unit/types.js';
import { childRecord, rootRecord, withLegacyRoleFields } from './fixtures.js';

describe('work-unit descriptor', () => {
  it('maps tab status onto the unit lifecycle', () => {
    expect(statusFromTab('initializing')).toBe('creating');
    expect(statusFromTab('ready')).toBe('ready');
    expect(statusFromTab('processing')).toBe('running');
    expect(statusFromTab('error')).toBe('failed');
    // no tab yet = still being created
    expect(statusFromTab(undefined)).toBe('creating');
  });

  it('computes the workspace coordinates the runtime uses today', () => {
    expect(workspaceFor(rootRecord())).toEqual({
      root: '/workspace',
      memoryPath: '/workspace/CLAUDE.md',
      scratch: '/tmp',
    });
    expect(workspaceFor(childRecord('cone_1', { folder: 'andy-scoop' }))).toEqual({
      root: '/scoops/andy-scoop/workspace',
      memoryPath: '/scoops/andy-scoop/CLAUDE.md',
      scratch: '/scoops/andy-scoop',
    });
  });

  // #2271: extra cones get a private root + memory file so two cones neither
  // list each other's files by default nor append to one `CLAUDE.md`.
  it('gives every non-primary cone its own workspace and memory file', () => {
    const extra = workspaceFor(rootRecord({ jid: 'cone_2', folder: 'cone-beta' }));
    expect(extra).toEqual({
      root: '/cones/cone-beta/workspace',
      memoryPath: '/cones/cone-beta/CLAUDE.md',
      // `/tmp` is the float-wide scratch space every unit already writes to.
      scratch: '/tmp',
    });
    const primary = workspaceFor(rootRecord());
    expect(extra.root.startsWith(primary.root)).toBe(false);
    expect(extra.memoryPath).not.toBe(primary.memoryPath);
    expect(extra.scratch).toBe(primary.scratch);
  });

  it('pins the primary cone (and the skills library) to the historical layout', () => {
    // Compatibility contract: existing profiles, mounts and deep links.
    expect(PRIMARY_WORKSPACE).toEqual(workspaceFor(rootRecord()));
    expect(PRIMARY_WORKSPACE.root).toBe('/workspace');
    // Skills are a shared library, NOT per-cone — `upskill` installs here and
    // every shell's discovery roots name it.
    expect(SKILLS_LIBRARY_DIR).toBe('/workspace/skills');
  });

  it('projects a root record', () => {
    const d = toDescriptor(rootRecord(), {
      jid: 'cone_1',
      contextId: 'c',
      status: 'processing',
      lastActivity: 'x',
    });
    expect(d).toMatchObject({
      id: 'cone_1',
      parentId: null,
      name: 'Cone',
      folder: 'cone',
      status: 'running',
      display: { role: 'primary', label: 'sliccy' },
      completion: { mode: 'interactive' },
    });
    expect(d.policy.filesystem).toEqual({ kind: 'full-workspace' });
    expect(d.policy.approvalAuthority).toBe('user');
    expect(d.workspaceHandle).toEqual({
      workspaceId: '/workspace',
      root: '/workspace',
      access: 'shared-live',
    });
    expect(d.onParentClose).toBe('cascade');
  });

  it('projects a child record and derives role from the edge, not a legacy role field', () => {
    const d = toDescriptor(
      withLegacyRoleFields(childRecord('cone_1'), { isCone: true, type: 'cone' })
    );
    expect(d.parentId).toBe('cone_1');
    expect(d.display.role).toBe('child');
    expect(d.status).toBe('creating');
    expect(d.policy.approvalAuthority).toEqual({ parentId: 'cone_1' });
    expect(d.completion).toEqual({ mode: 'notify-parent' });
    expect(d.workspaceHandle).toEqual({
      workspaceId: '/scoops/worker-scoop/workspace',
      root: '/scoops/worker-scoop/workspace',
      access: 'shared-readonly',
    });
    expect(d.onParentClose).toBe('cascade');
  });

  it('projects detach-on-close from the record onto the descriptor', () => {
    const d = toDescriptor(childRecord('cone_1', { onParentClose: 'detach' }));
    expect(d.onParentClose).toBe('detach');
    expect(d.parentId).toBe('cone_1');
  });

  it('is a pure projection: JSON round-trips and does not alias the record', () => {
    const record = childRecord('cone_1');
    const d = toDescriptor(record);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    if (d.policy.filesystem.kind === 'restricted') {
      expect(d.policy.filesystem.writablePaths).not.toBe(record.config?.writablePaths);
    }
  });
});

describe('tmpDirFor — per-unit scratch under the shared /tmp (#2267, #2568)', () => {
  const primary = rootRecord();
  const adobe = rootRecord({ jid: 'cone_2', folder: 'cone-adobe' });
  const review = childRecord('cone_2', { folder: 'review' });
  const roster = [primary, adobe, review];

  it('gives every cone its own subtree, primary included', () => {
    // No special case for the primary cone: nothing is aliased, so there is
    // no compatibility argument for leaving one unit on the bare root.
    expect(tmpDirFor(roster, primary)).toBe('/tmp/cone');
    expect(tmpDirFor(roster, adobe)).toBe('/tmp/cone-adobe');
  });

  it('nests a scoop inside the cone that owns it, not beside it', () => {
    // This is what lets a cone dispose of its children's scratch in one
    // subtree delete, and what keeps the documented
    // `agent … >> "$TMPDIR/out.txt"` handoff readable by the parent.
    expect(tmpDirFor(roster, review)).toBe('/tmp/cone-adobe/review');
    expect(tmpDirFor(roster, review).startsWith(`${tmpDirFor(roster, adobe)}/`)).toBe(true);
  });

  it('never hands the shared root itself to a unit', () => {
    // A dangling ownership edge must not resolve to `/tmp`: that would give
    // one scoop the whole shared tree as "its own" and make a New chat on it
    // wipe every cone's scratch.
    const orphan = childRecord('cone_gone', { folder: 'orphan' });
    for (const unit of [...roster, orphan, undefined]) {
      expect(tmpDirFor(roster, unit)).not.toBe(TMP_ROOT);
      expect(tmpDirFor(roster, unit).startsWith(`${TMP_ROOT}/`)).toBe(true);
    }
  });

  it('falls back to the oldest root when the ownership edge is dangling', () => {
    const orphan = childRecord('cone_gone', { folder: 'orphan' });
    expect(tmpDirFor(roster, orphan)).toBe('/tmp/cone/orphan');
    // With no roster at all it still lands somewhere addressable.
    expect(tmpDirFor([], orphan)).toBe('/tmp/cone/orphan');
  });

  it('keeps sibling cones disjoint, so one cone cannot prefix-match another', () => {
    // `cone` is a prefix of `cone-adobe` as a STRING; the trailing separator
    // is what stops a `startsWith` sweep of `/tmp/cone` from eating
    // `/tmp/cone-adobe`.
    expect(`${tmpDirFor(roster, adobe)}/`.startsWith(`${tmpDirFor(roster, primary)}/`)).toBe(false);
  });
});

describe('workspaceHandleFor / defaultChildPathsForMode (#2277)', () => {
  it('projects a root as shared-live over its own workspace id', () => {
    expect(workspaceHandleFor(rootRecord())).toEqual({
      workspaceId: '/workspace',
      root: '/workspace',
      access: 'shared-live',
    });
  });

  it('defaults a child without workspaceMode to shared-readonly', () => {
    expect(workspaceHandleFor(childRecord('cone_1')).access).toBe('shared-readonly');
  });

  it('projects an explicit private child', () => {
    const scoop = childRecord('cone_1', {
      folder: 'secret-scoop',
      config: {
        workspaceMode: 'private',
        visiblePaths: [],
        writablePaths: ['/scoops/secret-scoop/'],
      },
    });
    expect(workspaceHandleFor(scoop)).toEqual({
      workspaceId: '/scoops/secret-scoop/workspace',
      root: '/scoops/secret-scoop/workspace',
      access: 'private',
    });
  });

  it("shared-readonly path defaults match today's scoop_scoop injection", () => {
    expect(
      defaultChildPathsForMode('shared-readonly', 'andy-scoop', { root: '/workspace' })
    ).toEqual({
      visiblePaths: ['/workspace/'],
      writablePaths: ['/scoops/andy-scoop/', '/shared/'],
    });
  });

  it('private path defaults are own sandbox only — no parent workspace, no /shared/', () => {
    expect(defaultChildPathsForMode('private', 'andy-scoop', { root: '/workspace' })).toEqual({
      visiblePaths: [],
      writablePaths: ['/scoops/andy-scoop/'],
    });
  });

  it("shared-readonly from an extra cone uses that cone's workspace, not /workspace", () => {
    expect(
      defaultChildPathsForMode('shared-readonly', 'helper', { root: '/cones/cone-beta/workspace' })
    ).toEqual({
      visiblePaths: ['/cones/cone-beta/workspace/', '/workspace/skills/'],
      writablePaths: ['/scoops/helper/', '/shared/'],
    });
  });
});
