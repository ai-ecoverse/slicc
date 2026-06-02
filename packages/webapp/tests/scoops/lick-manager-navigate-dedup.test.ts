import { describe, expect, it, vi } from 'vitest';
import { type LickEvent, LickManager } from '../../src/scoops/lick-manager.js';

function navigateEvent(body: Record<string, unknown>): LickEvent {
  return {
    type: 'navigate',
    navigateUrl: typeof body.url === 'string' ? body.url : 'https://example.com/',
    timestamp: new Date().toISOString(),
    body,
  };
}

describe('LickManager navigate-lick dedup', () => {
  it('emits the first sighting of a handoff payload but drops repeats', () => {
    const manager = new LickManager();
    const handler = vi.fn();
    manager.setEventHandler(handler);

    const payload = { verb: 'upskill', target: 'https://github.com/o/r' };
    // Same payload, advertised on three different page URLs across a site.
    manager.emitEvent(navigateEvent({ ...payload, url: 'https://aem.live/' }));
    manager.emitEvent(navigateEvent({ ...payload, url: 'https://aem.live/docs' }));
    manager.emitEvent(navigateEvent({ ...payload, url: 'https://aem.live/tools' }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('treats different payloads as distinct even on the same URL', () => {
    const manager = new LickManager();
    const handler = vi.fn();
    manager.setEventHandler(handler);

    const url = 'https://aem.live/';
    manager.emitEvent(navigateEvent({ verb: 'upskill', target: 'https://github.com/o/r', url }));
    manager.emitEvent(
      navigateEvent({ verb: 'upskill', target: 'https://github.com/o/r', branch: 'next', url })
    );
    manager.emitEvent(navigateEvent({ verb: 'handoff', target: url, instruction: 'sign in', url }));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('does not dedup malformed navigate bodies lacking verb/target', () => {
    const manager = new LickManager();
    const handler = vi.fn();
    manager.setEventHandler(handler);

    manager.emitEvent(navigateEvent({ url: 'https://aem.live/' }));
    manager.emitEvent(navigateEvent({ url: 'https://aem.live/' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not dedup non-navigate events', () => {
    const manager = new LickManager();
    const handler = vi.fn();
    manager.setEventHandler(handler);

    const webhook: LickEvent = {
      type: 'webhook',
      webhookId: 'w1',
      webhookName: 'hook',
      timestamp: new Date().toISOString(),
      body: { verb: 'upskill', target: 'https://github.com/o/r' },
    };
    manager.emitEvent(webhook);
    manager.emitEvent(webhook);

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
