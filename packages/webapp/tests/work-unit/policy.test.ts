import { describe, expect, it } from 'vitest';
import {
  assertChildPolicyAllowed,
  capableApproverOf,
  childrenOf,
  delegatedChildPolicy,
  deriveCompletion,
  derivePolicy,
  interactiveRootPolicy,
  isPolicySubset,
  isRootUnit,
  rootsOf,
  subtreeOf,
} from '../../src/work-unit/policy.js';
import { childRecord, rootRecord, withLegacyRoleFields } from './fixtures.js';

describe('work-unit policy', () => {
  it('a root is defined by parentJid === null and nothing else', () => {
    expect(isRootUnit(rootRecord())).toBe(true);
    expect(isRootUnit(childRecord('cone_1'))).toBe(false);
    // A legacy record may still carry the deleted role fields; the edge decides.
    expect(isRootUnit(withLegacyRoleFields(rootRecord(), { isCone: false, type: 'scoop' }))).toBe(
      true
    );
    expect(
      isRootUnit(withLegacyRoleFields(childRecord('cone_1'), { isCone: true, type: 'cone' }))
    ).toBe(false);
  });

  it('derives the interactive root preset for a root', () => {
    expect(derivePolicy(rootRecord())).toEqual(interactiveRootPolicy());
    expect(deriveCompletion(rootRecord())).toEqual({ mode: 'interactive' });
  });

  it('derives a delegated child policy that copies the config paths verbatim', () => {
    const child = childRecord('cone_1', {
      config: { visiblePaths: ['/workspace/'], writablePaths: ['/scoops/worker-scoop/'] },
    });
    const policy = derivePolicy(child);
    expect(policy).toEqual(
      delegatedChildPolicy('cone_1', {
        visiblePaths: ['/workspace/'],
        writablePaths: ['/scoops/worker-scoop/'],
      })
    );
    expect(policy.filesystem).toEqual({
      kind: 'restricted',
      visiblePaths: ['/workspace/'],
      writablePaths: ['/scoops/worker-scoop/'],
    });
    expect(policy.approvalAuthority).toEqual({ parentId: 'cone_1' });
    expect(policy.canCreateChildren).toBe(false);
    expect(policy.canManageChildren).toBe(false);
    expect(policy.sudoDefaultDisposition).toBe('require-approval');
    expect(policy.persistCommandGrants).toBe(false);
  });

  it('grants nested delegation only when config.canCreateChildren is true', () => {
    const granted = childRecord('cone_1', { config: { canCreateChildren: true } });
    const policy = derivePolicy(granted);
    expect(policy.canCreateChildren).toBe(true);
    expect(policy.canManageChildren).toBe(true);
    // The grant is the supervisor pair only — nothing else widens.
    expect(policy.canWriteSharedMemory).toBe(false);
    expect(policy.canResolveApprovals).toBe(false);
    expect(policy.persistCommandGrants).toBe(false);
    expect(policy.sudoDefaultDisposition).toBe('require-approval');
    expect(policy.filesystem.kind).toBe('restricted');
    expect(isPolicySubset(policy, interactiveRootPolicy())).toBe(true);

    const ungranted = derivePolicy(childRecord('cone_1'));
    expect(ungranted.canCreateChildren).toBe(false);
    expect(ungranted.canManageChildren).toBe(false);
  });

  it('keeps explicit empty path lists empty (no defaults live here)', () => {
    const child = childRecord('cone_1', { config: { visiblePaths: [], writablePaths: [] } });
    expect(derivePolicy(child).filesystem).toEqual({
      kind: 'restricted',
      visiblePaths: [],
      writablePaths: [],
    });
    const noConfig = childRecord('cone_1', { config: undefined });
    expect(derivePolicy(noConfig).filesystem).toEqual({
      kind: 'restricted',
      visiblePaths: [],
      writablePaths: [],
    });
  });

  it('derives completion from the parent edge and notifyOnComplete', () => {
    expect(deriveCompletion(childRecord('cone_1'))).toEqual({ mode: 'notify-parent' });
    expect(deriveCompletion(childRecord('cone_1', { notifyOnComplete: true }))).toEqual({
      mode: 'notify-parent',
    });
    expect(deriveCompletion(childRecord('cone_1', { notifyOnComplete: false }))).toEqual({
      mode: 'silent',
    });
  });

  describe('child ⊆ parent invariant', () => {
    const root = interactiveRootPolicy();
    const child = delegatedChildPolicy('cone_1');

    it('holds for the shipped presets', () => {
      expect(isPolicySubset(child, root)).toBe(true);
      expect(isPolicySubset(root, root)).toBe(true);
      expect(isPolicySubset(child, child)).toBe(true);
    });

    it('rejects a child holding a flag its parent lacks', () => {
      expect(isPolicySubset({ ...child, canCreateChildren: true }, child)).toBe(false);
      expect(isPolicySubset({ ...child, canResolveApprovals: true }, child)).toBe(false);
      expect(isPolicySubset({ ...child, persistCommandGrants: true }, child)).toBe(false);
    });

    it('a granted child is still ⊆ a root, and a default grandchild ⊆ the granted child', () => {
      const granted = delegatedChildPolicy('cone_1', { canCreateChildren: true });
      expect(isPolicySubset(granted, root)).toBe(true);
      expect(isPolicySubset(child, granted)).toBe(true);
      expect(isPolicySubset(granted, child)).toBe(false);
    });

    it('rejects sudo auto-allow and full-workspace under a restricted parent', () => {
      expect(isPolicySubset({ ...child, sudoDefaultDisposition: 'allow' }, child)).toBe(false);
      expect(isPolicySubset({ ...child, filesystem: { kind: 'full-workspace' } }, child)).toBe(
        false
      );
      expect(isPolicySubset(root, child)).toBe(false);
    });

    it('rejects a grandchild whose writable/visible paths escape the supervisor sandbox', () => {
      const supervisor = delegatedChildPolicy('cone_1', {
        canCreateChildren: true,
        writablePaths: ['/scoops/lead/'],
        visiblePaths: ['/scoops/lead/'],
      });
      const escape = delegatedChildPolicy('scoop_lead', {
        writablePaths: ['/workspace/'],
        visiblePaths: ['/workspace/'],
      });
      expect(isPolicySubset(escape, supervisor)).toBe(false);

      const nested = delegatedChildPolicy('scoop_lead', {
        writablePaths: ['/scoops/lead/deep/'],
        visiblePaths: ['/scoops/lead/notes/'],
      });
      expect(isPolicySubset(nested, supervisor)).toBe(true);

      // Visible may sit under a parent writable path (writable ⇒ readable).
      const visibleUnderWritable = delegatedChildPolicy('scoop_lead', {
        writablePaths: [],
        visiblePaths: ['/scoops/lead/readme.md'],
      });
      expect(isPolicySubset(visibleUnderWritable, supervisor)).toBe(true);

      // Narrower is fine; empty is fine; equal is fine.
      expect(
        isPolicySubset(
          delegatedChildPolicy('scoop_lead', {
            writablePaths: ['/scoops/lead/'],
            visiblePaths: [],
          }),
          supervisor
        )
      ).toBe(true);
    });

    it('rejects a grandchild that widens allowedCommands past the supervisor', () => {
      const supervisor = delegatedChildPolicy('cone_1', {
        canCreateChildren: true,
        writablePaths: ['/scoops/lead/'],
        visiblePaths: ['/scoops/lead/'],
        allowedCommands: ['echo', 'cat'],
      });
      // Omitting allowedCommands → NOPASSWD Cmnd * — a widen.
      expect(
        isPolicySubset(
          delegatedChildPolicy('scoop_lead', {
            writablePaths: ['/scoops/lead/'],
            visiblePaths: ['/scoops/lead/'],
          }),
          supervisor
        )
      ).toBe(false);
      expect(
        isPolicySubset(
          delegatedChildPolicy('scoop_lead', {
            writablePaths: ['/scoops/lead/'],
            visiblePaths: ['/scoops/lead/'],
            allowedCommands: ['*'],
          }),
          supervisor
        )
      ).toBe(false);
      expect(
        isPolicySubset(
          delegatedChildPolicy('scoop_lead', {
            writablePaths: ['/scoops/lead/'],
            visiblePaths: ['/scoops/lead/'],
            allowedCommands: ['echo', 'rm'],
          }),
          supervisor
        )
      ).toBe(false);
      expect(
        isPolicySubset(
          delegatedChildPolicy('scoop_lead', {
            writablePaths: ['/scoops/lead/'],
            visiblePaths: ['/scoops/lead/'],
            allowedCommands: ['echo'],
          }),
          supervisor
        )
      ).toBe(true);
      // Unrestricted parent subsumes any child command list.
      const open = delegatedChildPolicy('cone_1', {
        canCreateChildren: true,
        writablePaths: ['/scoops/lead/'],
      });
      expect(
        isPolicySubset(
          delegatedChildPolicy('scoop_lead', {
            writablePaths: ['/scoops/lead/'],
            allowedCommands: ['rm', 'curl'],
          }),
          open
        )
      ).toBe(true);
    });
  });

  it('childrenOf / rootsOf walk the explicit edge', () => {
    const a = rootRecord({ jid: 'cone_a', addedAt: '2026-01-02T00:00:00.000Z' });
    const b = rootRecord({ jid: 'cone_b', addedAt: '2026-01-01T00:00:00.000Z' });
    const a1 = childRecord('cone_a', { folder: 'a1' });
    const a2 = childRecord('cone_a', { folder: 'a2' });
    const b1 = childRecord('cone_b', { folder: 'b1' });
    const all = [a, a1, b, a2, b1];
    expect(childrenOf(all, 'cone_a').map((s) => s.jid)).toEqual([a1.jid, a2.jid]);
    expect(childrenOf(all, 'cone_b').map((s) => s.jid)).toEqual([b1.jid]);
    expect(childrenOf(all, a1.jid)).toEqual([]);
    // oldest root first
    expect(rootsOf(all).map((s) => s.jid)).toEqual(['cone_b', 'cone_a']);
  });
});

describe('subtreeOf', () => {
  const coneA = rootRecord({ jid: 'cone_a', folder: 'cone' });
  const coneB = rootRecord({ jid: 'cone_b', folder: 'cone-b' });
  const child = childRecord(coneA.jid, { folder: 'helper-scoop' });
  const grandchild = childRecord(child.jid, { folder: 'deep-scoop' });
  const sibling = childRecord(coneB.jid, { folder: 'helper-scoop-2' });

  it('returns the unit plus everything it transitively owns', () => {
    const all = [coneA, coneB, child, grandchild, sibling];
    expect(subtreeOf(all, coneA.jid).map((u) => u.jid)).toEqual([
      coneA.jid,
      child.jid,
      grandchild.jid,
    ]);
    expect(subtreeOf(all, coneB.jid).map((u) => u.jid)).toEqual([coneB.jid, sibling.jid]);
    expect(subtreeOf(all, child.jid).map((u) => u.jid)).toEqual([child.jid, grandchild.jid]);
  });

  it('is registry-order independent', () => {
    const forward = [coneA, coneB, child, grandchild, sibling];
    const reversed = [...forward].reverse();
    expect(new Set(subtreeOf(reversed, coneA.jid).map((u) => u.jid))).toEqual(
      new Set(subtreeOf(forward, coneA.jid).map((u) => u.jid))
    );
  });

  it('is empty for an unregistered root rather than widening to everything', () => {
    expect(subtreeOf([coneA, child], 'gone')).toEqual([]);
  });
});

describe('delegated approver scoops', () => {
  it('grants approval settling only to a scoop explicitly marked for it', () => {
    const plain = derivePolicy({
      jid: 'scoop_a',
      name: 'a',
      folder: 'a',
      requiresTrigger: false,
      assistantLabel: 'a',
      addedAt: '2026-08-27T00:00:00.000Z',
      parentJid: 'cone_1',
    } as never);
    expect(plain.canResolveApprovals).toBe(false);

    const approver = derivePolicy({
      jid: 'scoop_b',
      name: 'reviewer',
      folder: 'reviewer',
      requiresTrigger: false,
      assistantLabel: 'reviewer',
      addedAt: '2026-08-27T00:00:00.000Z',
      parentJid: 'cone_1',
      approvesGuestRequests: true,
    } as never);
    // Without this the scoop tier cannot work at all: the scoop receives the
    // request with no way to answer, and it times out denied.
    expect(approver.canResolveApprovals).toBe(true);
  });

  it('keeps the subset invariant — the capability comes from a parent that has it', () => {
    const root = interactiveRootPolicy();
    const approver = delegatedChildPolicy('cone_1', { approvesGuestRequests: true });
    expect(isPolicySubset(approver, root)).toBe(true);
  });

  it('does not widen anything else', () => {
    const approver = delegatedChildPolicy('cone_1', { approvesGuestRequests: true });
    expect(approver.canCreateChildren).toBe(false);
    expect(approver.canManageChildren).toBe(false);
    expect(approver.canWriteSharedMemory).toBe(false);
    expect(approver.persistCommandGrants).toBe(false);
    expect(approver.sudoDefaultDisposition).toBe('require-approval');
    expect(approver.filesystem.kind).toBe('restricted');
  });
});

describe('assertChildPolicyAllowed', () => {
  const root = rootRecord();
  // Supervisor sandbox must cover any grandchild paths it mints — empty
  // writable/visible lists (config: { canCreateChildren: true } alone) would
  // reject every default childRecord path under the new containment gate.
  const granted = childRecord(root.jid, {
    folder: 'lead-scoop',
    config: {
      canCreateChildren: true,
      writablePaths: ['/scoops/', '/shared/'],
      visiblePaths: ['/workspace/', '/scoops/'],
    },
  });
  const leaf = childRecord(root.jid, { folder: 'leaf-scoop' });

  it('allows a default child of a root and a grandchild of a granted child', () => {
    expect(() => assertChildPolicyAllowed(leaf, root)).not.toThrow();
    expect(() =>
      assertChildPolicyAllowed(childRecord(granted.jid, { folder: 'deep-scoop' }), granted)
    ).not.toThrow();
  });

  it('allows re-granting nested delegation when the parent already holds it', () => {
    const grandchild = childRecord(granted.jid, {
      folder: 'deep-scoop',
      config: {
        canCreateChildren: true,
        writablePaths: ['/scoops/deep-scoop/', '/shared/'],
        visiblePaths: ['/workspace/'],
      },
    });
    expect(() => assertChildPolicyAllowed(grandchild, granted)).not.toThrow();
  });

  it('refuses a grandchild when the parent was not granted canCreateChildren', () => {
    // Use empty paths so the subset gate does not fire first — this assertion
    // is about the canCreateChildren capability, not path containment.
    expect(() =>
      assertChildPolicyAllowed(
        childRecord(leaf.jid, {
          folder: 'deep-scoop',
          config: { writablePaths: [], visiblePaths: [] },
        }),
        leaf
      )
    ).toThrow(/cannot create children/);
  });

  it('rejects a subset violation — a grant the parent does not hold', () => {
    const overreaching = childRecord(leaf.jid, {
      folder: 'lead-scoop',
      config: {
        canCreateChildren: true,
        writablePaths: [],
        visiblePaths: [],
      },
    });
    expect(() => assertChildPolicyAllowed(overreaching, leaf)).toThrow(/isPolicySubset/);

    const approverGrandchild = childRecord(granted.jid, {
      folder: 'reviewer-scoop',
      approvesGuestRequests: true,
      config: {
        writablePaths: ['/scoops/reviewer-scoop/', '/shared/'],
        visiblePaths: ['/workspace/'],
      },
    });
    expect(() => assertChildPolicyAllowed(approverGrandchild, granted)).toThrow(/isPolicySubset/);
  });

  it('rejects a grandchild whose paths escape the granted supervisor', () => {
    const sandbox = childRecord(root.jid, {
      folder: 'lead-scoop',
      config: {
        canCreateChildren: true,
        writablePaths: ['/scoops/lead-scoop/'],
        visiblePaths: ['/scoops/lead-scoop/'],
      },
    });
    const escape = childRecord(sandbox.jid, {
      folder: 'deep-scoop',
      config: {
        writablePaths: ['/workspace/'],
        visiblePaths: ['/workspace/'],
      },
    });
    expect(() => assertChildPolicyAllowed(escape, sandbox)).toThrow(/isPolicySubset/);

    const nested = childRecord(sandbox.jid, {
      folder: 'deep-scoop',
      config: {
        writablePaths: ['/scoops/lead-scoop/deep/'],
        visiblePaths: ['/scoops/lead-scoop/'],
        allowedCommands: ['echo'],
      },
    });
    // Parent has no allowedCommands (unrestricted) so echo is fine.
    expect(() => assertChildPolicyAllowed(nested, sandbox)).not.toThrow();
  });

  it('rejects a grandchild that omits allowedCommands under a restricted supervisor', () => {
    const sandbox = childRecord(root.jid, {
      folder: 'lead-scoop',
      config: {
        canCreateChildren: true,
        writablePaths: ['/scoops/lead-scoop/'],
        visiblePaths: ['/scoops/lead-scoop/'],
        allowedCommands: ['echo', 'cat'],
      },
    });
    const widen = childRecord(sandbox.jid, {
      folder: 'deep-scoop',
      config: {
        writablePaths: ['/scoops/lead-scoop/deep/'],
        visiblePaths: ['/scoops/lead-scoop/'],
      },
    });
    expect(() => assertChildPolicyAllowed(widen, sandbox)).toThrow(/isPolicySubset/);
  });
});

describe('capableApproverOf', () => {
  it('walks past a canCreateChildren supervisor to a capable ancestor', () => {
    const root = rootRecord({ jid: 'cone_1' });
    const supervisor = childRecord(root.jid, {
      folder: 'lead-scoop',
      config: { canCreateChildren: true },
    });
    const grandchild = childRecord(supervisor.jid, { folder: 'deep-scoop' });
    const all = [root, supervisor, grandchild];
    expect(capableApproverOf(all, grandchild)?.jid).toBe(root.jid);
    expect(derivePolicy(supervisor).canResolveApprovals).toBe(false);
  });

  it('stops at a delegated approver between the requester and the root', () => {
    const root = rootRecord({ jid: 'cone_1' });
    const approver = childRecord(root.jid, {
      folder: 'reviewer-scoop',
      approvesGuestRequests: true,
      config: { canCreateChildren: true },
    });
    const grandchild = childRecord(approver.jid, { folder: 'deep-scoop' });
    expect(capableApproverOf([root, approver, grandchild], grandchild)?.jid).toBe(approver.jid);
  });

  it('returns undefined when the chain has no capable ancestor', () => {
    const orphan = childRecord('missing', { folder: 'orphan-scoop' });
    expect(capableApproverOf([orphan], orphan)).toBeUndefined();
  });
});
