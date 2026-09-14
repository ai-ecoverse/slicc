import { describe, expect, it } from 'vitest';
import { modelForUnit, toTabDescriptors } from '../../../src/work-unit/client/presentation.js';
import type { WorkUnitClientEvent } from '../../../src/work-unit/client/types.js';
import type { ClientHarness, FakeUnit } from './fakes.js';

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

function rosterCases(make: () => ClientHarness): void {
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

  it('answers the roster synchronously, with the same units `list` resolves', async () => {
    const harness = make();
    harness.setRoster(ROSTER);
    expect(harness.client.currentUnits()).toEqual(await harness.client.list());
    const cone = harness.client.currentUnits().find((unit) => unit.id === 'cone_1');
    expect(cone).toMatchObject({
      assistantLabel: 'sliccy',
      folder: 'cone',
      model: { id: 'claude-opus-4-6', provider: 'anthropic' },
      name: 'sliccy',
      parentId: null,
      role: 'primary',
      state: 'idle',
    });
    expect(harness.client.currentUnits().find((unit) => unit.id === 'scoop_1')).toMatchObject({
      parentId: 'cone_2',
      role: 'child',
      state: 'working',
    });

    harness.emitStatus('cone_1', 'processing' as never);
    expect(harness.client.currentUnits().find((unit) => unit.id === 'cone_1')?.state).toBe(
      'working'
    );
    harness.setRoster([ROSTER[0] as FakeUnit]);
    expect(harness.client.currentUnits().map((unit) => unit.id)).toEqual(['cone_1']);

    expect(make().client.currentUnits()).toEqual([]);
  });

  it('orders the strip cones-first, with the selected cone’s scoops next', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_2');
    const descriptors = toTabDescriptors(await harness.client.list(), 'cone_2', color);
    expect(descriptors.map((tab) => tab.key)).toEqual(['cone_1', 'cone_2', 'scoop_1']);
    expect(descriptors.map((tab) => tab.type)).toEqual(['cone', 'cone', 'scoop']);

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

  it('never latches on a roster that does not KNOW the unit yet (#2329)', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const known = modelForUnit(await harness.client.list(), 'cone_1');
    expect(known?.id).toBe('claude-opus-4-6');

    expect(modelForUnit([], 'cone_1', known)?.id).toBe('claude-opus-4-6');

    expect(modelForUnit([], 'cone_1')).toBeUndefined();
  });

  it('lets a unit the roster DESCRIBES say it has no model', async () => {
    const harness = make();
    harness.setRoster(
      ROSTER.map((unit) => (unit.id === 'cone_1' ? { ...unit, model: undefined } : unit)),
      'cone_1'
    );
    const units = await harness.client.list();
    expect(units.find((unit) => unit.id === 'cone_1')?.model).toBeUndefined();

    expect(
      modelForUnit(units, 'cone_1', { id: 'claude-opus-4-6', provider: 'anthropic' })
    ).toBeUndefined();
  });

  it('reads a child’s model from the cone that owns it', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_2');
    const units = await harness.client.list();

    expect(units.find((unit) => unit.id === 'scoop_1')?.model).toBeUndefined();
    expect(modelForUnit(units, 'scoop_1')?.id).toBe('claude-sonnet-5');
  });

  it('carries each unit’s own model, and never invents one', async () => {
    const harness = make();
    harness.setRoster(ROSTER);
    const units = await harness.client.list();
    expect(units.find((unit) => unit.id === 'cone_1')?.model?.id).toBe('claude-opus-4-6');
    expect(units.find((unit) => unit.id === 'cone_2')?.model?.id).toBe('claude-sonnet-5');

    expect(units.find((unit) => unit.id === 'scoop_1')?.model).toBeUndefined();
  });
}

function transcriptCases(make: () => ClientHarness): void {
  it('resolves a snapshot for the unit it names', async () => {
    const harness = make();
    harness.setRoster(ROSTER);
    const pending = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [{ content: 'hi', id: 'm1', role: 'user', timestamp: 1 }]);
    const snapshot = await pending;
    expect(snapshot.summary?.id).toBe('cone_1');
    expect(snapshot.messages).toHaveLength(1);
  });

  it('reports the backend queue only when the transport can answer for it', async () => {
    const harness = make();
    harness.setRoster(ROSTER);
    const pending = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [], ['q2', 'q1']);
    const snapshot = await pending;
    if (harness.carriesQueue) {
      expect(snapshot.queuedIds).toEqual(['q2', 'q1']);
    } else {
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

    if (messageAt >= 0) expect(messageAt).toBeGreaterThan(snapshotAt);
    off();
    harness.emitStatus('cone_1', 'ready');
    expect(seen.map((event) => event.type)).toEqual(kinds);
  });

  it('seeds a late subscriber with the snapshot it missed', () => {
    const harness = make();
    harness.setRoster(ROSTER);
    harness.emitSnapshot('cone_1', [{ content: 'a', id: 'm1', role: 'user', timestamp: 1 }]);
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));

    const first = seen[0];
    expect(first?.type).toBe('snapshot');
    expect(first?.type === 'snapshot' && first.snapshot.messages).toHaveLength(1);
  });

  it('reconciles the backend queue only from an answer the transport made', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const empty = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [], []);
    const emptied = await empty;
    if (harness.carriesQueue) {
      expect(emptied.queuedIds).toEqual([]);
    } else {
      expect(emptied.queuedIds).toBeUndefined();
    }

    expect(emptied.messages).toEqual([]);
  });

  it('does not ask the transport twice when a subscribe joins an in-flight snapshot', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const asksBefore = harness.transcriptRequests.length;
    const pending = harness.client.snapshot('cone_1');

    harness.client.subscribe('cone_1', () => undefined);
    harness.emitSnapshot('cone_1', [{ content: 'a', id: 'm1', role: 'user', timestamp: 1 }]);
    await pending;

    expect(harness.transcriptRequests.slice(asksBefore)).toEqual(['cone_1']);
  });

  it('forgets a dead channel’s transcripts when the selection is reset', async () => {
    const harness = make();
    if (!harness.resetSelection) return;
    harness.setRoster(ROSTER, 'cone_1');
    const first = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [
      { content: 'old session', id: 'm1', role: 'user', timestamp: 1 },
    ]);
    await first;

    harness.resetSelection();
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));

    expect(seen).toEqual([]);
  });

  it('lets a second snapshot supersede the first for the same unit', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));
    const first = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [{ content: 'one', id: 'm1', role: 'user', timestamp: 1 }]);
    expect((await first).messages.map((m) => m.id)).toEqual(['m1']);
    const second = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [{ content: 'two', id: 'm2', role: 'user', timestamp: 2 }]);
    expect((await second).messages.map((m) => m.id)).toEqual(['m2']);

    const snapshots = seen.filter((event) => event.type === 'snapshot');
    expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('delivers a snapshot that arrives before the roster names its unit', async () => {
    const harness = make();

    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));
    harness.emitSnapshot('cone_1', [{ content: 'early', id: 'm1', role: 'user', timestamp: 1 }]);
    const snapshots = seen.filter((event) => event.type === 'snapshot');
    if (harness.mirrorsOneUnit) {
      expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);

      expect(snapshots.at(-1)?.snapshot.summary).toBeUndefined();
    } else {
      harness.setRoster(ROSTER, 'cone_1');
      const published = seen.filter((event) => event.type === 'snapshot');
      expect(published.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
      expect(published.at(-1)?.snapshot.summary?.id).toBe('cone_1');
    }
  });
}

function snapshotOrderingCases(make: () => ClientHarness): void {
  it('ignores a snapshot for a unit it is no longer showing', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const first = harness.client.snapshot('cone_1');
    harness.emitSnapshot('cone_1', [{ content: 'a', id: 'm1', role: 'user', timestamp: 1 }]);
    await first;
    const stale: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => stale.push(event));
    const second = harness.client.snapshot('cone_2');
    const staleBefore = stale.length;
    const selectionsBefore = harness.selections.length;

    harness.emitSnapshot('cone_1', [{ content: 'late', id: 'm9', role: 'user', timestamp: 9 }]);
    harness.emitSnapshot('cone_2', [{ content: 'b', id: 'm2', role: 'user', timestamp: 2 }]);
    const snapshot = await second;
    expect(snapshot.summary?.id).toBe('cone_2');
    expect(snapshot.messages.map((message) => message.id)).toEqual(['m2']);

    await harness.client.send('cone_2', { text: 'go' });
    expect(harness.selections.slice(selectionsBefore)).toEqual([]);

    if (harness.mirrorsOneUnit) expect(stale.slice(staleBefore)).toEqual([]);
    else expect(stale.slice(staleBefore)).toHaveLength(1);
  });

  it('pushes the roster when a unit changes state', () => {
    const harness = make();
    harness.setRoster(ROSTER);
    const seen: string[] = [];
    harness.client.subscribeList((units) => {
      seen.push(units.find((unit) => unit.id === 'cone_1')?.state ?? '?');
    });
    harness.emitStatus('cone_1', 'processing');

    expect(seen.at(-1)).toBe('working');
  });
}

function composerCases(make: () => ClientHarness): void {
  it('sends a prompt to the unit it names', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    await harness.client.send('cone_2', { text: 'go' });
    expect(harness.sent.map((prompt) => [prompt.id, prompt.text])).toEqual([['cone_2', 'go']]);
  });

  it('carries the caller’s message id to the transport', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    await harness.client.send('cone_1', { messageId: 'msg-42', text: 'go' });

    expect(harness.sent.at(-1)?.messageId).toBe('msg-42');
  });

  it('carries a steering send as a steer, not as a queued prompt', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    harness.emitStatus('cone_1', 'processing');
    await harness.client.send('cone_1', { steer: true, text: 'actually, stop and do this' });
    await harness.client.send('cone_1', { text: 'and then this' });

    expect(harness.sent.map((prompt) => prompt.steer)).toEqual([true, undefined]);
  });

  it('stops the unit it names', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    await harness.client.signal('cone_2', 'stop');
    expect(harness.stopped).toEqual(['cone_2']);
  });

  it('stops a unit mid-turn without touching the one that is selected', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    harness.emitStatus('cone_2', 'processing');
    const selectionsBefore = harness.selections.length;
    await harness.client.signal('cone_2', 'stop');
    expect(harness.stopped).toEqual(['cone_2']);

    expect(harness.sent).toEqual([]);
    if (harness.carriesQueue) {
      expect(harness.selections.slice(selectionsBefore)).toEqual([]);
    } else {
      expect(harness.selections.slice(selectionsBefore)).toEqual(['cone_2']);
    }
  });

  it('never delivers a guest-gated send ungated', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const gate = { kind: 'biscotto', seatId: 'seat_1' } as never;
    const delivered = await harness.client
      .send('cone_1', { guestGate: gate, text: 'guest words' })
      .then(() => true)
      .catch(() => false);

    expect(delivered).toBe(harness.carriesGuestGate);
    if (harness.carriesGuestGate) expect(harness.sent.at(-1)?.guestGate).toBe(gate);
    else expect(harness.sent).toEqual([]);
  });

  it('fails a send, a stop and a model write once the transport is gone', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    harness.disconnect();

    await expect(harness.client.send('cone_1', { text: 'go' })).rejects.toThrow();
    await expect(harness.client.signal('cone_1', 'stop')).rejects.toThrow();
    await expect(
      harness.client.setModel('cone_1', { id: 'claude-opus-4-6', provider: 'anthropic' })
    ).rejects.toThrow();
    expect(harness.sent).toEqual([]);
    expect(harness.stopped).toEqual([]);
    expect(harness.modelWrites).toEqual([]);
  });

  it('writes a model pick to the unit it names', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const confirmed = await harness.client.setModel('cone_2', {
      id: 'claude-opus-4-6',
      provider: 'anthropic',
    });
    expect(harness.modelWrites).toEqual([{ id: 'cone_2', model: 'anthropic:claude-opus-4-6' }]);

    expect(confirmed).toBe(harness.acksModelWrite ? true : undefined);
  });

  it('answers a model write for an unknown unit without inventing a refusal', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const confirmed = await harness.client.setModel('cone_gone', {
      id: 'claude-opus-4-6',
      provider: 'anthropic',
    });

    expect(confirmed).toBe(harness.acksModelWrite ? false : undefined);
  });

  it('names a child on a model pick rather than resolving its owner', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    await harness.client.setModel('scoop_1', { id: 'claude-sonnet-5', provider: 'anthropic' });

    expect(harness.modelWrites.at(-1)?.id).toBe('scoop_1');
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
}

export function runWorkUnitClientConformance(name: string, make: () => ClientHarness): void {
  describe(`WorkUnitClient conformance: ${name}`, () => {
    rosterCases(make);
    transcriptCases(make);
    snapshotOrderingCases(make);
    composerCases(make);
  });
}
