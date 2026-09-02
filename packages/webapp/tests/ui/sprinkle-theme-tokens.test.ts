/**
 * Sprinkle framework CSS is inherited by EVERY sprinkle, so a light-only
 * colour there is unreadable in dark mode for every author at once (#2740).
 * These tests read the stylesheets as text — jsdom resolves no `var()` and
 * computes no contrast, so a rendered assertion would prove nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = resolve(here, '../../src/ui/styles');
const tokensCss = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8');
const sprinkleCss = readFileSync(resolve(stylesDir, 'sprinkle-components.css'), 'utf8');

/**
 * The top-level rule whose selector LIST contains `selector` — the light
 * values are shared by two markers, so an exact-selector lookup would miss
 * them (see the WC-marker test below).
 */
function rule(css: string, selector: string): { selectors: string[]; body: string } {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return { selectors, body: m[2] };
  }
  expect.fail(`missing rule ${selector}`);
}

function ruleBody(css: string, selector: string): string {
  return rule(css, selector).body;
}

function tokensIn(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  return map;
}

function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const darkTokens = tokensIn(ruleBody(tokensCss, ':root'));
const lightRule = rule(tokensCss, ':root.theme-light');
const lightTokens = tokensIn(lightRule.body);

/**
 * The WC shell's light marker — it never sets `.theme-light` on <html>. The
 * `:has()` is wrapped in `:where()` to keep the selector at plain `:root`
 * specificity; see the specificity test below.
 */
const WC_LIGHT_MARKER = ':root:where(:has(body[data-theme="light"]))';

const SUBTLE_HUES = [
  'yellow',
  'purple',
  'cyan',
  'magenta',
  'indigo',
  'gray',
  'positive',
  'notice',
  'negative',
  'accent',
] as const;

describe('uxc subtle palette is theme-aware', () => {
  it('declares every subtle token in both :root (dark) and :root.theme-light', () => {
    const darkSubtle = [...darkTokens.keys()].filter((k) => k.includes('-subtle-')).sort();
    expect(darkSubtle.length).toBeGreaterThanOrEqual(21);
    expect([...lightTokens.keys()].filter((k) => k.includes('-subtle-')).sort()).toEqual(
      darkSubtle
    );
  });

  it('gives each subtle token a different value per theme', () => {
    for (const key of darkTokens.keys()) {
      if (!key.includes('-subtle-')) continue;
      expect(lightTokens.get(key), `${key} is theme-invariant`).not.toBe(darkTokens.get(key));
    }
  });

  it.each(SUBTLE_HUES)('%s subtle bg/text pair clears AA in both themes', (hue) => {
    for (const [theme, tokens] of [
      ['dark', darkTokens],
      ['light', lightTokens],
    ] as const) {
      const bg = tokens.get(`--uxc-${hue}-subtle-bg`) as string;
      const text = tokens.get(`--uxc-${hue}-subtle-text`) as string;
      expect(bg, `${hue}/${theme} bg`).toMatch(/^#[0-9a-f]{6}$/);
      expect(text, `${hue}/${theme} text`).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(bg, text), `${hue} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('pairs the neutral subtle fill with gray-700 above AA in both themes', () => {
    // `.sprinkle-badge--subtle` (no modifier) uses gray-700 as its text colour,
    // so the neutral fill has no `-text` sibling to check it against.
    for (const [theme, tokens] of [
      ['dark', darkTokens],
      ['light', lightTokens],
    ] as const) {
      const bg = tokens.get('--uxc-neutral-subtle-bg') as string;
      const gray700 = tokens.get('--s2-gray-700') as string;
      expect(contrast(bg, gray700), `neutral in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('light overrides reach both shells', () => {
  it('declares the light token block under the WC body marker too', () => {
    // Inline (fragment) sprinkles and dips render into the page DOM, so in the
    // WC shell — which marks `body[data-theme="light"]` and never touches
    // `.theme-light` — a `.theme-light`-only block would leave them dark.
    expect(lightRule.selectors).toContain(WC_LIGHT_MARKER);
  });

  it('pairs every .theme-light descendant rule with the WC marker', () => {
    const withoutComments = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of withoutComments.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      const selectors = m[1].split(',').map((s) => s.trim());
      const themeLight = selectors.filter((s) => s.startsWith('.theme-light '));
      for (const sel of themeLight) {
        const suffix = sel.slice('.theme-light '.length);
        expect(selectors, `${sel} has no WC-marker twin`).toContain(`${WC_LIGHT_MARKER} ${suffix}`);
      }
    }
  });

  it('keeps the WC marker specificity-neutral so an active theme still wins', () => {
    // `theme-engine.ts` injects the selected preset's tokens into a LATER
    // `:root { … }` block. A bare `:root:has(body[data-theme="light"])` scores
    // (0,2,1) and would outrank it, so a light preset would render these
    // defaults instead of its own tokens. `:where()` contributes nothing,
    // leaving plain `:root` (0,1,0), which wins over the dark block above on
    // order alone and still loses to the injected theme.
    const withoutComments = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of withoutComments.matchAll(/:root[^,{\s]*:has\(/g)) {
      expect(m[0], 'unwrapped :has() raises specificity above the injected theme').toBe(
        ':root:where(:has('
      );
    }
    expect(withoutComments).toContain(WC_LIGHT_MARKER);
  });
});

describe('sprinkle framework CSS uses theme-aware surfaces', () => {
  it('never hardcodes a light background on a themed control', () => {
    for (const selector of ['.sprinkle-text-field', '.sprinkle-chip']) {
      const body = ruleBody(sprinkleCss, selector);
      expect(body, selector).not.toMatch(/background:\s*(white|#fff(fff)?)\b/i);
      expect(body, selector).toMatch(/background:\s*var\(--s2-/);
    }
  });

  it('gives the text-field placeholder a theme-aware content token', () => {
    const body = ruleBody(sprinkleCss, '.sprinkle-text-field::placeholder');
    expect(body).toMatch(/color:\s*var\(--s2-content-/);
  });

  it('routes subtle-fill consumers through the uxc tokens, not raw hexes', () => {
    for (const m of sprinkleCss.matchAll(
      /\.sprinkle-[\w-]*(?:badge|action-card__icon)[^{]*\{([^}]*)\}/g
    )) {
      const body = m[1];
      if (!body.includes('-subtle-bg')) continue;
      expect(body, body).not.toMatch(/color:\s*#[0-9a-f]{3,6}/i);
    }
  });
});
