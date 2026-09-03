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

/** The strip: roster, order, role, phase and per-unit model. */
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
}

/** The transcript: snapshots, the backend queue, and event ordering. */
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

  it('seeds a late subscriber with the snapshot it missed', () => {
    const harness = make();
    harness.setRoster(ROSTER);
    harness.emitSnapshot('cone_1', [{ content: 'a', id: 'm1', role: 'user', timestamp: 1 }]);
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));
    // Attaching after the replay must not mean attaching without one.
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
      // `[]` is a REAL answer — the backend has nothing pending — and the held
      // pile is reconciled against it.
      expect(emptied.queuedIds).toEqual([]);
    } else {
      // A follower cannot tell a queued prompt from a consumed one, so it says
      // "nobody could answer" and the held order stands. Reporting `[]` here
      // would reorder the pile against a lie (#2362).
      expect(emptied.queuedIds).toBeUndefined();
    }
    // Whatever the transport answers, `messages` and `queuedIds` describe ONE
    // instant: they ride the same envelope, so a reader can never reconcile a
    // queue against a transcript from a different moment.
    expect(emptied.messages).toEqual([]);
  });

  it('does not ask the transport twice when a subscribe joins an in-flight snapshot', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const asksBefore = harness.transcriptRequests.length;
    const pending = harness.client.snapshot('cone_1');
    // The mount subscribes right after selecting, which is the same unit the
    // snapshot is already fetching. Asking again would replay the SAME
    // transcript twice — once per caller — and each `loadMessages` consumes
    // the one-shot held-queue restore (#2354).
    harness.client.subscribe('cone_1', () => undefined);
    harness.emitSnapshot('cone_1', [{ content: 'a', id: 'm1', role: 'user', timestamp: 1 }]);
    await pending;
    expect(harness.transcriptRequests.length - asksBefore).toBeLessThanOrEqual(1);
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
    // Both reached the subscriber in order, and the LAST one is what the shell
    // renders — a re-selection of the same unit is a full replacement, not a
    // merge.
    const snapshots = seen.filter((event) => event.type === 'snapshot');
    expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('delivers a snapshot that arrives before the roster names its unit', async () => {
    const harness = make();
    // No `setRoster` first: a leader sends the initial transcript AHEAD of
    // `scoops.list`, and a guest seat is never sent one at all. The transcript
    // is the part that matters, so it must not wait for a summary that may
    // never come.
    const seen: WorkUnitClientEvent[] = [];
    harness.client.subscribe('cone_1', (event) => seen.push(event));
    harness.emitSnapshot('cone_1', [{ content: 'early', id: 'm1', role: 'user', timestamp: 1 }]);
    const snapshots = seen.filter((event) => event.type === 'snapshot');
    if (harness.mirrorsOneUnit) {
      expect(snapshots.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
      // …and it says so honestly rather than inventing a strip entry.
      expect(snapshots.at(-1)?.snapshot.summary).toBeUndefined();
    } else {
      // The kernel path answers per jid and its roster always arrives, so it
      // holds the orphan until the unit is listed rather than describing it.
      harness.setRoster(ROSTER, 'cone_1');
      const published = seen.filter((event) => event.type === 'snapshot');
      expect(published.at(-1)?.snapshot.messages.map((m) => m.id)).toEqual(['m1']);
      expect(published.at(-1)?.snapshot.summary?.id).toBe('cone_1');
    }
  });
}

/** Snapshot ordering and supersession — the rules a re-selection depends on. */
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
    // The tab moved to `cone_2` while `cone_1`'s reply was still in flight.
    harness.emitSnapshot('cone_1', [{ content: 'late', id: 'm9', role: 'user', timestamp: 9 }]);
    harness.emitSnapshot('cone_2', [{ content: 'b', id: 'm2', role: 'user', timestamp: 2 }]);
    const snapshot = await second;
    expect(snapshot.summary?.id).toBe('cone_2');
    expect(snapshot.messages.map((message) => message.id)).toEqual(['m2']);
    // On a single-mirror transport the superseded reply is not just ignorable,
    // it is WRONG: publishing it would re-point the mirror at `cone_1`, and the
    // proof is that a send to the unit on screen then needs a fresh selection
    // round trip. A transport that mirrors every unit at once (a kernel replay
    // is per-jid) has nothing to supersede, so it re-selects nothing either.
    await harness.client.send('cone_2', { text: 'go' });
    expect(harness.selections.slice(selectionsBefore)).toEqual([]);
    // …and on that transport the superseded transcript never reaches a
    // subscriber as if it were still current. A per-jid transport answers for
    // `cone_1` whether or not it is on screen, so its late reply is a real
    // answer and is delivered.
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
    // `subscribeList` promises a push for a status change, on both
    // transports — a roster that lags the face is how the two drifted.
    expect(seen.at(-1)).toBe('working');
  });
}

/** The composer: send, steer, stop and the model write. */
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
    // The composer's own id: the backend queue is cancelled by it and a
    // follower suppresses its own echo by it, so an adapter that minted its
    // own would orphan the queue entry the shell is showing.
    expect(harness.sent.at(-1)?.messageId).toBe('msg-42');
  });

  it('carries a steering send as a steer, not as a queued prompt', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    harness.emitStatus('cone_1', 'processing');
    await harness.client.send('cone_1', { steer: true, text: 'actually, stop and do this' });
    await harness.client.send('cone_1', { text: 'and then this' });
    // Ctrl/Cmd+Enter mid-turn interrupts; a plain send queues behind the
    // turn. Losing the flag silently turns the first into the second.
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
    // The signal is the whole effect: nothing was sent to get there.
    expect(harness.sent).toEqual([]);
    if (harness.carriesQueue) {
      // The kernel's `abort` names the unit, so nothing has to be selected.
      expect(harness.selections.slice(selectionsBefore)).toEqual([]);
    } else {
      // The tray's `abort` frame carries NO unit — it aborts whatever the
      // leader is running for this follower — so naming `cone_2` has to mean
      // selecting it first. Without that the abort would hit `cone_1`.
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
    // A gate is minted by a LEADER from its own seat record. The expectation
    // is per transport rather than "either is fine": a local client that
    // refused, or a remote one that delivered, would both pass an if/else and
    // both are wrong.
    expect(delivered).toBe(harness.carriesGuestGate);
    if (harness.carriesGuestGate) expect(harness.sent.at(-1)?.guestGate).toBe(gate);
    // Dropping the gate and delivering the message anyway is the one outcome
    // that must not happen.
    else expect(harness.sent).toEqual([]);
  });

  it('fails a send, a stop and a model write once the transport is gone', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    harness.disconnect();

    // Each of these CLAIMS something reached the backend. Resolving with no
    // transport reports a delivered prompt, a stopped turn and an applied
    // model that never happened — and the composer has already rendered its
    // bubble and cleared the input by then.
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
    // Per transport, not "either": `undefined` is "nobody could answer" (no ack
    // frame on the tray wire) and is the ONLY answer a remote client may give,
    // while a local one always has the kernel's real ack. Accepting both from
    // both would pass an adapter that invented an ack.
    expect(confirmed).toBe(harness.acksModelWrite ? true : undefined);
  });

  it('answers a model write for an unknown unit without inventing a refusal', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    const confirmed = await harness.client.setModel('cone_gone', {
      id: 'claude-opus-4-6',
      provider: 'anthropic',
    });
    // `false` is a REFUSAL the backend actually made; only a transport with an
    // ack can report one. Same absent-is-not-empty rule as `queuedIds`.
    expect(confirmed).toBe(harness.acksModelWrite ? false : undefined);
  });

  it('names a child on a model pick rather than resolving its owner', async () => {
    const harness = make();
    harness.setRoster(ROSTER, 'cone_1');
    await harness.client.setModel('scoop_1', { id: 'claude-sonnet-5', provider: 'anthropic' });
    // Both backends resolve a child to the cone that owns it (#2310).
    // Resolving it client-side would put a third owner walk beside the two
    // that already disagree.
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
