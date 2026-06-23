import { describe, expect, it, vi } from 'vitest';
import type { LickEvent } from '../../src/scoops/lick-manager.js';

// Capture the onEvent NavigationWatcher is constructed with, and drive it.
let captured: ((e: unknown) => void) | null = null;
vi.mock('../../src/cdp/navigation-watcher.js', () => ({
  NavigationWatcher: class {
    onEvent: (e: unknown) => void;
    constructor(_t: unknown, onEvent: (e: unknown) => void) {
      this.onEvent = onEvent;
      captured = onEvent;
    }
    start() {}
    stop() {}
  },
}));

describe('startFollowerNavigateWatcher', () => {
  it('forwards a navigate lick built from the NavigationEvent to the current sync', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    captured!({
      url: 'https://x/',
      verb: 'handoff',
      target: 'https://x/',
      instruction: 'go',
      links: [],
      targetId: 't1',
    });
    expect(forwardLick).toHaveBeenCalledTimes(1);
    const lick = forwardLick.mock.calls[0]![0];
    expect(lick.type).toBe('navigate');
    expect(lick.navigateUrl).toBe('https://x/');
    const body = lick.body as Record<string, unknown>;
    expect(body.verb).toBe('handoff');
    expect(body.instruction).toBe('go');
  });

  it('omits branch/path/title/instruction from the body when undefined', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    const forwardLick = vi.fn((_event: LickEvent) => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    captured!({
      url: 'https://x/',
      verb: 'navigate',
      target: 'https://x/',
      links: [],
      targetId: 't1',
    });
    const body = forwardLick.mock.calls[0]![0].body as Record<string, unknown>;
    expect(body.url).toBe('https://x/');
    expect('instruction' in body).toBe(false);
    expect('branch' in body).toBe(false);
    expect('path' in body).toBe(false);
    expect('title' in body).toBe(false);
  });

  it('drops the event cleanly when no sync is connected', async () => {
    const { startFollowerNavigateWatcher } = await import(
      '../../src/ui/follower-navigate-watcher.js'
    );
    expect(() => {
      startFollowerNavigateWatcher({} as never, () => null);
      captured!({
        url: 'https://x/',
        verb: 'handoff',
        target: 'https://x/',
        links: [],
        targetId: 't1',
      });
    }).not.toThrow();
  });
});
