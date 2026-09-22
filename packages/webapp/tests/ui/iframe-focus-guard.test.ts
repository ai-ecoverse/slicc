import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { iframeFocusGuardSource } from '../../src/ui/iframe-focus-guard.js';

function frame(): {
  win: Window & typeof globalThis;
  state: { hasFocus: boolean; active: boolean };
} {
  const dom = new JSDOM('<!doctype html><html><body><input id="x"><input id="y"></body></html>', {
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const state = { hasFocus: false, active: false };
  win.document.hasFocus = () => state.hasFocus;
  Object.defineProperty(win.navigator, 'userActivation', {
    configurable: true,
    get: () => ({ isActive: state.active, hasBeenActive: state.active }),
  });
  (win as unknown as { eval(src: string): void }).eval(iframeFocusGuardSource);
  return { win, state };
}

describe('iframeFocusGuardSource', () => {
  let win: Window & typeof globalThis;
  let state: { hasFocus: boolean; active: boolean };

  beforeEach(() => {
    ({ win, state } = frame());
  });

  it('ignores el.focus() from a frame nobody is using — the agent-opened sprinkle case', () => {
    win.document.getElementById('x')!.focus();
    expect(win.document.activeElement).toBe(win.document.body);
  });

  it('honours el.focus() once the frame already holds the focus', () => {
    state.hasFocus = true;
    win.document.getElementById('y')!.focus();
    expect(win.document.activeElement?.id).toBe('y');
  });

  it('ignores el.focus() even when the frame reads as user-activated', () => {
    state.active = true;
    win.document.getElementById('x')!.focus();
    expect(win.document.activeElement).toBe(win.document.body);
  });

  it('guards window.focus() the same way', () => {
    let calls = 0;

    const { win: w, state: s } = (() => {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
      });
      const inner = dom.window as unknown as Window & typeof globalThis;
      const st = { hasFocus: false, active: false };
      inner.document.hasFocus = () => st.hasFocus;
      inner.focus = () => {
        calls++;
      };
      (inner as unknown as { eval(src: string): void }).eval(iframeFocusGuardSource);
      return { win: inner, state: st };
    })();
    w.focus();
    expect(calls).toBe(0);
    s.hasFocus = true;
    w.focus();
    expect(calls).toBe(1);
  });

  it('treats a throwing hasFocus() as "not focused"', () => {
    win.document.hasFocus = () => {
      throw new Error('detached');
    };
    win.document.getElementById('x')!.focus();
    expect(win.document.activeElement).toBe(win.document.body);
  });
});
