import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDip } from '../../src/ui/dip.js';
import type { SprinkleBridgeAPI } from '../../src/ui/sprinkle-bridge.js';
import { SprinkleRenderer } from '../../src/ui/sprinkle-renderer.js';
import {
  applyTheme,
  registerSprinkleWindow,
  unregisterSprinkleWindow,
} from '../../src/ui/theme.js';
import { clearActiveTheme, saveCustomTheme, setActiveTheme } from '../../src/ui/theme-engine.js';
import type { SliccTheme } from '../../src/ui/theme-types.js';

interface ThemeMessage {
  type: 'slicc-theme';
  isLight: boolean;
  overrides: Record<string, string> | null;
  css: string;
}

describe.each(['sprinkle', 'dip'] as const)('%s iframe theme integration', (kind) => {
  let host: JSDOM;
  let frame: JSDOM;
  let dispose: () => void;
  let receiver: Window;
  let posts: ThemeMessage[];

  beforeEach(() => {
    host = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'http://localhost',
    });
    for (const key of [
      'window',
      'document',
      'localStorage',
      'location',
      'getComputedStyle',
      'CSSStyleRule',
      'CSSFontFaceRule',
    ] as const) {
      vi.stubGlobal(key, host.window[key]);
    }
    posts = [];
  });

  afterEach(() => {
    unregisterSprinkleWindow(receiver);
    dispose?.();
    frame?.window.close();
    host.window.close();
    vi.unstubAllGlobals();
  });

  function selectTheme(theme: Pick<SliccTheme, 'tokens' | 'css'>): void {
    saveCustomTheme({ id: 'imported', name: 'Imported', base: 'dark', ...theme });
    setActiveTheme('imported');
    applyTheme();
    // jsdom omits CSSStyleSheet.ownerNode; supply the browser's association so
    // the collector really exercises the dynamic stylesheet exclusion.
    const style = document.getElementById('slicc-theme-overrides') as HTMLStyleElement | null;
    if (style?.sheet) {
      Object.defineProperty(style.sheet, 'ownerNode', { configurable: true, value: style });
    }
  }

  async function mount(): Promise<void> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const content =
      '<!doctype html><html><body><div class="sprinkle-card fill">Card</div></body></html>';
    if (kind === 'sprinkle') {
      // Only the theme/load lifecycle is used by this document.
      const bridge = { name: 'theme-test', getState: () => null } as SprinkleBridgeAPI;
      const renderer = new SprinkleRenderer(container, bridge);
      dispose = () => renderer.dispose();
      await renderer.render(content, 'theme-test');
    } else {
      const dip = mountDip(container, content, vi.fn());
      dispose = () => dip.dispose();
    }
    const srcdoc = container.querySelector('iframe')!.srcdoc;
    expect(srcdoc).not.toContain('outline: 3px');
    // Execute the actual generated document; jsdom does not load srcdoc itself.
    frame = new JSDOM(srcdoc, {
      url: 'http://localhost',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        Object.defineProperty(win, 'parent', { value: host.window });
        win.ResizeObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
      },
    });
    receiver = {
      postMessage(message: ThemeMessage) {
        posts.push(message);
        frame.window.dispatchEvent(
          new frame.window.MessageEvent('message', {
            data: message,
            source: host.window as unknown as Window,
          })
        );
      },
    } as unknown as Window;
    registerSprinkleWindow(receiver);
  }

  it('sanitizes imported tokens on initial registration and subsequent updates', async () => {
    const tokens = {
      '--s2-gray-25': 'url(https://example.invalid/pixel)',
      '--expression': 'expression(alert(1))',
      '--injection': 'red; background: blue',
      '--safe': '#abcdef',
      's2-accent': 'rgba(10, 20, 30, 0.5)',
      '--reference': 'var(--safe)',
    };
    selectTheme({ tokens });
    await mount();
    const safe = {
      '--safe': '#abcdef',
      '--s2-accent': 'rgba(10, 20, 30, 0.5)',
      '--reference': 'var(--safe)',
    };
    expect(posts.at(-1)?.overrides).toEqual(safe);
    const rootStyle = frame.window.document.documentElement.style;
    expect(rootStyle.getPropertyValue('--s2-gray-25')).toBe('');
    expect(rootStyle.getPropertyValue('--safe')).toBe('#abcdef');

    selectTheme({ tokens: { ...tokens, '--safe': '#123456' } });
    expect(posts.at(-1)?.overrides).toEqual({ ...safe, '--safe': '#123456' });
    expect(rootStyle.getPropertyValue('--safe')).toBe('#123456');
    expect(rootStyle.cssText).not.toMatch(/url\(|expression\(|background:/);
  });

  it('preserves sanitized sprinkle CSS, replaces it on a switch, and clears it on reset', async () => {
    selectTheme({
      tokens: { '--accent': '#abcdef' },
      css: '.sprinkle-card { outline: 3px solid red; } .fill { padding: 17px; } .wcui-card { color: blue; }',
    });
    await mount();
    const doc = frame.window.document;
    const card = doc.querySelector('.sprinkle-card')!;
    const getStyle = () => doc.getElementById('slicc-iframe-theme-overrides');
    expect(posts.at(-1)?.css).toContain('.sprinkle-card');
    expect(posts.at(-1)?.css).toContain('.fill');
    expect(posts.at(-1)?.css).not.toContain('.wcui-card');
    expect(getStyle()?.textContent).toContain('outline: 3px solid red');
    expect(frame.window.getComputedStyle(card).padding).toBe('17px');

    selectTheme({ tokens: { '--other': '#123456' }, css: '.fill { padding: 23px; }' });
    expect(doc.querySelectorAll('#slicc-iframe-theme-overrides')).toHaveLength(1);
    expect(getStyle()?.textContent).not.toContain('outline');
    expect(frame.window.getComputedStyle(card).padding).toBe('23px');
    expect(doc.documentElement.style.getPropertyValue('--accent')).toBe('');

    clearActiveTheme();
    applyTheme();
    expect(posts.at(-1)).toMatchObject({ overrides: null, css: '' });
    expect(getStyle()).toBeNull();
    expect(frame.window.getComputedStyle(card).padding).not.toBe('23px');
    expect(doc.documentElement.style.getPropertyValue('--other')).toBe('');
  });

  it('drops unsafe custom CSS and rejects theme messages from other windows', async () => {
    selectTheme({
      tokens: { '--safe': '#abcdef' },
      css: '.sprinkle-card { background: url(https://example.invalid/pixel); }',
    });
    await mount();
    expect(posts.at(-1)?.css).toBe('');
    frame.window.dispatchEvent(
      new frame.window.MessageEvent('message', {
        source: frame.window as unknown as Window,
        data: {
          type: 'slicc-theme',
          isLight: true,
          overrides: { '--unsafe': 'url(https://example.invalid/pixel)' },
          css: '.fill { padding: 99px; }',
        },
      })
    );
    expect(frame.window.document.documentElement.classList.contains('theme-light')).toBe(false);
    expect(frame.window.document.documentElement.style.getPropertyValue('--unsafe')).toBe('');
    expect(frame.window.document.getElementById('slicc-iframe-theme-overrides')).toBeNull();
  });
});
