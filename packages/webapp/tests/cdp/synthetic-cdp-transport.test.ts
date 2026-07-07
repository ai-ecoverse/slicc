import { describe, expect, it } from 'vitest';
import { SyntheticCdpTransport } from '../../src/cdp/synthetic-cdp-transport.js';

/**
 * Trivial subclass with a stub forward that forwards real methods.
 */
class TestTransport extends SyntheticCdpTransport {
  public forwarded: Array<[string, any, string | undefined, number | undefined]> = [];
  public closeTargetCalls = 0;

  async connect(): Promise<void> {
    this._state = 'connected';
  }

  disconnect(): void {
    this._state = 'disconnected';
  }

  protected override onCloseTarget(): void {
    this.closeTargetCalls += 1;
  }

  protected async forward(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: number
  ): Promise<Record<string, unknown>> {
    this.forwarded.push([method, params, sessionId, timeout]);
    return { ok: true };
  }
}

describe('SyntheticCdpTransport', () => {
  it('synthesizes lifecycle from injected metadata and forwards real methods', async () => {
    const t = new TestTransport({
      targetUrl: 'https://x.sliccy.now/',
      targetOrigin: 'https://x.sliccy.now',
      title: 'Preview',
    });
    await t.connect();

    // Synthetic Target.getTargets should use the injected metadata
    const targets = await t.send('Target.getTargets');
    expect((targets.targetInfos as any[])[0].url).toBe('https://x.sliccy.now/');
    expect((targets.targetInfos as any[])[0].title).toBe('Preview');

    // Real methods should be forwarded
    await t.send('Runtime.evaluate', { expression: '1' });
    expect(t.forwarded).toContainEqual(['Runtime.evaluate', { expression: '1' }, undefined, 30000]);
  });

  it('uses custom synthetic ids when provided', async () => {
    const t = new TestTransport({
      targetUrl: 'https://test.local/',
      targetOrigin: 'https://test.local',
      title: 'Custom',
      ids: {
        target: 'custom-target',
        session: 'custom-session',
        frame: 'custom-frame',
        loader: 'custom-loader',
      },
    });
    await t.connect();

    const targets = await t.send('Target.getTargets');
    expect((targets.targetInfos as any[])[0].targetId).toBe('custom-target');

    const session = await t.send('Target.attachToTarget', { targetId: 'custom-target' });
    expect(session.sessionId).toBe('custom-session');

    const frameTree = (await t.send('Page.getFrameTree')) as {
      frameTree: { frame: { id: string; loaderId?: string; url?: string } };
    };
    expect(frameTree.frameTree.frame.id).toBe('custom-frame');
    expect(frameTree.frameTree.frame.loaderId).toBe('custom-loader');
  });

  it('uses default cherry-* ids when none provided', async () => {
    const t = new TestTransport({
      targetUrl: 'https://test.local/',
      targetOrigin: 'https://test.local',
      title: 'Default',
    });
    await t.connect();

    const targets = await t.send('Target.getTargets');
    expect((targets.targetInfos as any[])[0].targetId).toBe('cherry-target');
  });

  it('emits frameNavigated + loadEventFired after Page.navigate', async () => {
    const t = new TestTransport({
      targetUrl: 'https://test.local/',
      targetOrigin: 'https://test.local',
      title: 'Nav Test',
    });
    await t.connect();

    const events: string[] = [];
    t.on('Page.frameNavigated', () => events.push('frameNavigated'));
    t.on('Page.loadEventFired', () => events.push('loadEventFired'));

    await t.send('Page.navigate', { url: 'https://test.local/next' });

    expect(events).toEqual(['frameNavigated', 'loadEventFired']);
  });

  it('advances the reported URL after Page.navigate (no stale construction URL)', async () => {
    const t = new TestTransport({
      targetUrl: 'https://x.local/',
      targetOrigin: 'https://x.local',
      title: 'Nav URL',
    });
    await t.connect();

    await t.send('Page.navigate', { url: 'https://x.local/next' });

    const targets = await t.send('Target.getTargets');
    expect((targets.targetInfos as any[])[0].url).toBe('https://x.local/next');
    const frameTree = (await t.send('Page.getFrameTree')) as {
      frameTree: { frame: { id: string; loaderId?: string; url?: string } };
    };
    expect(frameTree.frameTree.frame.url).toBe('https://x.local/next');
  });

  it('invokes the onCloseTarget hook on Target.closeTarget', async () => {
    const t = new TestTransport({
      targetUrl: 'https://x.local/',
      targetOrigin: 'https://x.local',
      title: 'Close',
    });
    await t.connect();

    const res = await t.send('Target.closeTarget', { targetId: 'x' });
    expect(res.success).toBe(true);
    expect(t.closeTargetCalls).toBe(1);
    // Detach must NOT trigger the close hook.
    await t.send('Target.detachFromTarget', { sessionId: 's' });
    expect(t.closeTargetCalls).toBe(1);
  });

  it('threads timeout through to forward', async () => {
    const t = new TestTransport({
      targetUrl: 'https://test.local/',
      targetOrigin: 'https://test.local',
      title: 'Timeout Test',
    });
    await t.connect();

    await t.send('Runtime.evaluate', { expression: '1' }, undefined, 5000);
    expect(t.forwarded).toContainEqual(['Runtime.evaluate', { expression: '1' }, undefined, 5000]);
  });
});
