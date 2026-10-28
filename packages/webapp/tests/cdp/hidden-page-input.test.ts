import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import { CommandAbortedError } from '../../src/cdp/command-abort.js';
import { hiddenPagePointerKind, pageScrollExpression } from '../../src/cdp/hidden-page-input.js';
import { fakeHiddenTab } from '../helpers/fake-hidden-tab.js';

afterEach(() => {
  vi.useRealTimers();
});

const move = (x: number, y: number) => ({ type: 'mouseMoved', x, y });

/** Let the gate's chained promises run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('hiddenPagePointerKind', () => {
  it('picks out moves and wheels and nothing else', () => {
    expect(hiddenPagePointerKind('Input.dispatchMouseEvent', { type: 'mouseMoved' })).toBe('move');
    expect(hiddenPagePointerKind('Input.dispatchMouseEvent', { type: 'mouseWheel' })).toBe('wheel');
    expect(hiddenPagePointerKind('Input.dispatchMouseEvent', { type: 'mousePressed' })).toBeNull();
    expect(hiddenPagePointerKind('Input.dispatchMouseEvent', undefined)).toBeNull();
    expect(hiddenPagePointerKind('Input.dispatchKeyEvent', { type: 'mouseMoved' })).toBeNull();
  });
});

describe('pageScrollExpression', () => {
  it('scrolls the element under the point by the wheel deltas', () => {
    const expression = pageScrollExpression(40, 50, 0, 600);
    expect(expression).toContain('elementFromPoint(40, 50)');
    expect(expression).toContain('dy = 600');
    expect(expression).toContain('scrollBy');
  });
});

describe('pointer input on a hidden tab', () => {
  it('holds focus emulation for a whole drag: one enable, one restore', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', async (page) => {
      await page.send('Input.dispatchMouseEvent', move(1, 1));
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
      await page.send('Input.dispatchMouseEvent', move(9, 9));
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 9, y: 9 });
    });
    expect(tab.steps()).toEqual([
      'probe',
      'emulate:true',
      'mouseMoved',
      'mousePressed',
      'mouseMoved',
      'mouseReleased',
      'emulate:false',
    ]);
    // The page never lost focus or visibility mid-gesture.
    expect(tab.timeline).toEqual([
      'visible',
      'focus',
      'mouseMoved',
      'mousePressed',
      'mouseMoved',
      'mouseReleased',
      'hidden',
      'blur',
    ]);
    expect(tab.page.slowMoves).toBe(0);
  });

  it.each([
    ['unfocused', false],
    ['focused', true],
  ])('leaves a visible, %s page alone', async (_label, focused) => {
    const tab = fakeHiddenTab({ visible: true, focused });
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) => page.mouseWheel(4, 5, 0, 10));
    expect(tab.steps()).toEqual(['probe', 'mouseWheel']);
    expect(tab.timeline).toEqual(['mouseWheel']);
  });

  it('restores focus emulation when the move fails', async () => {
    const tab = fakeHiddenTab();
    tab.failNext('mouseMoved', 'CDP command timed out: Input.dispatchMouseEvent');
    const api = new BrowserAPI(tab.client);
    await expect(
      api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 2)))
    ).rejects.toThrow('timed out');
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseMoved', 'emulate:false']);
    expect(tab.shown()).toBe(false);
  });

  it('restores focus emulation when the command is aborted mid-drag', async () => {
    const controller = new AbortController();
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const pausedMove = tab.pause('mouseMoved');
    const run = api.withTab(
      't1',
      async (page) => {
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
        await page.send('Input.dispatchMouseEvent', move(9, 9));
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 9, y: 9 });
      },
      { signal: controller.signal }
    );
    await pausedMove.reached;
    controller.abort();
    pausedMove.release();
    await expect(run).rejects.toBeInstanceOf(CommandAbortedError);
    expect(tab.steps()).toEqual([
      'mousePressed',
      'probe',
      'emulate:true',
      'mouseMoved',
      'emulate:false',
    ]);
  });

  it('replays a move whose session died before anything landed', async () => {
    const tab = fakeHiddenTab();
    tab.failNext('mouseMoved', 'Session with given id not found');
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 2)));
    // The gate's own sends are not changes to the page the replay guard keeps.
    expect(tab.steps({ withSession: true }).filter((s) => s.endsWith('mouseMoved'))).toEqual([
      'sess-1:mouseMoved',
      'sess-2:mouseMoved',
    ]);
    expect(tab.shown()).toBe(false);
  });

  it('turns the wheel for real and keeps emulation until the frame that applies it', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const applied = await api.withTab('t1', (page) => page.mouseWheel(10, 20, 0, 300));
    expect(applied).toBe('wheel');
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseWheel', 'settle', 'emulate:false']);
    expect(tab.page.scrollY).toBe(300);
    const wheel = tab.calls.find((c) => c.method === 'Input.dispatchMouseEvent');
    expect(wheel?.params).toEqual({
      type: 'mouseWheel',
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: 300,
      modifiers: 0,
    });
  });

  it('does not report a wheel the hidden tab never drew as delivered', async () => {
    const tab = fakeHiddenTab({ framesStall: true });
    const api = new BrowserAPI(tab.client);
    await expect(api.withTab('t1', (page) => page.mouseWheel(10, 20, 0, 300))).rejects.toThrow(
      /drew no frame/
    );
    // Not replayed as a page scroll either: the wheel may still land.
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseWheel', 'settle', 'emulate:false']);
  });

  it('scrolls from the page when the connection cannot emulate focus', async () => {
    const tab = fakeHiddenTab({ emulation: false });
    const api = new BrowserAPI(tab.client);
    const applied = await api.withTab('t1', (page) => page.mouseWheel(40, 50, 0, 600));
    expect(applied).toBe('page-scroll');
    // The wheel Chrome would never answer is not sent at all.
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'page-scroll']);
    const scroll = tab.calls.find((c) => c.step === 'page-scroll');
    expect(String(scroll?.params['expression'])).toContain('elementFromPoint(40, 50)');
  });

  it('fails instead of reporting a scroll when the page-side scroll throws', async () => {
    const tab = fakeHiddenTab({
      emulation: false,
      scroll: {
        exceptionDetails: { text: 'Uncaught', exception: { description: 'EvalError: blocked' } },
      },
    });
    const api = new BrowserAPI(tab.client);
    await expect(api.withTab('t1', (page) => page.mouseWheel(1, 1, 0, 100))).rejects.toThrow(
      'Page scroll failed: EvalError: blocked'
    );
  });

  it('treats a page it cannot probe as hidden: the wheel scrolls from the page', async () => {
    const tab = fakeHiddenTab({ probeError: 'Cannot find context with specified id' });
    const api = new BrowserAPI(tab.client);
    const applied = await api.withTab('t1', (page) => page.mouseWheel(1, 1, 0, 100));
    expect(applied).toBe('page-scroll');
    expect(tab.calls.some((c) => c.step === 'mouseWheel')).toBe(false);
    expect(tab.shown()).toBe(false);
  });

  it('treats a page it cannot probe as hidden: a move gets emulation', async () => {
    const tab = fakeHiddenTab({ probeError: 'slicc: refused: execution context not seen yet' });
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 1)));
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseMoved', 'emulate:false']);
    expect(tab.page.slowMoves).toBe(0);
  });

  it('shares one hold between two sessions on the same tab', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    // A second session on t1 through the facade, as a tray leader attaches.
    const { sessionId: second } = (await raw.send('Target.attachToTarget', {
      targetId: 't1',
      flatten: true,
    })) as { sessionId: string };
    const firstMove = tab.pause('mouseMoved', 'sess-2');
    const secondMove = tab.pause('mouseMoved', second);
    let other: Promise<unknown> | undefined;
    await api.withTab('t1', async (page) => {
      const mine = page.send('Input.dispatchMouseEvent', move(1, 1));
      await firstMove.reached;
      // The second session moves while the first one's move is on the wire:
      // the page reads visible only because of the first session's emulation.
      other = raw.send('Input.dispatchMouseEvent', move(5, 5), second);
      await secondMove.reached;
      firstMove.release();
      await mine;
    });
    // The body ended with the second session's move still on the wire: the
    // page stays shown for it.
    expect(tab.shown()).toBe(true);
    secondMove.release();
    vi.useFakeTimers();
    await other;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tab.page.slowMoves).toBe(0);
    expect(tab.steps({ withSession: true })).toEqual([
      'sess-2:probe',
      'sess-2:emulate:true',
      'sess-2:mouseMoved',
      'sess-1:mouseMoved',
      'sess-2:emulate:false',
    ]);
    expect(tab.shown()).toBe(false);
  });

  it('lands a caller’s own enable after a restore that was in flight, and leaves it on', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    const restore = tab.pause('emulate:false');
    const body = api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 1)));
    await restore.reached;
    // The caller turns emulation on for the same session while the gate's
    // restore is still on the wire.
    const enabled = raw.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 'sess-1');
    await flush();
    restore.release();
    await Promise.all([body, enabled]);
    expect(tab.steps().filter((s) => s.startsWith('emulate'))).toEqual([
      'emulate:true',
      'emulate:false',
      'emulate:true',
    ]);
    expect(tab.shown()).toBe(true);
    // The caller shows the page, so its wheel is answered.
    await expect(
      raw.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 1, deltaY: 5 }, 'sess-1')
    ).resolves.toEqual({});
  });

  it('retries a restore that failed on a live session on the next hold', async () => {
    const tab = fakeHiddenTab();
    tab.failNext('emulate:false', 'CDP command timed out: Emulation.setFocusEmulationEnabled');
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 1)));
    // Left on: the page still reads visible and focused.
    expect(tab.shown()).toBe(true);
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(2, 2)));
    expect(tab.steps().slice(4)).toEqual([
      'emulate:false',
      'probe',
      'emulate:true',
      'mouseMoved',
      'emulate:false',
    ]);
    expect(tab.shown()).toBe(false);
  });

  it('does not retry a restore whose session is gone', async () => {
    const tab = fakeHiddenTab();
    tab.failNext('emulate:false', 'Session with given id not found');
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 1)));
    tab.page.capturers.clear();
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(2, 2)));
    expect(tab.steps().slice(4)).toEqual(['probe', 'emulate:true', 'mouseMoved', 'emulate:false']);
  });

  it('gates a session whose caller’s own enable failed', async () => {
    vi.useFakeTimers();
    const tab = fakeHiddenTab();
    tab.failNext('emulate:true', 'Internal error');
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    await expect(
      raw.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 'sess-x')
    ).rejects.toThrow('Internal error');
    await raw.send('Input.dispatchMouseEvent', move(1, 1), 'sess-x');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tab.steps()).toEqual([
      'emulate:true',
      'probe',
      'emulate:true',
      'mouseMoved',
      'emulate:false',
    ]);
    expect(tab.page.slowMoves).toBe(0);
  });

  it('leaves input alone on a session whose caller shows the page itself', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    await raw.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 'leader');
    await raw.send('Input.dispatchMouseEvent', move(1, 1), 'leader');
    await raw.send('Emulation.setFocusEmulationEnabled', { enabled: false }, 'leader');
    expect(tab.steps()).toEqual(['emulate:true', 'mouseMoved', 'emulate:false']);
  });

  it('gives a page another session shows its own emulation', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    const { sessionId: leader } = (await raw.send('Target.attachToTarget', {
      targetId: 't1',
      flatten: true,
    })) as { sessionId: string };
    await raw.send('Emulation.setFocusEmulationEnabled', { enabled: true }, leader);
    await api.withTab('t1', async (page) => {
      await page.send('Input.dispatchMouseEvent', move(1, 1));
      // The leader is done with its own gesture while this one runs.
      await raw.send('Emulation.setFocusEmulationEnabled', { enabled: false }, leader);
      await page.send('Input.dispatchMouseEvent', move(2, 2));
    });
    expect(tab.steps({ withSession: true })).toEqual([
      'sess-1:emulate:true',
      'sess-2:probe',
      'sess-2:emulate:true',
      'sess-2:mouseMoved',
      'sess-1:emulate:false',
      // One focus flag per tab: the leader's off blurred the page, so it is
      // shown again for the rest of the gesture.
      'sess-2:emulate:true',
      'sess-2:mouseMoved',
      'sess-2:emulate:false',
    ]);
    expect(tab.page.slowMoves).toBe(0);
    expect(tab.shown()).toBe(false);
  });

  it('shows the page again when a caller turns emulation off mid-gesture', async () => {
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    await api.withTab('t1', async (page) => {
      await page.send('Input.dispatchMouseEvent', move(1, 1));
      await raw.send('Emulation.setFocusEmulationEnabled', { enabled: false }, 'sess-1');
      await page.send('Input.dispatchMouseEvent', move(2, 2));
    });
    expect(tab.steps()).toEqual([
      'probe',
      'emulate:true',
      'mouseMoved',
      'emulate:false',
      'emulate:true',
      'mouseMoved',
      'emulate:false',
    ]);
    expect(tab.page.slowMoves).toBe(0);
    expect(tab.shown()).toBe(false);
  });

  it('holds emulation across raw sends outside a withTab body until the pointer is idle', async () => {
    vi.useFakeTimers();
    const tab = fakeHiddenTab();
    const api = new BrowserAPI(tab.client);
    const raw = api.getTransport();
    await raw.send('Input.dispatchMouseEvent', move(1, 1), 'sess-x');
    await raw.send('Input.dispatchMouseEvent', move(2, 2), 'sess-x');
    expect(tab.shown()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tab.steps()).toEqual([
      'probe',
      'emulate:true',
      'mouseMoved',
      'mouseMoved',
      'emulate:false',
    ]);
    expect(tab.shown()).toBe(false);
  });

  it('forgets what a detached session owed', async () => {
    const tab = fakeHiddenTab();
    tab.failNext('emulate:false', 'CDP command timed out');
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(1, 1)));
    tab.detach('sess-1');
    await api.withTab('t1', (page) => page.send('Input.dispatchMouseEvent', move(2, 2)));
    // No retry on the dead session; the fresh one probes from scratch.
    expect(tab.steps({ withSession: true }).slice(4)).toEqual([
      'sess-2:probe',
      'sess-2:emulate:true',
      'sess-2:mouseMoved',
      'sess-2:emulate:false',
    ]);
  });
});
