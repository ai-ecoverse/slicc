/**
 * Reusable conformance suite for any {@link WorkUnitClient} implementation
 * (#2274).
 *
 * Both shipped adapters run it — `LocalWorkUnitClient` over a fake kernel,
 * `RemoteWorkUnitClient` over a fake tray. It pins exactly the rows that
 * drifted while the two paths were separate: order, role, model, queue and
 * event ordering.
 */

import { describe, expect, it } from 'vitest';
import { toTabDescriptors } from '../../../src/work-unit/client/presentation.js';
import type { WorkUnitClientEvent } from '../../../src/work-unit/client/types.js';
import type { ClientHarness, FakeUnit } from './fakes.js';

/** A cone, its scoop, and a second cone — the roster every parity claim uses. */
export const ROSTER: FakeUnit[] = [
  {
    assistantLabel: 'sliccy',
    fill: 12,
    folder: 'cone',
    id: 'cone_1',
    model: { id: 'claude-opus-4-6', provider: 'anthropic' },
    name: 'sliccy',
    parentId: null,
    status: 'ready',
  },
  {
    assistantLabel: 'sliccy',
    folder: 'cone-research',
    id: 'cone_2',
    model: { id: 'claude-sonnet-5', provider: 'anthropic' },
    name: 'Research',
    parentId: null,
    status: 'ready',
  },
  {
    assistantLabel: 'sliccy',
    folder: 'helper-scoop',
    id: 'scoop_1',
    name: 'helper',
    parentId: 'cone_2',
    status: 'processing',
    phase: 'tool',
  },
];

const color = (unit: { isRoot: boolean; name: string }): string =>
  unit.isRoot ? '#cone' : `#${unit.name}`;

export function runWorkUnitClientConformance(name: string, make: () => ClientHarness): void {
  describe(`WorkUnitClient conformance: ${name}`, () => {
    it('lists every unit with the ownership edge and the derived role', async () => {
      const harness = make();
      harness.setRoster(ROSTER);
      const units = await harness.client.list();
      expect(units.map((unit) => [unit.id, unit.role])).toEqual([
        ['cone_1', 'primary'],
        ['cone_2', 'primary'],
        ['scoop_1', 'child'],
      ]);
      expect(units.find((unit) => unit.id === 'scoop_1')?.parentId).toBe('cone_2');
    });

    it('orders the strip cones-first, with the selected cone’s scoops next', async () => {
      const harness = make();
      harness.setRoster(ROSTER, 'cone_2');
      const descriptors = toTabDescriptors(await harness.client.list(), 'cone_2', color);
      expect(descriptors.map((tab) => tab.key)).toEqual(['cone_1', 'cone_2', 'scoop_1']);
      expect(descriptors.map((tab) => tab.type)).toEqual(['cone', 'cone', 'scoop']);
      // A root shows its assistant label, a child its own name (#2272).
      expect(descriptors.map((tab) => tab.label)).toEqual(['sliccy', 'sliccy', 'helper']);
    });

    it('renders a busy child with its phase and an idle unit without one', async () => {
      const harness = make();
      harness.setRoster(ROSTER);
      const descriptors = toTabDescriptors(await harness.client.list(), 'cone_1', color);
      const scoop = descriptors.find((tab) => tab.key === 'scoop_1');
      expect(scoop?.state).toBe('working');
      expect(scoop?.phase).toBe('tool');
      expect(descriptors.find((tab) => tab.key === 'cone_1')?.phase).toBeUndefined();
    });

    it('carries each unit’s own model, and never invents one', async () => {
      const harness = make();
      harness.setRoster(ROSTER);
      const units = await harness.client.list();
      expect(units.find((unit) => unit.id === 'cone_1')?.model?.id).toBe('claude-opus-4-6');
      expect(units.find((unit) => unit.id === 'cone_2')?.model?.id).toBe('claude-sonnet-5');
      // The scoop has none: absent means "not known yet", never the global
      // selection — an empty catalog is warm-up, not an answer (#2329).
      expect(units.find((unit) => unit.id === 'scoop_1')?.model).toBeUndefined();
    });

    it('resolves a snapshot for the unit it names', async () => {
      const harness = make();
      harness.setRoster(ROSTER);
      const pending = harness.client.snapshot('cone_1');
      harness.emitSnapshot('cone_1', [{ content: 'hi', id: 'm1', role: 'user', timestamp: 1 }]);
      const snapshot = await pending;
      expect(snapshot.summary.id).toBe('cone_1');
      expect(snapshot.messages).toHaveLength(1);
    });

    it('reports the backend queue only when the transport can answer for it', async () => {
      const harness = make();
      harness.setRoster(ROSTER);
      const pending = harness.client.snapshot('cone_1');
      harness.emitSnapshot('cone_1', [], ['q2', 'q1']);
      const snapshot = await pending;
      if (harness.carriesQueue) {
        // Ids ride the SAME snapshot as the messages, in delivery order.
        expect(snapshot.queuedIds).toEqual(['q2', 'q1']);
      } else {
        // Absent is not empty: a follower cannot answer for the leader's
        // queue, and `[]` there would reorder the pile against a lie.
        expect(snapshot.queuedIds).toBeUndefined();
      }
    });

    it('delivers a snapshot before any incremental event to a mid-turn subscriber', async () => {
      const harness = make();
      harness.setRoster(ROSTER);
      const seen: WorkUnitClientEvent[] = [];
      const off = harness.client.subscribe('cone_1', (event) => seen.push(event));
      harness.emitStatus('cone_1', 'processing');
      harness.emitSnapshot('cone_1', [{ content: 'a', id: 'm1', role: 'user', timestamp: 1 }]);
      harness.emitMessage('cone_1', { content: 'b', id: 'm2' });
      const kinds = seen.map((event) => event.type);
      expect(kinds).toContain('snapshot');
      const snapshotAt = kinds.indexOf('snapshot');
      const messageAt = kinds.indexOf('message');
      // A `message` is only meaningful after the replay it belongs to.
      if (messageAt >= 0) expect(messageAt).toBeGreaterThan(snapshotAt);
      off();
      harness.emitStatus('cone_1', 'ready');
      expect(seen.map((event) => event.type)).toEqual(kinds);
    });

    it('sends a prompt to the unit it names', async () => {
      const harness = make();
      harness.setRoster(ROSTER, 'cone_1');
      await harness.client.send('cone_2', { text: 'go' });
      expect(harness.sent).toEqual([{ id: 'cone_2', text: 'go' }]);
    });

    it('stops the unit it names', async () => {
      const harness = make();
      harness.setRoster(ROSTER, 'cone_1');
      await harness.client.signal('cone_2', 'stop');
      expect(harness.stopped).toEqual(['cone_2']);
    });

    it('pushes the roster to list subscribers and stops after unsubscribe', () => {
      const harness = make();
      const seen: number[] = [];
      const off = harness.client.subscribeList((units) => seen.push(units.length));
      harness.setRoster(ROSTER);
      expect(seen.at(-1)).toBe(3);
      off();
      harness.setRoster(ROSTER.slice(0, 2));
      expect(seen.at(-1)).toBe(3);
    });
  });
}
