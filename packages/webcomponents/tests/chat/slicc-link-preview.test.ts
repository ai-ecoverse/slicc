import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccLinkPreview } from '../../src/chat/slicc-link-preview.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function mount(attrs: Record<string, string>): SliccLinkPreview {
  const el = document.createElement('slicc-link-preview');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

describe('slicc-link-preview', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-link-preview')).toBe(SliccLinkPreview);
  });

  it('renders a ready card as a safe link with title, description and site', () => {
    const el = mount({
      url: 'https://example.com/post',
      heading: 'A post',
      description: 'About things',
      site: 'Example',
      badge: 'PR #7',
    });
    const root = el.shadowRoot as ShadowRoot;
    const a = root.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/post');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
    expect(root.querySelector('.title')?.textContent).toBe('A post');
    expect(root.querySelector('.desc')?.textContent).toBe('About things');
    expect(root.querySelector('.site')?.textContent).toContain('Example');
    expect(root.querySelector('.badge')?.textContent).toBe('PR #7');
  });

  it('falls back to the host when there is no site name', () => {
    const el = mount({ url: 'https://docs.example.org/a', heading: 'x' });
    expect(el.shadowRoot?.querySelector('.site')?.textContent).toContain('docs.example.org');
  });

  it('does not link non-web URLs', () => {
    const el = mount({ url: 'javascript:alert(1)', heading: 'x' });
    expect(el.shadowRoot?.querySelector('a')).toBeNull();
  });

  it('renders http(s) and data:image images, and drops other schemes', () => {
    const el = mount({ url: 'https://example.com', heading: 'x', image: PIXEL });
    expect(el.shadowRoot?.querySelector('img')?.getAttribute('src')).toBe(PIXEL);
    expect(el.shadowRoot?.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    el.setAttribute('image', 'javascript:alert(1)');
    expect(el.shadowRoot?.querySelector('img')).toBeNull();
    el.setAttribute('image', 'data:text/html,<b>x</b>');
    expect(el.shadowRoot?.querySelector('img')).toBeNull();
  });

  it('fires link-preview-resize once the image loads', async () => {
    const el = mount({ url: 'https://example.com', heading: 'x' });
    const onResize = vi.fn();
    el.addEventListener('link-preview-resize', onResize);
    el.setAttribute('image', PIXEL);
    const img = el.shadowRoot?.querySelector('img') as HTMLImageElement;
    img.loading = 'eager';
    await vi.waitFor(() => expect(onResize).toHaveBeenCalled());
  });

  it('shows a skeleton while loading', () => {
    const el = mount({ url: 'https://example.com', state: 'loading' });
    expect(el.state).toBe('loading');
    expect(el.shadowRoot?.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    expect(el.shadowRoot?.querySelector('.title')).toBeNull();
  });

  it('shows the URL when the preview is unavailable', () => {
    const el = mount({ url: 'https://example.com/x', state: 'error' });
    expect(el.shadowRoot?.textContent).toContain('example.com');
    expect(el.shadowRoot?.querySelector('.skeleton')).toBeNull();
  });

  it('reflects url and state properties and ignores unknown states', () => {
    const el = mount({ url: 'https://a.example' });
    expect(el.state).toBe('ready');
    el.url = 'https://b.example/';
    expect(el.getAttribute('url')).toBe('https://b.example/');
    el.state = 'loading';
    expect(el.getAttribute('state')).toBe('loading');
    el.setAttribute('state', 'bogus');
    expect(el.state).toBe('ready');
  });
});
