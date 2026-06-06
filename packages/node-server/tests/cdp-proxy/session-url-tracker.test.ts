import { describe, expect, it } from 'vitest';
import { createCdpSessionUrlTracker } from '../../src/cdp-proxy/session-url-tracker.js';

function frame(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

describe('createCdpSessionUrlTracker', () => {
  it('seeds session→url from Target.attachedToTarget', () => {
    const t = createCdpSessionUrlTracker();
    t.observeChromeToClient(
      frame({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'S1',
          targetInfo: { targetId: 'T1', type: 'page', url: 'https://example.com/login' },
        },
      })
    );
    expect(t.getUrl('S1')).toBe('https://example.com/login');
    expect(t.getHostname('S1')).toBe('example.com');
    expect(t.size()).toBe(1);
  });

  it('updates session→url from Page.frameNavigated for the root frame only', () => {
    const t = createCdpSessionUrlTracker();
    t.observeChromeToClient(
      frame({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'S1',
          targetInfo: { targetId: 'T1', type: 'page', url: 'about:blank' },
        },
      })
    );
    // Sub-frame nav must NOT change the per-tab url
    t.observeChromeToClient(
      frame({
        method: 'Page.frameNavigated',
        sessionId: 'S1',
        params: { frame: { id: 'F2', parentId: 'F1', url: 'https://tracker.example/sub' } },
      })
    );
    expect(t.getHostname('S1')).toBe(null); // about:blank → no hostname
    // Root nav updates it
    t.observeChromeToClient(
      frame({
        method: 'Page.frameNavigated',
        sessionId: 'S1',
        params: { frame: { id: 'F1', url: 'https://example.com/dashboard' } },
      })
    );
    expect(t.getHostname('S1')).toBe('example.com');
  });

  it('cascades Target.targetInfoChanged to every session pointing at that targetId', () => {
    const t = createCdpSessionUrlTracker();
    t.observeChromeToClient(
      frame({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'S1',
          targetInfo: { targetId: 'T1', type: 'page', url: 'https://a.example/' },
        },
      })
    );
    t.observeChromeToClient(
      frame({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { targetId: 'T1', url: 'https://b.example/page' } },
      })
    );
    expect(t.getHostname('S1')).toBe('b.example');
  });

  it('detached sessions are forgotten (fail-closed for later lookups)', () => {
    const t = createCdpSessionUrlTracker();
    t.observeChromeToClient(
      frame({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'S1',
          targetInfo: { targetId: 'T1', type: 'page', url: 'https://example.com/' },
        },
      })
    );
    t.observeChromeToClient(
      frame({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } })
    );
    expect(t.getHostname('S1')).toBe(null);
    expect(t.size()).toBe(0);
  });

  it('returns null hostname for unknown sessions and un-parseable URLs', () => {
    const t = createCdpSessionUrlTracker();
    expect(t.getHostname(undefined)).toBe(null);
    expect(t.getHostname('unknown-session')).toBe(null);
    t.observeChromeToClient(
      frame({
        method: 'Target.attachedToTarget',
        params: { sessionId: 'S1', targetInfo: { targetId: 'T1', type: 'page', url: '' } },
      })
    );
    expect(t.getHostname('S1')).toBe(null);
  });

  it('silently ignores malformed JSON and non-tracked methods', () => {
    const t = createCdpSessionUrlTracker();
    t.observeChromeToClient('not json{');
    t.observeChromeToClient(frame({ method: 'Runtime.consoleAPICalled', params: {} }));
    t.observeChromeToClient('');
    t.observeChromeToClient(null);
    t.observeChromeToClient(42);
    expect(t.size()).toBe(0);
  });

  it('accepts already-parsed frame objects as well as JSON strings', () => {
    const t = createCdpSessionUrlTracker();
    t.observeChromeToClient({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S1',
        targetInfo: { targetId: 'T1', type: 'page', url: 'https://example.com/' },
      },
    });
    expect(t.getHostname('S1')).toBe('example.com');
  });
});
