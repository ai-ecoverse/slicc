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
  // Workflow completions, backgrounded-bash completions, sudo-request chips,
  // and preview lifecycle events are produced and consumed on the float that
  // owns them (the bash tool runs in the leader's kernel worker).
  'workflow',
  'bash',
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
  'bash',
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
  bash: true,
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
      discoverySource: 'live-navigation',
      timestamp: 't',
      body: {},
    });
    manager.emitEvent(discovery());
    manager.emitEvent(discovery());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('suppresses ignored and archive-replayed discovery before dispatch', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.setDiscoveryIgnore((event) => event.discoveryOrigin === 'https://ignored.example');
    manager.emitEvent({
      type: 'discovery',
      discoveryOrigin: 'https://ignored.example',
      discoveryKind: 'llms-txt',
      discoveryUrl: 'https://ignored.example/llms.txt',
      discoverySource: 'live-navigation',
      timestamp: 't',
      body: {},
    });
    manager.emitEvent({
      type: 'discovery',
      discoveryOrigin: 'https://archive.example',
      discoveryKind: 'llms-txt',
      discoveryUrl: 'https://archive.example/llms.txt',
      timestamp: 't',
      body: { source: 'archived transcript' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('suppresses ignored discovery received through follower forwarding', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.setDiscoveryIgnore((event) => event.discoveryOrigin === 'https://ignored.example');
    manager.handleForwardedEvent({
      type: 'discovery',
      discoveryOrigin: 'https://ignored.example',
      discoveryKind: 'llms-txt',
      discoveryUrl: 'https://ignored.example/llms.txt',
      discoverySource: 'live-navigation',
      timestamp: 't',
      body: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handleForwardedEvent suppresses a repeated discovery forward with the same artifact identity', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    const discovery = (): LickEvent => ({
      type: 'discovery',
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'llms-txt',
      discoveryUrl: 'https://example.com/llms.txt',
      discoverySource: 'live-navigation',
      timestamp: 't',
      body: {},
    });
    manager.handleForwardedEvent(discovery());
    manager.handleForwardedEvent(discovery());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handleForwardedEvent suppresses a repeated navigate forward with the same payload', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    const handoff = (): LickEvent => ({
      type: 'navigate',
      navigateUrl: 'https://www.sliccy.ai/handoff',
      timestamp: 't',
      body: { verb: 'handoff', target: 'do the thing' },
    });
    manager.handleForwardedEvent(handoff());
    manager.handleForwardedEvent(handoff());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handleForwardedEvent lets an unfingerprintable navigate forward through every time', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.handleForwardedEvent(navEvent());
    manager.handleForwardedEvent(navEvent());
    expect(handler).toHaveBeenCalledTimes(2);
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
      discoverySource: 'live-navigation',
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

/**
 * #2524 — the dispatch side. `handleWebhookEvent` now NAMES what became of a
 * delivery, because its receivers (the tray worker, the node-server bridge) hold
 * the caller's HTTP request open and used to answer every outcome with success.
 */
describe('LickManager webhook delivery disposition (#2524)', () => {
  let manager: LickManager;

  beforeEach(() => {
    manager = new LickManager();
    manager.setEventHandler(vi.fn());
  });

  it('reports `delivered` and dispatches when the target resolves', async () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.setUnitRosterProvider(() => [{ name: 'Cone', folder: 'cone' }]);
    const wh = await manager.createWebhook('resolvable', 'cone');

    expect(manager.handleWebhookEvent(wh.id, {}, { probe: 1 })).toBe('delivered');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports `unresolved-target` and wakes nobody when the target is gone', async () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    manager.setUnitRosterProvider(() => [{ name: 'Cone', folder: 'cone' }]);
    const wh = await manager.createWebhook('ghost', 'ghost-cone-does-not-exist');

    expect(manager.handleWebhookEvent(wh.id, {}, { probe: 1 })).toBe('unresolved-target');
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports `unknown-webhook` for an id it has never seen', () => {
    expect(manager.handleWebhookEvent('nope', {}, {})).toBe('unknown-webhook');
  });

  it('reports `filtered` when the webhook filter drops the event', async () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);
    const wh = await manager.createWebhook('picky', 'cone', '() => false');

    expect(manager.handleWebhookEvent(wh.id, {}, {})).toBe('filtered');
    expect(handler).not.toHaveBeenCalled();
  });

  // No roster injected: the manager cannot know whether the target resolves, and
  // must not claim a drop it has no evidence for.
  it('reports `delivered` for any target while no roster is wired', async () => {
    const wh = await manager.createWebhook('unverifiable', 'ghost-cone-does-not-exist');
    expect(manager.handleWebhookEvent(wh.id, {}, {})).toBe('delivered');
  });

  it('resolves a target against the roster by name and by bare scoop alias', () => {
    manager.setUnitRosterProvider(() => [
      { name: 'Research', folder: 'cone-research' },
      { name: 'code-reviewer', folder: 'reviewer-scoop' },
    ]);
    for (const target of ['cone-research', 'Research', 'reviewer-scoop', 'reviewer']) {
      expect(manager.resolveLickTarget(target).status).toBe('resolved');
    }
    const missing = manager.resolveLickTarget('ghost');
    expect(missing.status).toBe('unresolved');
    expect(missing).toMatchObject({ candidates: expect.arrayContaining(['cone-research']) });
  });

  it('reports `unverifiable` before a roster is injected', () => {
    expect(manager.resolveLickTarget('anything')).toEqual({ status: 'unverifiable' });
  });
});
