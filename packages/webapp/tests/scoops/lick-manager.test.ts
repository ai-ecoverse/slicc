import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  FORWARDABLE_TO_LEADER,
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
  // Workflow completions, sudo-request chips, and preview lifecycle events
  // are produced and consumed on the float that owns them.
  'workflow',
  'sudo-request',
  'preview',
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
  'workflow',
  'sudo-request',
  'preview',
  'discovery',
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
  workflow: true,
  'sudo-request': true,
  preview: true,
  discovery: true,
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
    expect([...FORWARDABLE_TO_LEADER]).toEqual(['navigate', 'discovery']);
  });

  it('emitEvent suppresses a duplicate discovery lick with the same artifact identity', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    const discovery = (): LickEvent => ({
      type: 'discovery',
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'ai-catalog',
      discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
      timestamp: 't',
      body: {},
    });
    manager.emitEvent(discovery());
    manager.emitEvent(discovery());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emitEvent forwards a discovery lick to the leader (forwardable) and skips the local handler', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);
    manager.emitEvent({
      type: 'discovery',
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'llms-txt',
      discoveryUrl: 'https://example.com/llms.txt',
      timestamp: 't',
      body: {},
    });
    expect(forwarder).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
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
