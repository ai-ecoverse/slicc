import { describe, expect, it, vi } from 'vitest';
import { ScoopContextWorkUnit } from '../../src/work-unit/runtime.js';
import type { WorkUnitEvent } from '../../src/work-unit/types.js';
import { runWorkUnitConformance } from './conformance.js';
import { childRecord, makeFakeHost, rootRecord } from './fixtures.js';

describe('ScoopContextWorkUnit', () => {
  const root = rootRecord();
  const child = childRecord(root.jid);

  it('projects a fresh descriptor on every read', () => {
    const host = makeFakeHost([root, child]);
    const unit = new ScoopContextWorkUnit(child.jid, host);
    expect(unit.descriptor.status).toBe('creating');
    host.tabs.set(child.jid, {
      jid: child.jid,
      contextId: 'c',
      status: 'processing',
      lastActivity: 'x',
    });
    expect(unit.descriptor.status).toBe('running');
    expect(unit.descriptor.parentId).toBe(root.jid);
  });

  it('throws for an unknown id', () => {
    const host = makeFakeHost([]);
    const unit = new ScoopContextWorkUnit('ghost', host);
    expect(() => unit.descriptor).toThrow(/Work unit not found/);
  });

  it('send delegates to sendPrompt with sender defaults and steer passthrough', async () => {
    const host = makeFakeHost([root, child]);
    const unit = new ScoopContextWorkUnit(child.jid, host);
    await unit.send({ text: 'hi' });
    expect(host.sendPrompt).toHaveBeenLastCalledWith(
      child.jid,
      'hi',
      'user',
      child.assistantLabel,
      [],
      undefined
    );
    await unit.send({ text: 'now', senderId: 'cone', senderName: 'sliccy', steer: true });
    expect(host.sendPrompt).toHaveBeenLastCalledWith(child.jid, 'now', 'cone', 'sliccy', [], {
      steer: true,
    });
  });

  it('subscribe maps observer callbacks onto typed events and unsubscribes', () => {
    const host = makeFakeHost([root, child]);
    const unit = new ScoopContextWorkUnit(child.jid, host);
    const events: WorkUnitEvent[] = [];
    const off = unit.subscribe((e) => events.push(e));

    host.emit(child.jid, 'onStatusChange', 'processing');
    host.emit(child.jid, 'onResponse', 'partial', true);
    host.emit(child.jid, 'onSendMessage', 'progress');
    host.emit(child.jid, 'onError', 'boom');
    host.emit(child.jid, 'onStatusChange', 'error');
    expect(events).toEqual([
      { type: 'status', status: 'running' },
      { type: 'response', text: 'partial', isPartial: true },
      { type: 'send-message', text: 'progress' },
      { type: 'error', error: 'boom' },
      { type: 'status', status: 'failed' },
    ]);

    off();
    host.emit(child.jid, 'onStatusChange', 'ready');
    expect(events).toHaveLength(5);
    expect(host.observers.get(child.jid)?.size ?? 0).toBe(0);
  });

  it('abort stops the scoop and close unregisters it', async () => {
    const host = makeFakeHost([root, child]);
    const unit = new ScoopContextWorkUnit(child.jid, host);
    await unit.abort('user');
    expect(host.stopScoop).toHaveBeenCalledWith(child.jid);
    await unit.close();
    expect(host.unregisterScoop).toHaveBeenCalledWith(child.jid);
    expect(host.getScoop(child.jid)).toBeUndefined();
  });

  it('close propagates the active-licks rejection unchanged', async () => {
    const host = makeFakeHost([root, child]);
    host.unregisterScoop.mockRejectedValueOnce(new Error('has active licks'));
    const unit = new ScoopContextWorkUnit(child.jid, host);
    await expect(unit.close()).rejects.toThrow('has active licks');
  });

  it('snapshot reads settled messages and context fill when a context is live', async () => {
    const host = makeFakeHost([root, child]);
    const unit = new ScoopContextWorkUnit(child.jid, host);
    expect(await unit.snapshot()).toEqual({
      descriptor: unit.descriptor,
      messages: [],
      contextFill: 0,
    });
    const messages = [{ role: 'user', content: 'x' }];
    host.contexts.set(child.jid, {
      getAgentMessages: vi.fn(() => messages),
      getContextFill: () => 0.25,
    });
    const snap = await unit.snapshot();
    expect(snap.messages).toBe(messages);
    expect(snap.contextFill).toBe(0.25);
  });

  runWorkUnitConformance('ScoopContextWorkUnit (Phase 1 adapter)', () => {
    const host = makeFakeHost([root, child]);
    return {
      root: new ScoopContextWorkUnit(root.jid, host),
      child: new ScoopContextWorkUnit(child.jid, host),
      emitStatus: (id, status) => host.emit(id, 'onStatusChange', status),
    };
  });
});
