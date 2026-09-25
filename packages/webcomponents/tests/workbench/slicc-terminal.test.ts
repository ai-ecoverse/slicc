import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import { SliccTerminal } from '../../src/workbench/slicc-terminal.js';

async function mount(setup?: (el: SliccTerminal) => void): Promise<SliccTerminal> {
  const el = document.createElement('slicc-terminal') as SliccTerminal;
  el.style.width = '480px';
  el.style.height = '240px';
  setup?.(el);
  document.body.appendChild(el);
  await waitForTerminal(el);
  return el;
}

async function waitForTerminal(el: SliccTerminal, timeoutMs = 4000): Promise<void> {
  const start = performance.now();
  while (el.terminal === null) {
    if (performance.now() - start > timeoutMs) throw new Error('wterm did not load in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function renderedText(el: SliccTerminal): string {
  const rows = el.shadowRoot?.querySelectorAll('.term-row');
  return Array.from(rows ?? [], (row) => row.textContent ?? '').join('\n');
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
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

  it('attaches a shadow root with the wterm mount host', async () => {
    const el = await mount();
    expect(el.shadowRoot).not.toBeNull();
    const host = el.shadowRoot?.querySelector('.host[part="host"]');
    expect(host).not.toBeNull();
    expect(host?.classList.contains('wterm')).toBe(true);
    expect(host?.querySelector('.term-grid')).not.toBeNull();
  });

  it('injects the wterm stylesheet into the shadow root', async () => {
    const el = await mount();

    const styleText = (el.shadowRoot?.adoptedStyleSheets ?? [])
      .flatMap((s) => Array.from(s.cssRules).map((r) => r.cssText))
      .join('\n');
    expect(styleText).toContain('.wterm');
    expect(styleText).toContain('.term-row');
  });

  it('announces when buffered output has reached the initialized renderer', async () => {
    const el = document.createElement('slicc-terminal') as SliccTerminal;
    const ready = vi.fn();
    el.addEventListener('terminal-ready', ready);
    el.writeln('before-connect');
    document.body.appendChild(el);
    await waitForTerminal(el);
    expect(ready).toHaveBeenCalledOnce();
    await waitFor(() => renderedText(el).includes('before-connect'));
    expect(renderedText(el)).toContain('before-connect');
  });

  describe('header', () => {
    it('renders a lucide <svg> icon (no emoji / bespoke glyphs)', async () => {
      const el = await mount();
      const header = el.shadowRoot?.querySelector('.hd[part="header"]');
      expect(header).not.toBeNull();
      expect(header?.querySelector('svg')).not.toBeNull();

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
    it('renders direct Kitty RGB graphics through the Ghostty core', async () => {
      const el = await mount();

      el.write('\x1b_Ga=T,f=24,s=1,v=1,i=7,c=1,r=1;/wAA\x1b\\');
      await waitFor(() => el.shadowRoot?.querySelector('.term-image') !== null);
      expect(el.shadowRoot?.querySelector('.term-image')).not.toBeNull();
    });

    it('write()/writeln() render in the rows', async () => {
      const el = await mount();
      el.writeln('hello slicc terminal');
      await waitFor(() => renderedText(el).includes('hello slicc terminal'));
      expect(renderedText(el)).toContain('hello slicc terminal');
    });

    it('buffers writes issued before wterm finishes loading and flushes them', async () => {
      const el = document.createElement('slicc-terminal') as SliccTerminal;
      el.style.width = '480px';
      el.style.height = '240px';
      document.body.appendChild(el);
      el.writeln('queued-before-load');
      expect(el.terminal).toBeNull();
      await waitForTerminal(el);
      await waitFor(() => renderedText(el).includes('queued-before-load'));
      expect(renderedText(el)).toContain('queued-before-load');
    });

    it('clear() empties the rendered viewport text', async () => {
      const el = await mount();
      el.writeln('line-to-clear');
      await waitFor(() => renderedText(el).includes('line-to-clear'));
      expect(renderedText(el)).toContain('line-to-clear');
      el.clear();
      await waitFor(() => !renderedText(el).includes('line-to-clear'));
      expect(renderedText(el)).not.toContain('line-to-clear');
    });
  });

  describe('terminal-data event', () => {
    it('fires a composed, bubbling event carrying the keystroke data on user input', async () => {
      const el = await mount();
      const onData = vi.fn();
      el.addEventListener('terminal-data', onData);

      el.shadowRoot?.querySelector('textarea')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'x',
          bubbles: true,
        })
      );

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
      el.shadowRoot?.querySelector('textarea')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'y',
          bubbles: true,
        })
      );
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

    it('does not throw when removed before wterm finishes loading', async () => {
      const el = document.createElement('slicc-terminal') as SliccTerminal;
      el.style.width = '480px';
      el.style.height = '240px';
      document.body.appendChild(el);

      expect(() => el.remove()).not.toThrow();

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
