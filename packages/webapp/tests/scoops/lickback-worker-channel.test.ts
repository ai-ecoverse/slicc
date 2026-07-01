/**
 * The worker-realm lick-back rendezvous: the /licks-ws bridge registers the
 * socket push + delivers inbound replies; the OffscreenBridge registers the
 * page-ward reply forwarder + pushes outbound events. Both resolve the SAME
 * singleton via `getLickbackChannel()`, so wiring is order-independent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLickbackChannel,
  getLickbackChannel,
} from '../../src/scoops/lickback-worker-channel.js';

afterEach(() => __resetLickbackChannel());

describe('lickback-worker-channel', () => {
  it('returns the same singleton across calls', () => {
    expect(getLickbackChannel()).toBe(getLickbackChannel());
  });

  it('routes push() to the registered push impl', () => {
    const ch = getLickbackChannel();
    const push = vi.fn();
    ch.setPushImpl(push);
    ch.push('chat', { kind: 'chat', text: 'hi' });
    expect(push).toHaveBeenCalledWith('chat', { kind: 'chat', text: 'hi' });
  });

  it('drops push() when no impl is registered (no throw)', () => {
    const ch = getLickbackChannel();
    expect(() => ch.push('chat', {})).not.toThrow();
  });

  it('routes deliverReply() to the registered reply handler', () => {
    const ch = getLickbackChannel();
    const handler = vi.fn();
    ch.setReplyHandler(handler);
    ch.deliverReply({ channel: 'chat', replyTo: 'm1', delta: 'hi' });
    expect(handler).toHaveBeenCalledWith({ channel: 'chat', replyTo: 'm1', delta: 'hi' });
  });

  it('is order-independent: a reply handler set before the push impl still receives replies', () => {
    const ch = getLickbackChannel();
    const handler = vi.fn();
    ch.setReplyHandler(handler);
    ch.setPushImpl(vi.fn());
    ch.deliverReply({ channel: 'chat', replyTo: 'm1', done: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('clearing the impls makes push/deliver no-ops again', () => {
    const ch = getLickbackChannel();
    const push = vi.fn();
    const handler = vi.fn();
    ch.setPushImpl(push);
    ch.setReplyHandler(handler);
    ch.setPushImpl(null);
    ch.setReplyHandler(null);
    ch.push('chat', {});
    ch.deliverReply({ channel: 'chat', replyTo: 'm1' });
    expect(push).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
