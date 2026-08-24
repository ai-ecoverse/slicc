import { describe, expect, it } from 'vitest';
import {
  PRIMARY_WORKSPACE,
  SKILLS_LIBRARY_DIR,
  toDescriptor,
  workspaceFor,
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
