import { beforeEach, describe, expect, it } from 'vitest';
import { SliccQuickLook } from '../../src/quick-look/slicc-quick-look.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

describe('slicc-quick-look', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    SliccQuickLook.close();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-quick-look')).toBe(SliccQuickLook);
  });

  it('open() renders the overlay with a text preview', () => {
    SliccQuickLook.open({
      path: '/workspace/hello.txt',
      content: 'Hello world',
      mimeType: 'text/plain',
    });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    expect(ql).not.toBeNull();
    expect(ql.shadowRoot?.querySelector('pre')).not.toBeNull();
    expect(ql.shadowRoot?.querySelector('pre')?.textContent).toContain('Hello world');
  });

  it('open() renders an image preview for image/* MIME', () => {
    const buf = new ArrayBuffer(8);
    SliccQuickLook.open({ path: '/workspace/photo.png', content: buf, mimeType: 'image/png' });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    expect(ql.shadowRoot?.querySelector('img')).not.toBeNull();
  });

  it('open() renders audio controls for audio/* MIME', () => {
    const buf = new ArrayBuffer(8);
    SliccQuickLook.open({ path: '/workspace/clip.mp3', content: buf, mimeType: 'audio/mpeg' });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    expect(ql.shadowRoot?.querySelector('audio')).not.toBeNull();
  });

  it('open() renders video controls for video/* MIME', () => {
    const buf = new ArrayBuffer(8);
    SliccQuickLook.open({ path: '/workspace/demo.mp4', content: buf, mimeType: 'video/mp4' });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    expect(ql.shadowRoot?.querySelector('video')).not.toBeNull();
  });

  it('open() shows a fallback for unknown MIME types', () => {
    SliccQuickLook.open({
      path: '/workspace/data.bin',
      content: new ArrayBuffer(128),
      mimeType: 'application/octet-stream',
    });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    expect(ql.shadowRoot?.textContent).toContain('Preview not available');
  });

  it('displays the filename in the header', () => {
    SliccQuickLook.open({ path: '/workspace/hello.txt', content: 'hi', mimeType: 'text/plain' });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    expect(ql.shadowRoot?.querySelector('.header')?.textContent).toContain('hello.txt');
  });

  it('close() removes the overlay', () => {
    SliccQuickLook.open({ path: '/workspace/x.txt', content: 'x', mimeType: 'text/plain' });
    expect(document.querySelector('slicc-quick-look')).not.toBeNull();
    SliccQuickLook.close();
    expect(document.querySelector('slicc-quick-look')).toBeNull();
  });

  it('Escape dismisses the overlay', () => {
    SliccQuickLook.open({ path: '/workspace/x.txt', content: 'x', mimeType: 'text/plain' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('slicc-quick-look')).toBeNull();
  });

  it('clicking the backdrop dismisses the overlay', () => {
    SliccQuickLook.open({ path: '/workspace/x.txt', content: 'x', mimeType: 'text/plain' });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    const backdrop = ql.shadowRoot?.querySelector('.backdrop') as HTMLElement;
    backdrop.click();
    expect(document.querySelector('slicc-quick-look')).toBeNull();
  });

  it('clicking the close button dismisses the overlay', () => {
    SliccQuickLook.open({ path: '/workspace/x.txt', content: 'x', mimeType: 'text/plain' });
    const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
    const closeBtn = ql.shadowRoot?.querySelector('.x') as HTMLElement;
    closeBtn.click();
    expect(document.querySelector('slicc-quick-look')).toBeNull();
  });

  it('only one overlay open at a time', () => {
    SliccQuickLook.open({ path: '/a.txt', content: 'a', mimeType: 'text/plain' });
    SliccQuickLook.open({ path: '/b.txt', content: 'b', mimeType: 'text/plain' });
    expect(document.querySelectorAll('slicc-quick-look')).toHaveLength(1);
    expect(
      document.querySelector('slicc-quick-look')?.shadowRoot?.querySelector('.header')?.textContent
    ).toContain('b.txt');
  });

  // -- type handling: the half that used to be a hardcoded extension list --

  describe('type handling', () => {
    it('previews a caller-sniffed unknown extension as text — the .jsh case', () => {
      // `.jsh` is in no MIME table. The caller sniffed the bytes and says it is
      // text; the previewer must believe it instead of refusing.
      SliccQuickLook.open({
        path: '/workspace/bb.jsh',
        content: '#!/usr/bin/env jsh\necho hi\n',
        mimeType: 'text/plain',
        text: true,
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.textContent).not.toContain('Preview not available');
      expect(ql.shadowRoot?.querySelector('pre')?.textContent).toContain('echo hi');
    });

    it('honours an explicit text override even for an octet-stream MIME', () => {
      SliccQuickLook.open({
        path: '/workspace/weird.xyz',
        content: 'plain words',
        mimeType: 'application/octet-stream',
        text: true,
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('pre')?.textContent).toContain('plain words');
    });

    it('treats structured application/* types as text', () => {
      SliccQuickLook.open({
        path: '/a/b.json',
        content: '{"a":1}',
        mimeType: 'application/json',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('pre')).not.toBeNull();
    });

    it('renders a PDF in a frame rather than refusing it', () => {
      SliccQuickLook.open({
        path: '/a/doc.pdf',
        content: new ArrayBuffer(64),
        mimeType: 'application/pdf',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('iframe')).not.toBeNull();
    });

    it('names the type it could not preview, so the dead end is explained', () => {
      SliccQuickLook.open({
        path: '/a/blob.bin',
        content: new ArrayBuffer(2048),
        mimeType: 'application/octet-stream',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      const text = ql.shadowRoot?.textContent ?? '';
      expect(text).toContain('Preview not available');
      expect(text).toContain('application/octet-stream');
    });

    it('shows a type chip in the header', () => {
      SliccQuickLook.open({ path: '/a/b.ts', content: 'x', mimeType: 'text/typescript' });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('.chip')?.textContent).toBe('typescript');
    });
  });

  // -- git awareness --

  describe('git awareness', () => {
    const modified = {
      path: '/repo/src/main.ts',
      content: 'const a = 2;\n',
      mimeType: 'text/typescript',
      baseContent: 'const a = 1;\n',
      gitStatus: 'modified',
    };

    it('shows the git status in the header', () => {
      SliccQuickLook.open(modified);
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('.chip--git')?.textContent).toBe('modified');
    });

    it('offers a diff/file toggle only when a base version was supplied', () => {
      SliccQuickLook.open(modified);
      let ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('.toggle')).not.toBeNull();

      SliccQuickLook.open({ path: '/a/b.ts', content: 'x', mimeType: 'text/typescript' });
      ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(ql.shadowRoot?.querySelector('.toggle')).toBeNull();
    });

    it('opens on the diff, since that is the question a changed file poses', () => {
      SliccQuickLook.open(modified);
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      const pressed = ql.shadowRoot?.querySelector('.toggle button[aria-pressed="true"]');
      expect(pressed?.textContent).toBe('Diff');
    });

    it('switches to the whole file when the toggle is clicked', () => {
      SliccQuickLook.open(modified);
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      const buttons = [...(ql.shadowRoot?.querySelectorAll('.toggle button') ?? [])];
      (buttons.find((b) => b.textContent === 'File') as HTMLElement | undefined)?.click();
      const pressed = ql.shadowRoot?.querySelector('.toggle button[aria-pressed="true"]');
      expect(pressed?.textContent).toBe('File');
    });
  });

  // -- the async upgrade from plain <pre> to the highlighted view --

  describe('rich rendering', () => {
    /** Wait for the deferred @pierre/diffs import to replace the baseline. */
    const waitForRich = async (ql: SliccQuickLook, timeoutMs = 15_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ql.shadowRoot?.querySelector('diffs-container')) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    };

    /**
     * The rendered code lives in the `<diffs-container>`'s OWN shadow root, so
     * the overlay's `textContent` stops short of it — read through explicitly.
     */
    const richText = (ql: SliccQuickLook): string =>
      ql.shadowRoot?.querySelector('diffs-container')?.shadowRoot?.textContent ?? '';

    const waitForRichText = async (ql: SliccQuickLook, needle: string): Promise<string> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const text = richText(ql);
        if (text.includes(needle)) return text;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return richText(ql);
    };

    it('upgrades a text preview to the syntax-highlighted view', async () => {
      SliccQuickLook.open({
        path: '/a/main.ts',
        content: 'const greeting: string = "hello";\n',
        mimeType: 'text/typescript',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      // The plain <pre> must be there immediately — the overlay never blanks.
      expect(ql.shadowRoot?.querySelector('pre')).not.toBeNull();

      expect(await waitForRich(ql)).toBe(true);
      expect(await waitForRichText(ql, 'greeting')).toContain('greeting');
    });

    it('renders a real diff when a base version is supplied', async () => {
      SliccQuickLook.open({
        path: '/repo/src/main.ts',
        content: 'const a = 2;\n',
        mimeType: 'text/typescript',
        baseContent: 'const a = 1;\n',
        gitStatus: 'modified',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      expect(await waitForRich(ql)).toBe(true);
    });

    it('does not upgrade a binary preview', async () => {
      SliccQuickLook.open({
        path: '/a/photo.png',
        content: new ArrayBuffer(8),
        mimeType: 'image/png',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(ql.shadowRoot?.querySelector('diffs-container')).toBeNull();
      expect(ql.shadowRoot?.querySelector('img')).not.toBeNull();
    });

    it('does not paint a stale upgrade over a newer file', async () => {
      SliccQuickLook.open({
        path: '/a/first.ts',
        content: 'const a = 1;\n',
        mimeType: 'text/typescript',
      });
      SliccQuickLook.open({
        path: '/a/second.ts',
        content: 'const b = 2;\n',
        mimeType: 'text/typescript',
      });
      const ql = document.querySelector('slicc-quick-look') as SliccQuickLook;
      await waitForRich(ql);
      expect(ql.shadowRoot?.querySelector('.header')?.textContent).toContain('second.ts');
      expect(ql.shadowRoot?.textContent).not.toContain('const a = 1');
    });
  });
});
