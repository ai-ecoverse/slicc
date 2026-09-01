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

/** Body of a top-level rule whose selector matches exactly. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  return css.slice(open + 1, close);
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
const lightTokens = tokensIn(ruleBody(tokensCss, ':root.theme-light'));

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
