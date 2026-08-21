/**
 * Reusable conformance suite for any {@link WorkUnitRuntime} implementation.
 * Phase 1 runs it against the `ScoopContext` adapter; Phase 2 runs the same
 * suite against the native runtime so the contract — not the class — is what
 * stays stable.
 */

import { describe, expect, it } from 'vitest';
import type { ScoopTabState } from '../../src/scoops/types.js';
import { isPolicySubset } from '../../src/work-unit/policy.js';
import type { WorkUnitRuntime } from '../../src/work-unit/runtime.js';
import type { WorkUnitEvent } from '../../src/work-unit/types.js';

export interface ConformanceHarness {
  /** A root unit. */
  root: WorkUnitRuntime;
  /** A child of `root`. */
  child: WorkUnitRuntime;
  /** Drive a status transition on `id` as the host would. */
  emitStatus(id: string, status: ScoopTabState['status']): void;
}

export function runWorkUnitConformance(name: string, make: () => ConformanceHarness): void {
  describe(`WorkUnitRuntime conformance: ${name}`, () => {
    it('root and child are distinguished by the parent edge only', () => {
      const { root, child } = make();
      expect(root.descriptor.parentId).toBeNull();
      expect(root.descriptor.display.role).toBe('primary');
      expect(child.descriptor.parentId).toBe(root.descriptor.id);
      expect(child.descriptor.display.role).toBe('child');
    });

    it('child capabilities are a subset of the parent capabilities', () => {
      const { root, child } = make();
      expect(isPolicySubset(child.descriptor.policy, root.descriptor.policy)).toBe(true);
    });

    it('a child names its parent as approval authority; a root names the user', () => {
      const { root, child } = make();
      expect(root.descriptor.policy.approvalAuthority).toBe('user');
      expect(child.descriptor.policy.approvalAuthority).toEqual({ parentId: root.descriptor.id });
    });

    it('a root completes interactively; a child notifies its parent', () => {
      const { root, child } = make();
      expect(root.descriptor.completion.mode).toBe('interactive');
      expect(child.descriptor.completion.mode).toBe('notify-parent');
    });

    it('workspace coordinates are nested under the unit root', () => {
      const { root, child } = make();
      for (const unit of [root, child]) {
        const { root: dir, memoryPath, scratch } = unit.descriptor.workspace;
        expect(dir.startsWith('/')).toBe(true);
        expect(memoryPath.endsWith('/CLAUDE.md')).toBe(true);
        expect(scratch.startsWith('/')).toBe(true);
      }
      expect(child.descriptor.workspace.root).not.toBe(root.descriptor.workspace.root);
    });

    it('status events follow the lifecycle and stop after unsubscribe', () => {
      const { child, emitStatus } = make();
      const seen: WorkUnitEvent[] = [];
      const off = child.subscribe((e) => seen.push(e));
      emitStatus(child.descriptor.id, 'initializing');
      emitStatus(child.descriptor.id, 'ready');
      emitStatus(child.descriptor.id, 'processing');
      emitStatus(child.descriptor.id, 'ready');
      expect(seen.map((e) => (e.type === 'status' ? e.status : e.type))).toEqual([
        'creating',
        'ready',
        'running',
        'ready',
      ]);
      off();
      emitStatus(child.descriptor.id, 'error');
      expect(seen).toHaveLength(4);
    });

    it('snapshot embeds the current descriptor', async () => {
      const { child } = make();
      const snap = await child.snapshot();
      expect(snap.descriptor).toEqual(child.descriptor);
      expect(Array.isArray(snap.messages)).toBe(true);
      expect(snap.contextFill).toBeGreaterThanOrEqual(0);
    });

    it('abort is idempotent and leaves the unit addressable', async () => {
      const { child } = make();
      await child.abort();
      await child.abort('again');
      expect(child.descriptor.id).toBeTruthy();
    });
  });
}
