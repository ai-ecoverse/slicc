import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  FORWARDABLE_TO_LEADER,
  LICKBACK_FORWARDABLE,
  type LickEvent,
  LickManager,
} from '../../src/scoops/lick-manager.js';

const SPRINKLE_DEDICATED: ReadonlySet<LickEvent['type']> = new Set(['sprinkle']);
const LOCAL_ONLY: ReadonlySet<LickEvent['type']> = new Set([
  'webhook',
  'cron',
  'fswatch',
  'session-reload',
  'upgrade',
  // `cherry` is emitted ON the leader by `Orchestrator.handleCherryHostEvent`
  // after the leader receives a `cherry.host_event` from a follower, so it's
  // never a follower-side forward source.
  'cherry',
]);
const ALL_LICK_TYPES: LickEvent['type'][] = [
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'upgrade',
  'cherry',
];
const _exhaustive: Record<LickEvent['type'], true> = {
  webhook: true,
  cron: true,
  sprinkle: true,
  fswatch: true,
  'session-reload': true,
  navigate: true,
  upgrade: true,
  cherry: true,
};
void _exhaustive;

function navEvent(): LickEvent {
  return { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
}

describe('LickManager forwarder dispatch', () => {
  let manager: LickManager;
  beforeEach(() => {
    manager = new LickManager();
  });

  it('classifies every lick type as forwardable, sprinkle-dedicated, or local', () => {
    for (const t of ALL_LICK_TYPES) {
      const classified =
        FORWARDABLE_TO_LEADER.has(t) || SPRINKLE_DEDICATED.has(t) || LOCAL_ONLY.has(t);
      expect(classified, `type "${t}" is unclassified`).toBe(true);
    }
    expect([...FORWARDABLE_TO_LEADER]).toEqual(['navigate']);
  });

  it('emitEvent forwards a forwardable lick and skips the local handler', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);
    manager.emitEvent(navEvent());
    expect(forwarder).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emitEvent runs the local handler for a non-forwardable lick even with a forwarder', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);
    manager.emitEvent({ type: 'session-reload', timestamp: 't', body: {} });
    expect(forwarder).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emitEvent runs the local handler when no forwarder is installed (leader/standalone)', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.emitEvent(navEvent());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('clearing the forwarder restores local handling', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);
    manager.setForwarder(null);
    manager.emitEvent(navEvent());
    expect(forwarder).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('webhook events go to the local handler, never the forwarder', async () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);
    await manager.createWebhook('hook1', 'cone');
    const created = manager.getLicksForScoop('cone', 'cone').webhooks[0];
    manager.handleWebhookEvent(created.id, {}, { ok: true });
    expect(forwarder).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('LickManager lick-back forwarder (substrate)', () => {
  let manager: LickManager;
  beforeEach(() => {
    manager = new LickManager();
  });

  function upgradeEvent(): LickEvent {
    return {
      type: 'upgrade',
      timestamp: 't',
      upgradeFromVersion: '5.0.0',
      upgradeToVersion: '5.1.0',
      body: { from: '5.0.0', to: '5.1.0' },
    };
  }

  it('LICKBACK_FORWARDABLE carries upgrade + sprinkle but never session-reload', () => {
    expect(LICKBACK_FORWARDABLE.has('upgrade')).toBe(true);
    expect(LICKBACK_FORWARDABLE.has('sprinkle')).toBe(true);
    expect(LICKBACK_FORWARDABLE.has('session-reload')).toBe(false);
  });

  it('forwards an orphaned upgrade lick outbound instead of dropping it at the (absent) cone', () => {
    const handler = vi.fn();
    const lickback = vi.fn();
    manager.setEventHandler(handler);
    manager.setLickbackForwarder(lickback);
    manager.emitEvent(upgradeEvent());
    expect(lickback).toHaveBeenCalledTimes(1);
    expect(lickback.mock.calls[0][0]).toMatchObject({ type: 'upgrade' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps session-reload local even with a lick-back forwarder (internal UI signal)', () => {
    const handler = vi.fn();
    const lickback = vi.fn();
    manager.setEventHandler(handler);
    manager.setLickbackForwarder(lickback);
    manager.emitEvent({ type: 'session-reload', timestamp: 't', body: {} });
    expect(lickback).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes to the local handler when no lick-back forwarder is installed (non-substrate)', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.emitEvent(upgradeEvent());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the tray forwarder still wins its own types when both forwarders are set', () => {
    const tray = vi.fn();
    const lickback = vi.fn();
    manager.setForwarder(tray);
    manager.setLickbackForwarder(lickback);
    manager.emitEvent({ type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} });
    expect(tray).toHaveBeenCalledTimes(1);
    expect(lickback).not.toHaveBeenCalled();
  });

  it('clearing the lick-back forwarder restores local handling', () => {
    const handler = vi.fn();
    const lickback = vi.fn();
    manager.setEventHandler(handler);
    manager.setLickbackForwarder(lickback);
    manager.setLickbackForwarder(null);
    manager.emitEvent(upgradeEvent());
    expect(lickback).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
