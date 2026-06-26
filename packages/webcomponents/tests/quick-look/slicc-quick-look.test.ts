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
});
