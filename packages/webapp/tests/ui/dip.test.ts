// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hydrateDips, disposeDips, type DipInstance } from '../../src/ui/dip.js';

// Mock collectThemeCSS — avoid needing a real DOM with stylesheets
vi.mock('./sprinkle-renderer.js', () => ({
  collectThemeCSS: () => ':root { --s2-spacing-200: 12px; }',
}));

describe('hydrateDips', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('returns empty array when no shtml blocks present', () => {
    container.innerHTML = '<p>Hello world</p>';
    const instances = hydrateDips(container, vi.fn());
    expect(instances).toEqual([]);
  });

  it('finds and replaces code.language-shtml elements', () => {
    container.innerHTML =
      '<pre><code class="language-shtml">&lt;button onclick="slicc.lick(\'ok\')"&gt;OK&lt;/button&gt;</code></pre>';

    const onLick = vi.fn();
    const instances = hydrateDips(container, onLick);

    expect(instances).toHaveLength(1);
    // The pre element should be replaced with a div.msg__dip
    expect(container.querySelector('pre')).toBeNull();
    const wrapper = container.querySelector('.msg__dip');
    expect(wrapper).not.toBeNull();
    // Should contain an iframe
    const iframe = wrapper?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');

    // Cleanup
    disposeDips(instances);
  });

  it('handles multiple shtml blocks in one container', () => {
    container.innerHTML =
      '<p>Text before</p>' +
      '<pre><code class="language-shtml">&lt;p&gt;Card 1&lt;/p&gt;</code></pre>' +
      '<p>Text between</p>' +
      '<pre><code class="language-shtml">&lt;p&gt;Card 2&lt;/p&gt;</code></pre>' +
      '<p>Text after</p>';

    const instances = hydrateDips(container, vi.fn());
    expect(instances).toHaveLength(2);

    const wrappers = container.querySelectorAll('.msg__dip');
    expect(wrappers).toHaveLength(2);
    // Regular content should still be there
    expect(container.querySelectorAll('p')).toHaveLength(3);

    disposeDips(instances);
  });

  it('does not match non-shtml code blocks', () => {
    container.innerHTML = '<pre><code class="language-javascript">const x = 1;</code></pre>';

    const instances = hydrateDips(container, vi.fn());
    expect(instances).toEqual([]);
    // The code block should remain untouched
    expect(container.querySelector('code.language-javascript')).not.toBeNull();
  });

  it('returns a placeholder instance for img[src$=".shtml"] before the fetch resolves', () => {
    // Make fetch hang forever so we can observe the synchronous placeholder.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    container.innerHTML = '<img src="/shared/dips/welcome.shtml" alt="Welcome">';
    const instances = hydrateDips(container, vi.fn());

    expect(instances).toHaveLength(1);
    expect(typeof instances[0].dispose).toBe('function');
    // The img element is replaced with the wrapper synchronously.
    expect(container.querySelector('img')).toBeNull();
    const wrapper = container.querySelector<HTMLElement>('.msg__dip');
    expect(wrapper?.getAttribute('title')).toBe('Welcome');

    // Disposing the placeholder must abort the in-flight fetch.
    const callArgs = fetchSpy.mock.calls[0];
    const init = callArgs[1] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);
    instances[0].dispose();
    expect(signal?.aborted).toBe(true);

    fetchSpy.mockRestore();
  });

  it('does not call mountDip if the placeholder is disposed before fetch resolves', async () => {
    // Resolve fetch on demand so we can interleave dispose + resolution.
    let resolveFetch!: (resp: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    container.innerHTML = '<img src="/shared/dips/welcome.shtml">';
    const instances = hydrateDips(container, vi.fn());
    expect(instances).toHaveLength(1);

    // Dispose BEFORE the fetch resolves.
    instances[0].dispose();

    // Now resolve the fetch; the .then() must skip mountDip and not throw.
    resolveFetch(new Response('<p>too late</p>', { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));

    // No iframe should have been mounted because dispose ran first.
    expect(container.querySelector('iframe')).toBeNull();

    fetchSpy.mockRestore();
  });
});

describe('disposeDips', () => {
  it('calls dispose on each instance and clears the array', () => {
    const disposeFn1 = vi.fn();
    const disposeFn2 = vi.fn();
    const instances: DipInstance[] = [{ dispose: disposeFn1 }, { dispose: disposeFn2 }];
    disposeDips(instances);
    expect(disposeFn1).toHaveBeenCalledOnce();
    expect(disposeFn2).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(0);
  });
});
