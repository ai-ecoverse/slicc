import type { CDPPayload } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import { CommandAbortedError } from '../../src/cdp/command-abort.js';
import {
  HiddenPageInput,
  HiddenPageWheelError,
  hiddenPagePointerKind,
  pageScrollExpression,
} from '../../src/cdp/hidden-page-input.js';
import type { CDPTransport } from '../../src/cdp/transport.js';

type Call = { method: string; params: CDPPayload; sessionId: string; timeout?: number };

/**
 * A fake transport send over one page. `visibility` is what the page reports;
 * `failEmulation` makes `Emulation.setFocusEmulationEnabled` reject, as a
 * connection without it does. Settle and other evaluates resolve at once.
 */
function fakePage(opts: {
  visibility?: string;
  failEmulation?: boolean;
  failProbe?: boolean;
  failRestore?: boolean;
}) {
  const calls: Call[] = [];
  const send = async (
    method: string,
    params: CDPPayload,
    sessionId: string,
    timeout?: number
  ): Promise<CDPPayload> => {
    calls.push({ method, params, sessionId, ...(timeout !== undefined ? { timeout } : {}) });
    if (method === 'Runtime.evaluate' && params['expression'] === 'document.visibilityState') {
      if (opts.failProbe) throw new Error('probe failed');
      return { result: { value: opts.visibility ?? 'visible' } };
    }
    if (method === 'Emulation.setFocusEmulationEnabled') {
      if (params['enabled'] === true && opts.failEmulation)
        throw new Error("'Emulation' not found");
      if (params['enabled'] === false && opts.failRestore) throw new Error('Target closed');
    }
    return {};
  };
  const steps = (): string[] =>
    calls.map((c) => {
      if (c.method === 'Emulation.setFocusEmulationEnabled')
        return `emulate:${c.params['enabled']}`;
      if (c.method === 'Runtime.evaluate') {
        return c.params['expression'] === 'document.visibilityState' ? 'probe' : 'settle';
      }
      return c.method;
    });
  return { calls, send, steps };
}

/** One input step, recorded into the same log as the gate's own sends. */
function input(page: ReturnType<typeof fakePage>, result: CDPPayload = {}) {
  return async (): Promise<CDPPayload> => {
    page.calls.push({ method: 'input', params: {}, sessionId: 's1' });
    return result;
  };
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

describe('HiddenPageInput', () => {
  it('sends input on a visible page without touching focus emulation', async () => {
    const page = fakePage({ visibility: 'visible' });
    const gate = new HiddenPageInput(page.send);
    await expect(gate.run('s1', 'move', input(page, { ok: 1 }))).resolves.toEqual({ ok: 1 });
    expect(page.steps()).toEqual(['probe', 'input']);
  });

  it('holds focus emulation around a move on a hidden page, then restores it', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    await gate.run('s1', 'move', input(page));
    expect(page.steps()).toEqual(['probe', 'emulate:true', 'input', 'settle', 'emulate:false']);
    expect(page.calls.every((c) => c.sessionId === 's1')).toBe(true);
  });

  it('keeps emulation on until the page has drawn the frame that handles a wheel', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    await gate.run('s1', 'wheel', input(page));
    expect(page.steps()).toEqual(['probe', 'emulate:true', 'input', 'settle', 'emulate:false']);
    const settle = page.calls.find((c) => c.method === 'Runtime.evaluate' && c.timeout);
    expect(String(settle?.params['expression'])).toContain('requestAnimationFrame');
    expect(settle?.params['awaitPromise']).toBe(true);
    expect(settle?.timeout).toBeGreaterThan(0);
  });

  it('restores focus emulation when the input fails, and rethrows', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    await expect(
      gate.run('s1', 'move', async () => {
        page.calls.push({ method: 'input', params: {}, sessionId: 's1' });
        throw new Error('CDP command timed out');
      })
    ).rejects.toThrow('CDP command timed out');
    expect(page.steps()).toEqual(['probe', 'emulate:true', 'input', 'emulate:false']);
  });

  it('returns the input result when restoring fails', async () => {
    const page = fakePage({ visibility: 'hidden', failRestore: true });
    const gate = new HiddenPageInput(page.send);
    await expect(gate.run('s1', 'move', input(page, { ok: 2 }))).resolves.toEqual({ ok: 2 });
    expect(page.steps().at(-1)).toBe('emulate:false');
  });

  it('still sends a move when the connection cannot emulate focus', async () => {
    const page = fakePage({ visibility: 'hidden', failEmulation: true });
    const gate = new HiddenPageInput(page.send);
    await gate.run('s1', 'move', input(page));
    expect(page.steps()).toEqual(['probe', 'emulate:true', 'input']);
  });

  it('refuses a wheel Chrome would never answer instead of sending it', async () => {
    const page = fakePage({ visibility: 'hidden', failEmulation: true });
    const gate = new HiddenPageInput(page.send);
    await expect(gate.run('s1', 'wheel', input(page))).rejects.toBeInstanceOf(HiddenPageWheelError);
    expect(page.steps()).toEqual(['probe', 'emulate:true']);
  });

  it('sends input as is when the visibility probe fails', async () => {
    const page = fakePage({ failProbe: true });
    const gate = new HiddenPageInput(page.send);
    await gate.run('s1', 'wheel', input(page));
    expect(page.steps()).toEqual(['probe', 'input']);
  });

  it('leaves a caller’s own focus emulation alone', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    gate.noteExplicit('s1', true);
    await gate.run('s1', 'move', input(page));
    expect(page.steps()).toEqual(['input']);
    gate.noteExplicit('s1', false);
    await gate.run('s1', 'move', input(page));
    expect(page.steps().slice(1)).toEqual([
      'probe',
      'emulate:true',
      'input',
      'settle',
      'emulate:false',
    ]);
  });

  it('does not turn off emulation a caller turned on while a hold was open', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    await gate.run('s1', 'move', async () => {
      gate.noteExplicit('s1', true);
      return {};
    });
    expect(page.steps()).toEqual(['probe', 'emulate:true', 'settle']);
  });

  it('shares one enable and one restore between overlapping input on a session', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    let releaseFirst!: () => void;
    const first = gate.run(
      's1',
      'move',
      () =>
        new Promise<CDPPayload>((resolve) => {
          releaseFirst = () => resolve({});
        })
    );
    const second = gate.run('s1', 'move', input(page));
    await second;
    // The second input finished while the first is still out: emulation stays.
    expect(page.steps()).toEqual(['probe', 'emulate:true', 'input', 'settle']);
    releaseFirst();
    await first;
    expect(page.steps().filter((s) => s.startsWith('emulate'))).toEqual([
      'emulate:true',
      'emulate:false',
    ]);
  });

  it('waits for a restore in flight before probing the next hold', async () => {
    const calls: string[] = [];
    let finishRestore!: () => void;
    const gate = new HiddenPageInput(async (method, params) => {
      if (method === 'Emulation.setFocusEmulationEnabled') {
        calls.push(`emulate:${params['enabled']}`);
        if (params['enabled'] === false && !finishRestore) {
          await new Promise<void>((resolve) => {
            finishRestore = resolve;
          });
        }
        return {};
      }
      if (params['expression'] === 'document.visibilityState') {
        calls.push('probe');
        return { result: { value: 'hidden' } };
      }
      return {};
    });
    const first = gate.run('s1', 'move', async () => ({}));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['probe', 'emulate:true', 'emulate:false']);
    const second = gate.run('s1', 'move', async () => ({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['probe', 'emulate:true', 'emulate:false']);
    finishRestore();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      'probe',
      'emulate:true',
      'emulate:false',
      'probe',
      'emulate:true',
      'emulate:false',
    ]);
  });

  it('keeps sessions apart', async () => {
    const page = fakePage({ visibility: 'hidden' });
    const gate = new HiddenPageInput(page.send);
    await Promise.all([
      gate.run('s1', 'move', async () => ({})),
      gate.run('s2', 'move', async () => ({})),
    ]);
    const enables = page.calls.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled');
    expect(enables.map((c) => `${c.sessionId}:${c.params['enabled']}`).sort()).toEqual([
      's1:false',
      's1:true',
      's2:false',
      's2:true',
    ]);
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

// ---------------------------------------------------------------------------
// Through BrowserAPI: the transport facade every command's input crosses
// ---------------------------------------------------------------------------

type SessionCall = { method: string; params: CDPPayload; sessionId?: string };

/**
 * A connection to one hidden tab. `emulation: false` stands for a transport
 * without `Emulation.setFocusEmulationEnabled`; `input` overrides how a
 * pointer dispatch is answered (a hidden tab without emulation never answers
 * a wheel, which `stallWheel` models as a rejection so old code fails fast).
 */
function hiddenTabClient(opts: {
  emulation?: boolean;
  input?: (params: CDPPayload, sessionId?: string) => Promise<CDPPayload>;
  scroll?: CDPPayload;
}) {
  const calls: SessionCall[] = [];
  let sessions = 0;
  let emulated = false;
  const send = vi.fn(
    async (method: string, params: CDPPayload = {}, sessionId?: string): Promise<CDPPayload> => {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === 'Target.attachToTarget') return { sessionId: `sess-${++sessions}` };
      if (method === 'Emulation.setFocusEmulationEnabled') {
        if (opts.emulation === false)
          throw new Error("'Emulation.setFocusEmulationEnabled' wasn't found");
        emulated = params['enabled'] === true;
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params['expression']);
        if (expression === 'document.visibilityState') {
          return { result: { value: emulated ? 'visible' : 'hidden' } };
        }
        if (expression.includes('scrollBy')) return opts.scroll ?? { result: { value: true } };
        return { result: { value: true } };
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (opts.input) return opts.input(params, sessionId);
        if (!emulated && params['type'] === 'mouseWheel') {
          throw new Error('CDP command timed out: Input.dispatchMouseEvent');
        }
        return {};
      }
      return {};
    }
  );
  const client = {
    state: 'connected' as const,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    send,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(async () => ({})),
  } as unknown as CDPTransport;
  /** The page-session steps after attach, named the way the unit tests above name them. */
  const steps = (): string[] =>
    calls
      .filter((c) => c.sessionId && c.method !== 'Page.enable')
      .map((c) => {
        if (c.method === 'Emulation.setFocusEmulationEnabled')
          return `emulate:${c.params['enabled']}`;
        if (c.method === 'Runtime.evaluate') {
          const expression = String(c.params['expression']);
          if (expression === 'document.visibilityState') return 'probe';
          return expression.includes('scrollBy') ? 'page-scroll' : 'settle';
        }
        if (c.method === 'Input.dispatchMouseEvent') return String(c.params['type']);
        return c.method;
      });
  return { client, calls, steps };
}

describe('BrowserAPI pointer input on a hidden tab', () => {
  it('gives a raw mouseMoved focus emulation and takes it away again', async () => {
    const tab = hiddenTabClient({});
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', ({ transport, sessionId }) =>
      transport.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 5 }, sessionId)
    );
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseMoved', 'settle', 'emulate:false']);
    expect(tab.calls.filter((c) => c.sessionId).every((c) => c.sessionId === 'sess-1')).toBe(true);
  });

  it('holds emulation only around the move of a drag sent through the page API', async () => {
    const tab = hiddenTabClient({});
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', async (page) => {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 9, y: 9 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 9, y: 9 });
    });
    // Press and release are answered on a hidden tab; only the move is held.
    expect(tab.steps()).toEqual([
      'mousePressed',
      'probe',
      'emulate:true',
      'mouseMoved',
      'settle',
      'emulate:false',
      'mouseReleased',
    ]);
  });

  it('restores focus emulation when the move fails', async () => {
    const tab = hiddenTabClient({
      input: async () => {
        throw new Error('CDP command timed out: Input.dispatchMouseEvent');
      },
    });
    const api = new BrowserAPI(tab.client);
    await expect(
      api.withTab('t1', (page) =>
        page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 })
      )
    ).rejects.toThrow('timed out');
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseMoved', 'emulate:false']);
  });

  it('restores focus emulation when the command is aborted mid-drag', async () => {
    const controller = new AbortController();
    const tab = hiddenTabClient({
      input: async (params) => {
        // The caller gives up while the move is on the wire.
        if (params['type'] === 'mouseMoved') controller.abort();
        return {};
      },
    });
    const api = new BrowserAPI(tab.client);
    await expect(
      api.withTab(
        't1',
        async (page) => {
          await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 9, y: 9 });
          await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 9, y: 9 });
        },
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(CommandAbortedError);
    expect(tab.steps()).toEqual([
      'mousePressed',
      'probe',
      'emulate:true',
      'mouseMoved',
      'settle',
      'emulate:false',
    ]);
  });

  it('replays a move whose session died before anything landed', async () => {
    let moves = 0;
    const tab = hiddenTabClient({
      input: async (_params, sessionId) => {
        moves += 1;
        if (sessionId === 'sess-1') throw new Error('Session with given id not found');
        return {};
      },
    });
    const api = new BrowserAPI(tab.client);
    await api.withTab('t1', (page) =>
      page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 })
    );
    // Turning emulation on is not a change to the page the replay guard keeps.
    expect(moves).toBe(2);
    const last = tab.calls.filter((c) => c.sessionId === 'sess-2').map((c) => c.method);
    expect(last).toContain('Input.dispatchMouseEvent');
  });

  it('turns the wheel on a hidden tab for real under focus emulation', async () => {
    const tab = hiddenTabClient({});
    const api = new BrowserAPI(tab.client);
    const applied = await api.withTab('t1', (page) => page.mouseWheel(10, 20, 0, 300));
    expect(applied).toBe('wheel');
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'mouseWheel', 'settle', 'emulate:false']);
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

  it('scrolls from the page when the connection cannot emulate focus', async () => {
    const tab = hiddenTabClient({ emulation: false });
    const api = new BrowserAPI(tab.client);
    const applied = await api.withTab('t1', (page) => page.mouseWheel(40, 50, 0, 600));
    expect(applied).toBe('page-scroll');
    // The wheel Chrome would never answer is not sent at all.
    expect(tab.steps()).toEqual(['probe', 'emulate:true', 'page-scroll']);
    const scroll = tab.calls.find((c) => String(c.params['expression']).includes('scrollBy'));
    expect(String(scroll?.params['expression'])).toContain('elementFromPoint(40, 50)');
  });

  it('fails instead of reporting a scroll when the page-side scroll throws', async () => {
    const tab = hiddenTabClient({
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
});
