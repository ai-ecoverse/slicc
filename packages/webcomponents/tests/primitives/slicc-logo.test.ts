import { beforeEach, describe, expect, it } from 'vitest';
import { SliccLogo } from '../../src/primitives/slicc-logo.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

describe('slicc-logo', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-logo')).toBe(SliccLogo);
  });

  it('renders the wordmark in its shadow root', () => {
    const el = document.createElement('slicc-logo');
    document.body.appendChild(el);
    const logo = el.shadowRoot?.querySelector('.logo');
    expect(logo?.textContent).toContain('sliccy');
  });

  it('omits the badge by default', () => {
    const el = document.createElement('slicc-logo');
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('.b')).toBeNull();
  });

  it('renders a gradient badge when set, reflected via the property', () => {
    const el = document.createElement('slicc-logo');
    el.badge = 'beta';
    document.body.appendChild(el);
    expect(el.getAttribute('badge')).toBe('beta');
    const badge = el.shadowRoot?.querySelector('.b') as HTMLElement;
    expect(badge?.textContent).toBe('beta');
    // Real-browser fidelity: the rainbow gradient resolves as a background image.
    expect(getComputedStyle(badge).backgroundImage).toContain('gradient');
  });

  it('escapes badge text', () => {
    const el = document.createElement('slicc-logo');
    el.badge = '<script>x</script>';
    document.body.appendChild(el);
    const badge = el.shadowRoot?.querySelector('.b');
    expect(badge?.querySelector('script')).toBeNull();
    expect(badge?.textContent).toBe('<script>x</script>');
  });

  it('drops the gradient badge below 560px to save width in an extension sidebar', () => {
    const el = document.createElement('slicc-logo');
    el.badge = 'studio';
    document.body.appendChild(el);
    const sheet = (el.shadowRoot as ShadowRoot).adoptedStyleSheets[0];
    const media = Array.from(sheet.cssRules).find(
      (r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText.includes('560px')
    );
    expect(media).toBeDefined();
    const badgeRule = Array.from((media as CSSMediaRule).cssRules).find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('.b')
    );
    expect(badgeRule?.style.display).toBe('none');
  });
});
