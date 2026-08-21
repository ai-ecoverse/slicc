import { describe, expect, it } from 'vitest';
import {
  childrenOf,
  delegatedChildPolicy,
  deriveCompletion,
  derivePolicy,
  interactiveRootPolicy,
  isPolicySubset,
  isRootUnit,
  rootsOf,
} from '../../src/work-unit/policy.js';
import { childRecord, rootRecord } from './fixtures.js';

describe('work-unit policy', () => {
  it('a root is defined by parentJid === null and nothing else', () => {
    expect(isRootUnit(rootRecord())).toBe(true);
    expect(isRootUnit(childRecord('cone_1'))).toBe(false);
    // `isCone` is presentation; the edge decides.
    expect(isRootUnit(rootRecord({ isCone: false, type: 'scoop' }))).toBe(true);
    expect(isRootUnit(childRecord('cone_1', { isCone: true, type: 'cone' }))).toBe(false);
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
    expect(policy.sudoDefaultDisposition).toBe('require-approval');
    expect(policy.persistCommandGrants).toBe(false);
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

    it('rejects sudo auto-allow and full-workspace under a restricted parent', () => {
      expect(isPolicySubset({ ...child, sudoDefaultDisposition: 'allow' }, child)).toBe(false);
      expect(isPolicySubset({ ...child, filesystem: { kind: 'full-workspace' } }, child)).toBe(
        false
      );
      expect(isPolicySubset(root, child)).toBe(false);
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
