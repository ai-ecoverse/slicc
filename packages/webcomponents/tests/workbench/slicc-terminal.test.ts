import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import { SliccTerminal } from '../../src/workbench/slicc-terminal.js';

/**
 * Mount a `<slicc-terminal>` in the document (it needs real layout + a real DOM
 * for xterm to open into) and wait for the async xterm load to finish, so
 * `el.terminal` is the live `Terminal`. Browser mode (real Chromium) gives
 * xterm the canvas/measurement APIs jsdom cannot.
 */
async function mount(setup?: (el: SliccTerminal) => void): Promise<SliccTerminal> {
  const el = document.createElement('slicc-terminal') as SliccTerminal;
  el.style.width = '480px';
  el.style.height = '240px';
  setup?.(el);
  document.body.appendChild(el);
  await waitForTerminal(el);
  return el;
}

/** Poll until the dynamically-imported xterm `Terminal` is constructed. */
async function waitForTerminal(el: SliccTerminal, timeoutMs = 4000): Promise<void> {
  const start = performance.now();
  while (el.terminal === null) {
    if (performance.now() - start > timeoutMs) throw new Error('xterm did not load in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Concatenate the visible buffer rows into a single string. */
function bufferText(el: SliccTerminal): string {
  const buf = el.terminal?.buffer.active;
  if (!buf) return '';
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += `${buf.getLine(i)?.translateToString(true) ?? ''}\n`;
  }
  return out;
}

/** Read the rendered xterm rows from the shadow DOM (what the user sees). */
function renderedText(el: SliccTerminal): string {
  const rows = el.shadowRoot?.querySelector('.xterm-rows');
  return rows?.textContent ?? '';
}

describe('slicc-terminal', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-terminal')).toBe(SliccTerminal);
  });

  it('attaches a shadow root with the xterm mount host', async () => {
    const el = await mount();
    expect(el.shadowRoot).not.toBeNull();
    const host = el.shadowRoot?.querySelector('.host[part="host"]');
    expect(host).not.toBeNull();
    // xterm opened into the host inside the shadow root.
    expect(host?.querySelector('.xterm')).not.toBeNull();
  });

  it('injects the xterm stylesheet into the shadow root (so rows render in shadow DOM)', async () => {
    const el = await mount();
    const styleText = Array.from(el.shadowRoot?.querySelectorAll('style') ?? [])
      .map((s) => s.textContent ?? '')
      .join('\n');
    // A marker selector only the xterm stylesheet provides.
    expect(styleText).toContain('.xterm');
    expect(styleText).toContain('xterm-viewport');
  });

  describe('header', () => {
    it('renders a lucide <svg> icon (no emoji / bespoke glyphs)', async () => {
      const el = await mount();
      const header = el.shadowRoot?.querySelector('.hd[part="header"]');
      expect(header).not.toBeNull();
      expect(header?.querySelector('svg')).not.toBeNull();
      // No emoji or bespoke unicode terminal glyphs in the chrome.
      const headerText = header?.textContent ?? '';
      expect(headerText).not.toMatch(/[✦❄🔔🌙☀↑⤡＋>_]/u);
    });

    it('shows the default and custom label', async () => {
      const el = await mount();
      expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('Terminal');
      el.label = 'researcher';
      expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('researcher');
    });

    it('hides the header when hide-header is set', async () => {
      const el = await mount((e) => {
        e.hideHeader = true;
      });
      expect(el.hideHeader).toBe(true);
      const header = el.shadowRoot?.querySelector('.hd') as HTMLElement;
      expect(getComputedStyle(header).display).toBe('none');
    });
  });

  describe('write API', () => {
    it('write()/writeln() land in the xterm buffer and render in the rows', async () => {
      const el = await mount();
      el.writeln('hello slicc terminal');
      // Give xterm a frame to render the written line.
      await new Promise((r) => setTimeout(r, 60));
      expect(bufferText(el)).toContain('hello slicc terminal');
      expect(renderedText(el)).toContain('hello slicc terminal');
    });

    it('buffers writes issued before xterm finishes loading and flushes them', async () => {
      // Write synchronously right after connect, before the async load resolves.
      const el = document.createElement('slicc-terminal') as SliccTerminal;
      el.style.width = '480px';
      el.style.height = '240px';
      document.body.appendChild(el);
      el.writeln('queued-before-load');
      expect(el.terminal).toBeNull(); // not yet loaded → buffered
      await waitForTerminal(el);
      await new Promise((r) => setTimeout(r, 60));
      expect(bufferText(el)).toContain('queued-before-load');
    });

    it('clear() empties the rendered viewport text', async () => {
      const el = await mount();
      el.writeln('line-to-clear');
      await new Promise((r) => setTimeout(r, 60));
      expect(bufferText(el)).toContain('line-to-clear');
      el.clear();
      await new Promise((r) => setTimeout(r, 60));
      expect(bufferText(el)).not.toContain('line-to-clear');
    });
  });

  describe('terminal-data event', () => {
    it('fires a composed, bubbling event carrying the keystroke data on user input', async () => {
      const el = await mount();
      const onData = vi.fn();
      el.addEventListener('terminal-data', onData);

      // Simulate the user typing by driving xterm's input pipe directly — the
      // same path keystrokes take, which fires `onData`.
      el.terminal?.input('x');

      expect(onData).toHaveBeenCalledTimes(1);
      const ev = onData.mock.calls[0][0] as CustomEvent<string>;
      expect(ev.bubbles).toBe(true);
      expect(ev.composed).toBe(true);
      expect(ev.detail).toBe('x');
    });

    it('bubbles out of the host element', async () => {
      const wrap = document.createElement('div');
      document.body.appendChild(wrap);
      const el = document.createElement('slicc-terminal') as SliccTerminal;
      el.style.width = '480px';
      el.style.height = '240px';
      wrap.appendChild(el);
      await waitForTerminal(el);

      const onWrap = vi.fn();
      wrap.addEventListener('terminal-data', onWrap);
      el.terminal?.input('y');
      expect(onWrap).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('disconnect disposes the terminal without throwing and nulls it out', async () => {
      const el = await mount();
      expect(el.terminal).not.toBeNull();
      expect(() => el.remove()).not.toThrow();
      expect(el.terminal).toBeNull();
    });

    it('does not throw when removed before xterm finishes loading', async () => {
      const el = document.createElement('slicc-terminal') as SliccTerminal;
      el.style.width = '480px';
      el.style.height = '240px';
      document.body.appendChild(el);
      // Remove immediately, while the async xterm import is still in flight.
      expect(() => el.remove()).not.toThrow();
      // Let the pending import settle; the disposed guard must keep it from opening.
      await new Promise((r) => setTimeout(r, 200));
      expect(el.terminal).toBeNull();
    });

    it('focus() is a no-op-safe before load and works after', async () => {
      const el = document.createElement('slicc-terminal') as SliccTerminal;
      document.body.appendChild(el);
      expect(() => el.focus()).not.toThrow();
      await waitForTerminal(el);
      expect(() => el.focus()).not.toThrow();
    });
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects label', async () => {
      const el = await mount();
      expect(el.label).toBe('Terminal');
      el.label = 'shell';
      expect(el.getAttribute('label')).toBe('shell');
      el.label = null;
      expect(el.hasAttribute('label')).toBe(false);
      expect(el.label).toBe('Terminal');
    });

    it('reflects hideHeader', async () => {
      const el = await mount();
      expect(el.hideHeader).toBe(false);
      el.hideHeader = true;
      expect(el.hasAttribute('hide-header')).toBe(true);
      el.hideHeader = false;
      expect(el.hasAttribute('hide-header')).toBe(false);
    });
  });
});
