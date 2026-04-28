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
