# Theme Personalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a theme personalization system that lets users pick from preset SLICC-branded themes or build custom themes with tiered controls (simplified 7-slot + advanced per-token), with JSON export/import.

**Architecture:** A `theme-engine.ts` module manages theme storage, application (via a `<style>` override element on `:root`), and derivation (simplified slots → full token map via HSL math). Presets are static objects in `theme-presets.ts`. The settings dialog (`wc-settings.ts`) gains an "Appearance" section above providers. Sprinkle/dip sync reuses the existing broadcast mechanism with overrides included in the payload.

**Tech Stack:** TypeScript, CSS custom properties, localStorage, existing `wc-settings.ts` dialog pattern, native HSL color math (no external libraries).

---

## File Structure

| Path                                              | Responsibility                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/webapp/src/ui/theme-engine.ts`          | Core: load/save/apply/remove overrides, `deriveTokens()`, import/export helpers     |
| `packages/webapp/src/ui/theme-presets.ts`         | Static `SliccTheme` objects for the 6 branded presets                               |
| `packages/webapp/src/ui/theme-types.ts`           | `SliccTheme`, `SimplifiedSlots`, `TOKEN_GROUPS` type/constant definitions           |
| `packages/webapp/src/ui/styles/theme-builder.css` | Styles for the Appearance section and custom builder UI                             |
| `packages/webapp/src/ui/theme.ts`                 | Modified: call `applyThemeOverrides()` after base class toggle, broadcast overrides |
| `packages/webapp/src/ui/wc/wc-settings.ts`        | Modified: add Appearance section (preset grid, custom list, builder)                |
| `packages/webapp/tests/ui/theme-engine.test.ts`   | Tests for derivation, storage, apply/remove                                         |
| `packages/webapp/tests/ui/theme-presets.test.ts`  | Tests validating preset structure                                                   |

---

### Task 1: Theme Types and Constants

**Files:**

- Create: `packages/webapp/src/ui/theme-types.ts`
- Test: `packages/webapp/tests/ui/theme-engine.test.ts` (initial)

- [ ] **Step 1: Write the failing test for types and token groups**

```typescript
// packages/webapp/tests/ui/theme-engine.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TOKEN_GROUPS } from '../../src/ui/theme-types.js';
import type { SliccTheme, SimplifiedSlots } from '../../src/ui/theme-types.js';

describe('theme-types', () => {
  it('TOKEN_GROUPS covers all expected categories', () => {
    expect(Object.keys(TOKEN_GROUPS)).toEqual(
      expect.arrayContaining(['surfaces', 'text', 'accents', 'semantic', 'chrome'])
    );
  });

  it('every TOKEN_GROUPS entry is a non-empty array of CSS variable names', () => {
    for (const [, tokens] of Object.entries(TOKEN_GROUPS)) {
      expect(tokens.length).toBeGreaterThan(0);
      for (const t of tokens) {
        expect(t).toMatch(/^--/);
      }
    }
  });

  it('SliccTheme shape is exportable and usable', () => {
    const theme: SliccTheme = {
      id: 'test',
      name: 'Test',
      base: 'dark',
      tokens: { '--s2-gray-25': '#000' },
    };
    expect(theme.id).toBe('test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/theme-types.js`

- [ ] **Step 3: Implement theme-types.ts**

```typescript
// packages/webapp/src/ui/theme-types.ts
export interface SliccTheme {
  id: string;
  name: string;
  author?: string;
  base: 'dark' | 'light';
  tokens: Record<string, string>;
}

export interface SimplifiedSlots {
  background: string;
  surface: string;
  text: string;
  accent: string;
  border: string;
  success: string;
  error: string;
}

export const TOKEN_GROUPS: Record<string, string[]> = {
  surfaces: [
    '--s2-gray-25',
    '--s2-gray-50',
    '--s2-gray-75',
    '--s2-gray-100',
    '--s2-gray-200',
    '--s2-bg-base',
    '--s2-bg-layer-1',
    '--s2-bg-layer-2',
    '--s2-bg-elevated',
    '--s2-bg-sunken',
  ],
  text: [
    '--s2-gray-800',
    '--s2-gray-900',
    '--s2-gray-1000',
    '--s2-content-default',
    '--s2-content-secondary',
    '--s2-content-tertiary',
    '--s2-content-disabled',
  ],
  accents: [
    '--slicc-cone',
    '--slicc-scoop-blue',
    '--slicc-scoop-purple',
    '--slicc-scoop-teal',
    '--slicc-accent',
    '--s2-accent',
    '--s2-accent-hover',
    '--s2-accent-down',
  ],
  semantic: ['--s2-negative', '--s2-positive', '--s2-informative', '--s2-notice'],
  chrome: [
    '--s2-border-default',
    '--s2-border-subtle',
    '--s2-border-focus',
    '--s2-shadow-elevated',
    '--s2-shadow-container',
  ],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/theme-types.ts packages/webapp/tests/ui/theme-engine.test.ts
git commit -m "feat(theme): add theme types and token group constants"
```

---

### Task 2: Theme Engine — Derivation Logic

**Files:**

- Create: `packages/webapp/src/ui/theme-engine.ts`
- Modify: `packages/webapp/tests/ui/theme-engine.test.ts`

- [ ] **Step 1: Write failing tests for deriveTokens**

Add to `packages/webapp/tests/ui/theme-engine.test.ts`:

```typescript
import { deriveTokens } from '../../src/ui/theme-engine.js';
import type { SimplifiedSlots } from '../../src/ui/theme-types.js';

describe('deriveTokens', () => {
  const darkSlots: SimplifiedSlots = {
    background: '#1a1a2e',
    surface: '#25254a',
    text: '#e8e8e8',
    accent: '#3562ff',
    border: '#3a3a5a',
    success: '#2d9d78',
    error: '#e34850',
  };

  it('returns a Record<string, string> with CSS variable keys', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(typeof tokens).toBe('object');
    for (const key of Object.keys(tokens)) {
      expect(key).toMatch(/^--/);
    }
  });

  it('maps background slot to --s2-gray-25 and --s2-bg-base', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-gray-25']).toBe('#1a1a2e');
    expect(tokens['--s2-bg-base']).toBe('#1a1a2e');
  });

  it('maps accent slot to --s2-accent and derives hover/down states', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-accent']).toBe('#3562ff');
    expect(tokens['--s2-accent-hover']).toBeDefined();
    expect(tokens['--s2-accent-down']).toBeDefined();
    // hover should be lighter, down should be darker
    expect(tokens['--s2-accent-hover']).not.toBe(tokens['--s2-accent']);
    expect(tokens['--s2-accent-down']).not.toBe(tokens['--s2-accent']);
  });

  it('maps semantic slots directly', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-positive']).toBe('#2d9d78');
    expect(tokens['--s2-negative']).toBe('#e34850');
  });

  it('generates surface variants from background via lightness shifts', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    // gray-50, gray-75, gray-100 should exist and differ from background
    expect(tokens['--s2-gray-50']).toBeDefined();
    expect(tokens['--s2-gray-75']).toBeDefined();
    expect(tokens['--s2-gray-50']).not.toBe(tokens['--s2-gray-25']);
  });

  it('works with light base', () => {
    const lightSlots: SimplifiedSlots = {
      background: '#ffffff',
      surface: '#f8f8f8',
      text: '#131313',
      accent: '#3b63fb',
      border: '#dadada',
      success: '#05834e',
      error: '#d92361',
    };
    const tokens = deriveTokens(lightSlots, 'light');
    expect(tokens['--s2-gray-25']).toBe('#ffffff');
    expect(tokens['--s2-content-default']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/theme-engine.js`

- [ ] **Step 3: Implement deriveTokens in theme-engine.ts**

```typescript
// packages/webapp/src/ui/theme-engine.ts
import type { SimplifiedSlots, SliccTheme } from './theme-types.js';

// --- HSL Utilities ---

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h / 360 + 1 / 3);
    g = hue2rgb(p, q, h / 360);
    b = hue2rgb(p, q, h / 360 - 1 / 3);
  }
  const toHex = (n: number): string =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function adjustLightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.min(1, Math.max(0, l + delta)));
}

function adjustSaturation(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, Math.min(1, Math.max(0, s + delta)), l);
}

// --- Token Derivation ---

export function deriveTokens(
  slots: SimplifiedSlots,
  base: 'dark' | 'light'
): Record<string, string> {
  const isDark = base === 'dark';
  const step = isDark ? 0.03 : -0.02;
  const tokens: Record<string, string> = {};

  // Surfaces — derive gray scale from background
  tokens['--s2-gray-25'] = slots.background;
  tokens['--s2-bg-base'] = slots.background;
  tokens['--s2-gray-50'] = adjustLightness(slots.background, step);
  tokens['--s2-bg-layer-1'] = tokens['--s2-gray-50'];
  tokens['--s2-gray-75'] = adjustLightness(slots.background, step * 2);
  tokens['--s2-bg-layer-2'] = tokens['--s2-gray-75'];
  tokens['--s2-gray-100'] = adjustLightness(slots.background, step * 3);
  tokens['--s2-bg-elevated'] = tokens['--s2-gray-100'];
  tokens['--s2-gray-200'] = adjustLightness(slots.background, step * 5);
  tokens['--s2-bg-sunken'] = adjustLightness(slots.background, isDark ? -0.02 : 0.02);

  // Surface slot maps to mid-range grays
  tokens['--s2-gray-300'] = slots.surface;

  // Text — derive hierarchy from text color
  tokens['--s2-gray-900'] = slots.text;
  tokens['--s2-gray-1000'] = isDark ? '#ffffff' : '#000000';
  tokens['--s2-gray-800'] = adjustLightness(slots.text, isDark ? -0.08 : 0.08);
  tokens['--s2-content-default'] = slots.text;
  tokens['--s2-content-secondary'] = adjustLightness(slots.text, isDark ? -0.15 : 0.15);
  tokens['--s2-content-tertiary'] = adjustLightness(slots.text, isDark ? -0.25 : 0.25);
  tokens['--s2-content-disabled'] = adjustLightness(slots.text, isDark ? -0.35 : 0.35);

  // Mid grays (between surface and text)
  tokens['--s2-gray-400'] = adjustLightness(slots.border, isDark ? 0.05 : -0.05);
  tokens['--s2-gray-500'] = adjustLightness(slots.border, isDark ? 0.12 : -0.12);
  tokens['--s2-gray-600'] = adjustLightness(slots.text, isDark ? -0.3 : 0.3);
  tokens['--s2-gray-700'] = adjustLightness(slots.text, isDark ? -0.2 : 0.2);

  // Accents
  tokens['--s2-accent'] = slots.accent;
  tokens['--slicc-scoop-blue'] = slots.accent;
  tokens['--s2-accent-hover'] = adjustLightness(slots.accent, isDark ? 0.08 : -0.06);
  tokens['--s2-accent-down'] = adjustLightness(slots.accent, isDark ? -0.06 : 0.08);
  tokens['--slicc-cone'] = adjustSaturation(slots.accent, 0.1);
  tokens['--slicc-accent'] = slots.accent;
  tokens['--slicc-scoop-purple'] = adjustLightness(slots.accent, 0.1);
  tokens['--slicc-scoop-teal'] = adjustLightness(slots.accent, isDark ? 0.15 : -0.1);
  tokens['--s2-informative'] = slots.accent;

  // Semantic
  tokens['--s2-positive'] = slots.success;
  tokens['--s2-negative'] = slots.error;
  tokens['--s2-notice'] = adjustLightness(slots.error, 0.1);

  // Chrome
  tokens['--s2-border-default'] = slots.border;
  tokens['--s2-border-subtle'] = adjustLightness(slots.border, isDark ? -0.03 : 0.03);
  tokens['--s2-border-focus'] = slots.accent;

  return tokens;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/theme-engine.ts packages/webapp/tests/ui/theme-engine.test.ts
git commit -m "feat(theme): implement token derivation from simplified slots"
```

---

### Task 3: Theme Engine — Storage and Application

**Files:**

- Modify: `packages/webapp/src/ui/theme-engine.ts`
- Modify: `packages/webapp/tests/ui/theme-engine.test.ts`

- [ ] **Step 1: Write failing tests for storage and application**

Add to `packages/webapp/tests/ui/theme-engine.test.ts`:

```typescript
import {
  deriveTokens,
  getActiveThemeId,
  setActiveTheme,
  clearActiveTheme,
  getCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  applyThemeOverrides,
  exportTheme,
  importTheme,
} from '../../src/ui/theme-engine.js';

describe('theme storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('getActiveThemeId returns null when no theme is set', () => {
    expect(getActiveThemeId()).toBeNull();
  });

  it('setActiveTheme stores the id and applyThemeOverrides injects a style element', () => {
    const theme: SliccTheme = {
      id: 'test-theme',
      name: 'Test',
      base: 'dark',
      tokens: { '--s2-gray-25': '#112233' },
    };
    saveCustomTheme(theme);
    setActiveTheme('test-theme');
    expect(getActiveThemeId()).toBe('test-theme');

    applyThemeOverrides();
    const styleEl = document.getElementById('slicc-theme-overrides');
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).toContain('--s2-gray-25: #112233');
  });

  it('clearActiveTheme removes the override style', () => {
    const theme: SliccTheme = {
      id: 'x',
      name: 'X',
      base: 'dark',
      tokens: { '--s2-accent': '#ff0000' },
    };
    saveCustomTheme(theme);
    setActiveTheme('x');
    applyThemeOverrides();
    expect(document.getElementById('slicc-theme-overrides')).not.toBeNull();

    clearActiveTheme();
    applyThemeOverrides();
    expect(document.getElementById('slicc-theme-overrides')).toBeNull();
  });

  it('getCustomThemes returns saved themes', () => {
    const theme: SliccTheme = { id: 'a', name: 'A', base: 'light', tokens: {} };
    saveCustomTheme(theme);
    expect(getCustomThemes()).toEqual([theme]);
  });

  it('deleteCustomTheme removes a theme and clears active if it was active', () => {
    const theme: SliccTheme = { id: 'del', name: 'Del', base: 'dark', tokens: {} };
    saveCustomTheme(theme);
    setActiveTheme('del');
    deleteCustomTheme('del');
    expect(getCustomThemes()).toEqual([]);
    expect(getActiveThemeId()).toBeNull();
  });
});

describe('import/export', () => {
  it('exportTheme returns a JSON string of the SliccTheme', () => {
    const theme: SliccTheme = {
      id: 'exp',
      name: 'Export',
      base: 'dark',
      tokens: { '--x': '#abc' },
    };
    const json = exportTheme(theme);
    expect(JSON.parse(json)).toEqual(theme);
  });

  it('importTheme parses valid JSON and returns the theme', () => {
    const theme: SliccTheme = { id: 'imp', name: 'Import', base: 'light', tokens: {} };
    const result = importTheme(JSON.stringify(theme));
    expect(result).toEqual(theme);
  });

  it('importTheme throws on invalid shape', () => {
    expect(() => importTheme('{"foo": "bar"}')).toThrow();
    expect(() => importTheme('not json')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts`
Expected: FAIL — functions not exported from theme-engine

- [ ] **Step 3: Add storage and application functions to theme-engine.ts**

Add to `packages/webapp/src/ui/theme-engine.ts` (below the existing `deriveTokens`):

```typescript
import { PRESETS } from './theme-presets.js';

const STORAGE_THEMES = 'slicc-themes';
const STORAGE_ACTIVE = 'slicc-active-theme';
const STYLE_ID = 'slicc-theme-overrides';

export function getActiveThemeId(): string | null {
  return localStorage.getItem(STORAGE_ACTIVE) || null;
}

export function setActiveTheme(id: string): void {
  localStorage.setItem(STORAGE_ACTIVE, id);
}

export function clearActiveTheme(): void {
  localStorage.removeItem(STORAGE_ACTIVE);
}

export function getCustomThemes(): SliccTheme[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_THEMES) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomTheme(theme: SliccTheme): void {
  const themes = getCustomThemes().filter((t) => t.id !== theme.id);
  themes.push(theme);
  localStorage.setItem(STORAGE_THEMES, JSON.stringify(themes));
}

export function deleteCustomTheme(id: string): void {
  const themes = getCustomThemes().filter((t) => t.id !== id);
  localStorage.setItem(STORAGE_THEMES, JSON.stringify(themes));
  if (getActiveThemeId() === id) clearActiveTheme();
}

function resolveTheme(id: string): SliccTheme | undefined {
  return PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);
}

export function applyThemeOverrides(): void {
  const id = getActiveThemeId();
  const existing = document.getElementById(STYLE_ID);
  if (!id) {
    existing?.remove();
    return;
  }
  const theme = resolveTheme(id);
  if (!theme || Object.keys(theme.tokens).length === 0) {
    existing?.remove();
    return;
  }
  const css = `:root {\n${Object.entries(theme.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')}\n}`;
  if (existing) {
    existing.textContent = css;
  } else {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
}

export function exportTheme(theme: SliccTheme): string {
  return JSON.stringify(theme, null, 2);
}

export function importTheme(json: string): SliccTheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('id' in parsed) ||
    !('name' in parsed) ||
    !('base' in parsed) ||
    !('tokens' in parsed)
  ) {
    throw new Error('Invalid theme: missing required fields (id, name, base, tokens)');
  }
  const t = parsed as SliccTheme;
  if (t.base !== 'dark' && t.base !== 'light') {
    throw new Error('Invalid theme: base must be "dark" or "light"');
  }
  if (typeof t.tokens !== 'object' || t.tokens === null) {
    throw new Error('Invalid theme: tokens must be an object');
  }
  return t;
}
```

Note: This step introduces an import of `./theme-presets.js` which doesn't exist yet. Create a placeholder:

```typescript
// packages/webapp/src/ui/theme-presets.ts (placeholder — full presets in Task 4)
import type { SliccTheme } from './theme-types.js';
export const PRESETS: SliccTheme[] = [];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/theme-engine.ts packages/webapp/src/ui/theme-presets.ts packages/webapp/tests/ui/theme-engine.test.ts
git commit -m "feat(theme): add theme storage, application, and import/export"
```

---

### Task 4: Preset Themes

**Files:**

- Modify: `packages/webapp/src/ui/theme-presets.ts`
- Create: `packages/webapp/tests/ui/theme-presets.test.ts`

- [ ] **Step 1: Write failing test for presets**

```typescript
// packages/webapp/tests/ui/theme-presets.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/ui/theme-presets.js';

describe('theme presets', () => {
  it('has exactly 6 presets', () => {
    expect(PRESETS).toHaveLength(6);
  });

  it('each preset has required fields and at least 10 token overrides', () => {
    for (const preset of PRESETS) {
      expect(preset.id).toMatch(/^[a-z-]+$/);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(['dark', 'light']).toContain(preset.base);
      expect(Object.keys(preset.tokens).length).toBeGreaterThanOrEqual(10);
      for (const key of Object.keys(preset.tokens)) {
        expect(key).toMatch(/^--/);
      }
    }
  });

  it('has the expected preset ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'vanilla',
        'midnight-scoop',
        'matcha-float',
        'berry-cone',
        'caramel-swirl',
        'sorbet',
      ])
    );
  });

  it('all preset ids are unique', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-presets.test.ts`
Expected: FAIL — PRESETS has length 0

- [ ] **Step 3: Implement full presets**

Replace `packages/webapp/src/ui/theme-presets.ts`:

```typescript
// packages/webapp/src/ui/theme-presets.ts
import type { SliccTheme } from './theme-types.js';

export const PRESETS: SliccTheme[] = [
  {
    id: 'vanilla',
    name: 'Vanilla',
    base: 'light',
    tokens: {
      '--s2-gray-25': '#fffdf8',
      '--s2-gray-50': '#faf6f0',
      '--s2-gray-75': '#f5f0e8',
      '--s2-gray-100': '#ede7dc',
      '--s2-gray-200': '#e0d8cc',
      '--s2-gray-300': '#d4cbbf',
      '--s2-gray-400': '#b8ad9e',
      '--s2-gray-500': '#8c7f6f',
      '--s2-gray-600': '#6b5f50',
      '--s2-gray-700': '#4d4235',
      '--s2-gray-800': '#2e2418',
      '--s2-gray-900': '#1a1008',
      '--s2-gray-1000': '#000000',
      '--s2-bg-base': '#fffdf8',
      '--s2-bg-layer-1': '#faf6f0',
      '--s2-bg-layer-2': '#f5f0e8',
      '--s2-bg-elevated': '#ede7dc',
      '--s2-bg-sunken': '#f5f0e8',
      '--s2-accent': '#a0522d',
      '--s2-accent-hover': '#8b4513',
      '--s2-accent-down': '#6b3410',
      '--slicc-cone': '#d2691e',
      '--s2-border-default': '#d4cbbf',
      '--s2-border-subtle': '#e0d8cc',
    },
  },
  {
    id: 'midnight-scoop',
    name: 'Midnight Scoop',
    base: 'dark',
    tokens: {
      '--s2-gray-25': '#0d1117',
      '--s2-gray-50': '#131a24',
      '--s2-gray-75': '#1a2332',
      '--s2-gray-100': '#212d40',
      '--s2-gray-200': '#2d3b50',
      '--s2-gray-300': '#3a4a63',
      '--s2-gray-400': '#4d5f7a',
      '--s2-gray-500': '#6b7f99',
      '--s2-gray-600': '#8899b3',
      '--s2-gray-700': '#a8b8d0',
      '--s2-gray-800': '#cdd8e8',
      '--s2-gray-900': '#e8eef5',
      '--s2-gray-1000': '#ffffff',
      '--s2-bg-base': '#0d1117',
      '--s2-bg-layer-1': '#131a24',
      '--s2-bg-layer-2': '#1a2332',
      '--s2-bg-elevated': '#212d40',
      '--s2-bg-sunken': '#080c12',
      '--s2-accent': '#58a6ff',
      '--s2-accent-hover': '#79b8ff',
      '--s2-accent-down': '#3d8bda',
      '--slicc-cone': '#f0883e',
      '--s2-border-default': '#3a4a63',
      '--s2-border-subtle': '#2d3b50',
    },
  },
  {
    id: 'matcha-float',
    name: 'Matcha Float',
    base: 'dark',
    tokens: {
      '--s2-gray-25': '#0f1a14',
      '--s2-gray-50': '#14221b',
      '--s2-gray-75': '#1a2d23',
      '--s2-gray-100': '#21382c',
      '--s2-gray-200': '#2d4a3a',
      '--s2-gray-300': '#3a5c48',
      '--s2-gray-400': '#4d7360',
      '--s2-gray-500': '#6b9480',
      '--s2-gray-600': '#88b09c',
      '--s2-gray-700': '#a8c8b8',
      '--s2-gray-800': '#cce0d5',
      '--s2-gray-900': '#e8f2ec',
      '--s2-gray-1000': '#ffffff',
      '--s2-bg-base': '#0f1a14',
      '--s2-bg-layer-1': '#14221b',
      '--s2-bg-layer-2': '#1a2d23',
      '--s2-bg-elevated': '#21382c',
      '--s2-bg-sunken': '#0a120e',
      '--s2-accent': '#6bce9a',
      '--s2-accent-hover': '#88dbb0',
      '--s2-accent-down': '#4fb882',
      '--slicc-cone': '#a8d86c',
      '--s2-border-default': '#3a5c48',
      '--s2-border-subtle': '#2d4a3a',
    },
  },
  {
    id: 'berry-cone',
    name: 'Berry Cone',
    base: 'dark',
    tokens: {
      '--s2-gray-25': '#150a1a',
      '--s2-gray-50': '#1e1024',
      '--s2-gray-75': '#281830',
      '--s2-gray-100': '#33203d',
      '--s2-gray-200': '#44304f',
      '--s2-gray-300': '#574063',
      '--s2-gray-400': '#6e5580',
      '--s2-gray-500': '#8c7099',
      '--s2-gray-600': '#a88cb3',
      '--s2-gray-700': '#c0a8cc',
      '--s2-gray-800': '#d8c8e0',
      '--s2-gray-900': '#f0e8f4',
      '--s2-gray-1000': '#ffffff',
      '--s2-bg-base': '#150a1a',
      '--s2-bg-layer-1': '#1e1024',
      '--s2-bg-layer-2': '#281830',
      '--s2-bg-elevated': '#33203d',
      '--s2-bg-sunken': '#0f0614',
      '--s2-accent': '#e06be0',
      '--s2-accent-hover': '#e88ae8',
      '--s2-accent-down': '#c84ec8',
      '--slicc-cone': '#ff6b9d',
      '--s2-border-default': '#574063',
      '--s2-border-subtle': '#44304f',
    },
  },
  {
    id: 'caramel-swirl',
    name: 'Caramel Swirl',
    base: 'light',
    tokens: {
      '--s2-gray-25': '#fdf9f3',
      '--s2-gray-50': '#f8f2e8',
      '--s2-gray-75': '#f2eadd',
      '--s2-gray-100': '#e8dfd0',
      '--s2-gray-200': '#ddd2c0',
      '--s2-gray-300': '#d0c3b0',
      '--s2-gray-400': '#b8a890',
      '--s2-gray-500': '#8f7a60',
      '--s2-gray-600': '#6b5a42',
      '--s2-gray-700': '#4d3f2a',
      '--s2-gray-800': '#2e2515',
      '--s2-gray-900': '#1a1408',
      '--s2-gray-1000': '#000000',
      '--s2-bg-base': '#fdf9f3',
      '--s2-bg-layer-1': '#f8f2e8',
      '--s2-bg-layer-2': '#f2eadd',
      '--s2-bg-elevated': '#e8dfd0',
      '--s2-bg-sunken': '#f2eadd',
      '--s2-accent': '#c87830',
      '--s2-accent-hover': '#b06828',
      '--s2-accent-down': '#985820',
      '--slicc-cone': '#e89040',
      '--s2-border-default': '#d0c3b0',
      '--s2-border-subtle': '#ddd2c0',
    },
  },
  {
    id: 'sorbet',
    name: 'Sorbet',
    base: 'light',
    tokens: {
      '--s2-gray-25': '#fff8f6',
      '--s2-gray-50': '#fef0ed',
      '--s2-gray-75': '#fce8e3',
      '--s2-gray-100': '#f8ddd6',
      '--s2-gray-200': '#f0d0c8',
      '--s2-gray-300': '#e8c0b8',
      '--s2-gray-400': '#d4a89e',
      '--s2-gray-500': '#a8807a',
      '--s2-gray-600': '#80605c',
      '--s2-gray-700': '#5c4240',
      '--s2-gray-800': '#3a2826',
      '--s2-gray-900': '#1e1412',
      '--s2-gray-1000': '#000000',
      '--s2-bg-base': '#fff8f6',
      '--s2-bg-layer-1': '#fef0ed',
      '--s2-bg-layer-2': '#fce8e3',
      '--s2-bg-elevated': '#f8ddd6',
      '--s2-bg-sunken': '#fce8e3',
      '--s2-accent': '#e86050',
      '--s2-accent-hover': '#d04840',
      '--s2-accent-down': '#b83830',
      '--slicc-cone': '#ff7860',
      '--s2-border-default': '#e8c0b8',
      '--s2-border-subtle': '#f0d0c8',
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-presets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/theme-presets.ts packages/webapp/tests/ui/theme-presets.test.ts
git commit -m "feat(theme): add 6 SLICC-branded preset themes"
```

---

### Task 5: Hook Theme Engine into Existing Theme System

**Files:**

- Modify: `packages/webapp/src/ui/theme.ts`
- Modify: `packages/webapp/tests/ui/theme-wc.test.ts`

- [ ] **Step 1: Write failing test for theme override integration**

Add to `packages/webapp/tests/ui/theme-wc.test.ts`:

```typescript
import { applyTheme, initTheme } from '../../src/ui/theme.js';

describe('theme override integration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.body.className = '';
    document.body.removeAttribute('data-theme');
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('applyTheme calls applyThemeOverrides and injects style when a theme is active', async () => {
    const { saveCustomTheme, setActiveTheme } = await import('../../src/ui/theme-engine.js');
    saveCustomTheme({
      id: 'hook-test',
      name: 'Hook',
      base: 'dark',
      tokens: { '--s2-accent': '#ff0000' },
    });
    setActiveTheme('hook-test');
    applyTheme();
    const style = document.getElementById('slicc-theme-overrides');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('--s2-accent: #ff0000');
  });

  it('applyTheme removes overrides when no theme is active', async () => {
    const { saveCustomTheme, setActiveTheme, clearActiveTheme } =
      await import('../../src/ui/theme-engine.js');
    saveCustomTheme({
      id: 'rm-test',
      name: 'Rm',
      base: 'dark',
      tokens: { '--s2-accent': '#00ff00' },
    });
    setActiveTheme('rm-test');
    applyTheme();
    expect(document.getElementById('slicc-theme-overrides')).not.toBeNull();

    clearActiveTheme();
    applyTheme();
    expect(document.getElementById('slicc-theme-overrides')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-wc.test.ts`
Expected: FAIL — `applyTheme` doesn't call `applyThemeOverrides`

- [ ] **Step 3: Modify theme.ts to call applyThemeOverrides**

In `packages/webapp/src/ui/theme.ts`, add the import and call:

At the top, add:

```typescript
import { applyThemeOverrides } from './theme-engine.js';
```

In the `applyTheme()` function, add the call at the end:

```typescript
export function applyTheme(): void {
  const pref = getThemePreference();
  let isLight = pref === 'light';
  if (pref === 'system') {
    isLight = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  }
  document.documentElement.classList.toggle('theme-light', isLight);
  applyThemeOverrides(); // <-- add this line
  broadcastTheme();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-wc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/theme.ts packages/webapp/tests/ui/theme-wc.test.ts
git commit -m "feat(theme): hook theme-engine overrides into applyTheme"
```

---

### Task 6: Sprinkle/Dip Theme Override Broadcast

**Files:**

- Modify: `packages/webapp/src/ui/theme.ts`
- Modify: `packages/webapp/tests/ui/theme-wc.test.ts`

- [ ] **Step 1: Write failing test for override broadcast**

Add to `packages/webapp/tests/ui/theme-wc.test.ts`:

```typescript
import { registerSprinkleWindow } from '../../src/ui/theme.js';

describe('theme override broadcast to sprinkles', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('broadcasts overrides to registered sprinkle windows', async () => {
    const { saveCustomTheme, setActiveTheme } = await import('../../src/ui/theme-engine.js');
    const posts: unknown[] = [];
    const fakeWindow = {
      postMessage: (msg: unknown) => posts.push(msg),
    } as unknown as Window;
    registerSprinkleWindow(fakeWindow);

    saveCustomTheme({
      id: 'bc-test',
      name: 'BC',
      base: 'dark',
      tokens: { '--s2-accent': '#abcdef' },
    });
    setActiveTheme('bc-test');
    applyTheme();

    const msg = posts.find((p: any) => p.type === 'slicc-theme') as any;
    expect(msg).toBeDefined();
    expect(msg.overrides).toBeDefined();
    expect(msg.overrides['--s2-accent']).toBe('#abcdef');
  });

  it('broadcasts null overrides when no theme is active', async () => {
    const posts: unknown[] = [];
    const fakeWindow = {
      postMessage: (msg: unknown) => posts.push(msg),
    } as unknown as Window;
    registerSprinkleWindow(fakeWindow);

    applyTheme();

    const msg = posts.find((p: any) => p.type === 'slicc-theme') as any;
    expect(msg).toBeDefined();
    expect(msg.overrides).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-wc.test.ts`
Expected: FAIL — broadcast message doesn't have `overrides` field

- [ ] **Step 3: Modify broadcastTheme to include overrides**

In `packages/webapp/src/ui/theme.ts`, update `broadcastTheme` and add a helper:

```typescript
import { applyThemeOverrides, getActiveThemeId, getCustomThemes } from './theme-engine.js';
import { PRESETS } from './theme-presets.js';

function getActiveOverrides(): Record<string, string> | null {
  const id = getActiveThemeId();
  if (!id) return null;
  const theme = PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);
  return theme?.tokens ?? null;
}

function broadcastTheme(): void {
  const isLight = isThemeLight();
  const overrides = getActiveOverrides();
  for (const w of sprinkleWindows) {
    try {
      w.postMessage({ type: 'slicc-theme', isLight, overrides }, '*');
    } catch {
      sprinkleWindows.delete(w);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-wc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/theme.ts packages/webapp/tests/ui/theme-wc.test.ts
git commit -m "feat(theme): broadcast custom theme overrides to sprinkle iframes"
```

---

### Task 7: Settings Dialog — Appearance Section (Preset Grid)

**Files:**

- Create: `packages/webapp/src/ui/styles/theme-builder.css`
- Modify: `packages/webapp/src/ui/wc/wc-settings.ts`

- [ ] **Step 1: Create the theme-builder CSS**

```css
/* packages/webapp/src/ui/styles/theme-builder.css */
.wcset__appearance {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.wcset__section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--txt-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.wcset__preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wcset__preset-swatch {
  width: 56px;
  height: 48px;
  border-radius: 8px;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: border-color 130ms ease;
}
.wcset__preset-swatch:hover {
  border-color: var(--ctx);
}
.wcset__preset-swatch--active {
  border-color: var(--ink);
}
.wcset__preset-swatch__stripe {
  flex: 1;
}
.wcset__preset-name {
  font-size: 9px;
  text-align: center;
  padding: 2px 0;
  background: var(--canvas);
  color: var(--txt-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wcset__custom-themes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wcset__custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.wcset__custom-row__name {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wcset__builder {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--canvas);
}
.wcset__builder-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wcset__builder-row label {
  font-size: 11px;
  color: var(--txt-2);
  min-width: 80px;
}
.wcset__builder-row input[type='color'] {
  width: 32px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
  background: transparent;
}
.wcset__builder-row input[type='color']::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.wcset__builder-row input[type='color']::-webkit-color-swatch {
  border-radius: 2px;
  border: none;
}
.wcset__advanced-toggle {
  font-size: 11px;
  color: var(--ctx);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  text-decoration: underline;
}
.wcset__advanced-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.wcset__advanced-token {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--txt-3);
}
.wcset__advanced-token input[type='color'] {
  width: 20px;
  height: 16px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  background: transparent;
}
.wcset__base-toggle {
  display: flex;
  gap: 4px;
}
.wcset__base-toggle button {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--txt-2);
  cursor: pointer;
}
.wcset__base-toggle button.active {
  background: var(--ink);
  color: var(--canvas);
  border-color: var(--ink);
}
```

- [ ] **Step 2: Add the Appearance section to wc-settings.ts**

Modify `packages/webapp/src/ui/wc/wc-settings.ts`. At the top, add imports:

```typescript
import { PRESETS } from '../theme-presets.js';
import {
  getActiveThemeId,
  setActiveTheme,
  clearActiveTheme,
  getCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  applyThemeOverrides,
  exportTheme,
  importTheme,
  deriveTokens,
} from '../theme-engine.js';
import { TOKEN_GROUPS } from '../theme-types.js';
import type { SliccTheme, SimplifiedSlots } from '../theme-types.js';
import { applyTheme } from '../theme.js';
```

Add a new CSS section to the existing `CSS` constant (append before the closing backtick):

```typescript
// At the end of the CSS string, add an import
import '../styles/theme-builder.css';
```

Actually — since wc-settings uses an inline `<style>` element, we should inline the theme-builder CSS into the same constant OR load it separately. The cleanest approach: append the theme-builder classes to the existing `CSS` constant in `wc-settings.ts`. Add these lines to the `CSS` template literal (before the closing backtick):

```css
.wcset__appearance {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.wcset__section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--txt-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.wcset__preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wcset__preset-swatch {
  width: 56px;
  height: 48px;
  border-radius: 8px;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: border-color 130ms ease;
}
.wcset__preset-swatch:hover {
  border-color: var(--ctx);
}
.wcset__preset-swatch--active {
  border-color: var(--ink);
}
.wcset__preset-swatch__stripe {
  flex: 1;
}
.wcset__preset-name {
  font-size: 9px;
  text-align: center;
  padding: 2px 0;
  background: var(--canvas);
  color: var(--txt-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wcset__custom-themes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wcset__custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.wcset__custom-row__name {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wcset__builder {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--canvas);
}
.wcset__builder-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wcset__builder-row label {
  font-size: 11px;
  color: var(--txt-2);
  min-width: 80px;
}
.wcset__builder-row input[type='color'] {
  width: 32px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
  background: transparent;
}
.wcset__builder-row input[type='color']::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.wcset__builder-row input[type='color']::-webkit-color-swatch {
  border-radius: 2px;
  border: none;
}
.wcset__advanced-toggle {
  font-size: 11px;
  color: var(--ctx);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  text-decoration: underline;
}
.wcset__advanced-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.wcset__advanced-token {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--txt-3);
}
.wcset__advanced-token input[type='color'] {
  width: 20px;
  height: 16px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  background: transparent;
}
.wcset__base-toggle {
  display: flex;
  gap: 4px;
}
.wcset__base-toggle button {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--txt-2);
  cursor: pointer;
}
.wcset__base-toggle button.active {
  background: var(--ink);
  color: var(--canvas);
  border-color: var(--ink);
}
```

Then add a `buildAppearanceSection` function:

```typescript
function buildAppearanceSection(deps: ViewDeps): HTMLElement {
  const section = div('wcset__appearance');
  section.append(div('wcset__section-label', 'Appearance'));

  const activeId = getActiveThemeId();

  // Preset grid
  const grid = div('wcset__preset-grid');

  // Default (no theme) swatch
  const defaultSwatch = document.createElement('div');
  defaultSwatch.className = `wcset__preset-swatch${!activeId ? ' wcset__preset-swatch--active' : ''}`;
  defaultSwatch.innerHTML = `<div class="wcset__preset-swatch__stripe" style="background:#1a1a1a"></div><div class="wcset__preset-swatch__stripe" style="background:#2c2c2c"></div><div class="wcset__preset-swatch__stripe" style="background:#3562ff"></div><div class="wcset__preset-name">Default</div>`;
  defaultSwatch.addEventListener('click', () => {
    clearActiveTheme();
    applyTheme();
    rebuildAppearance();
  });
  grid.append(defaultSwatch);

  for (const preset of PRESETS) {
    const swatch = document.createElement('div');
    swatch.className = `wcset__preset-swatch${activeId === preset.id ? ' wcset__preset-swatch--active' : ''}`;
    const bg = preset.tokens['--s2-gray-25'] || '#1a1a1a';
    const surface = preset.tokens['--s2-gray-100'] || '#2c2c2c';
    const accent = preset.tokens['--s2-accent'] || '#3562ff';
    swatch.innerHTML = `<div class="wcset__preset-swatch__stripe" style="background:${bg}"></div><div class="wcset__preset-swatch__stripe" style="background:${surface}"></div><div class="wcset__preset-swatch__stripe" style="background:${accent}"></div><div class="wcset__preset-name">${preset.name}</div>`;
    swatch.addEventListener('click', () => {
      setActiveTheme(preset.id);
      applyTheme();
      rebuildAppearance();
    });
    grid.append(swatch);
  }
  section.append(grid);

  // Custom themes list
  const customs = getCustomThemes();
  if (customs.length > 0) {
    const customSection = div('wcset__custom-themes');
    customSection.append(div('wcset__section-label', 'My Themes'));
    for (const theme of customs) {
      const row = div('wcset__custom-row');
      const name = div('wcset__custom-row__name', theme.name);
      if (activeId === theme.id) name.style.fontWeight = '700';
      row.append(name);
      row.append(
        button('wcset__btn', 'Use', () => {
          setActiveTheme(theme.id);
          applyTheme();
          rebuildAppearance();
        })
      );
      row.append(
        button('wcset__btn', 'Edit', () => {
          showBuilder(theme);
        })
      );
      row.append(
        button('wcset__btn', 'Export', () => {
          const blob = new Blob([exportTheme(theme)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${theme.name.toLowerCase().replace(/\s+/g, '-')}.slicc-theme.json`;
          a.click();
          URL.revokeObjectURL(url);
        })
      );
      row.append(
        button('wcset__btn wcset__btn--danger', '×', () => {
          deleteCustomTheme(theme.id);
          applyTheme();
          rebuildAppearance();
        })
      );
      customSection.append(row);
    }
    section.append(customSection);
  }

  // Create + Import buttons
  const actions = div('');
  actions.style.cssText = 'display:flex;gap:8px;';
  actions.append(
    button('wcset__btn wcset__btn--primary', '+ Create Custom Theme', () => {
      showBuilder(null);
    })
  );
  actions.append(
    button('wcset__btn', 'Import Theme…', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        file.text().then((text) => {
          try {
            const theme = importTheme(text);
            saveCustomTheme(theme);
            deps.setStatus(`Imported "${theme.name}".`);
            rebuildAppearance();
          } catch (err) {
            deps.setStatus(
              `Import failed: ${err instanceof Error ? err.message : String(err)}`,
              true
            );
          }
        });
      });
      input.click();
    })
  );
  section.append(actions);

  // Builder slot
  const builderSlot = div('');
  section.append(builderSlot);

  function rebuildAppearance(): void {
    const parent = section.parentElement;
    if (!parent) return;
    const newSection = buildAppearanceSection(deps);
    parent.replaceChild(newSection, section);
  }

  function showBuilder(existing: SliccTheme | null): void {
    builderSlot.replaceChildren(buildThemeBuilder(existing, deps, rebuildAppearance));
  }

  return section;
}
```

- [ ] **Step 3: Wire appearance section into showWcSettings**

In the `showWcSettings` function, insert the appearance section before the account list. Find the line `body.append(list, addSectionSlot, status);` and change it to:

```typescript
const appearance = buildAppearanceSection(deps);
body.append(appearance, list, addSectionSlot, status);
```

Also update the dialog heading from `'Accounts'` to `'Settings'`.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors in modified files)

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/wc/wc-settings.ts packages/webapp/src/ui/styles/theme-builder.css
git commit -m "feat(theme): add Appearance section with preset grid to settings dialog"
```

---

### Task 8: Settings Dialog — Custom Theme Builder

**Files:**

- Modify: `packages/webapp/src/ui/wc/wc-settings.ts`

- [ ] **Step 1: Implement buildThemeBuilder function**

Add to `packages/webapp/src/ui/wc/wc-settings.ts`:

```typescript
function buildThemeBuilder(
  existing: SliccTheme | null,
  deps: ViewDeps,
  onDone: () => void
): HTMLElement {
  const builder = div('wcset__builder');
  let base: 'dark' | 'light' = existing?.base ?? 'dark';
  let showAdvanced = false;
  const slots: SimplifiedSlots = {
    background: existing?.tokens['--s2-gray-25'] || (base === 'dark' ? '#1a1a1a' : '#ffffff'),
    surface: existing?.tokens['--s2-gray-300'] || (base === 'dark' ? '#4a4a4a' : '#dadada'),
    text: existing?.tokens['--s2-gray-900'] || (base === 'dark' ? '#e8e8e8' : '#131313'),
    accent: existing?.tokens['--s2-accent'] || '#3562ff',
    border: existing?.tokens['--s2-border-default'] || (base === 'dark' ? '#4a4a4a' : '#dadada'),
    success: existing?.tokens['--s2-positive'] || '#2d9d78',
    error: existing?.tokens['--s2-negative'] || '#e34850',
  };
  let manualOverrides: Record<string, string> = existing ? { ...existing.tokens } : {};

  const nameInput = document.createElement('input');
  nameInput.className = 'wcset__input';
  nameInput.placeholder = 'Theme name';
  nameInput.value = existing?.name ?? '';

  function generateId(): string {
    return (
      nameInput.value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'custom-' + Date.now()
    );
  }

  function livePreview(): void {
    const derived = deriveTokens(slots, base);
    const merged = { ...derived, ...manualOverrides };
    const tempTheme: SliccTheme = { id: '__preview', name: 'Preview', base, tokens: merged };
    saveCustomTheme(tempTheme);
    setActiveTheme('__preview');
    applyTheme();
  }

  function renderBuilder(): void {
    builder.replaceChildren();

    // Name
    const nameRow = div('wcset__builder-row');
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameRow.append(nameLabel, nameInput);
    builder.append(nameRow);

    // Base toggle
    const baseRow = div('wcset__builder-row');
    const baseLabel = document.createElement('label');
    baseLabel.textContent = 'Base';
    const baseToggle = div('wcset__base-toggle');
    const darkBtn = document.createElement('button');
    darkBtn.textContent = 'Dark';
    darkBtn.className = base === 'dark' ? 'active' : '';
    darkBtn.addEventListener('click', () => {
      base = 'dark';
      renderBuilder();
      livePreview();
    });
    const lightBtn = document.createElement('button');
    lightBtn.textContent = 'Light';
    lightBtn.className = base === 'light' ? 'active' : '';
    lightBtn.addEventListener('click', () => {
      base = 'light';
      renderBuilder();
      livePreview();
    });
    baseToggle.append(darkBtn, lightBtn);
    baseRow.append(baseLabel, baseToggle);
    builder.append(baseRow);

    // Simplified slot pickers
    const slotEntries: [keyof SimplifiedSlots, string][] = [
      ['background', 'Background'],
      ['surface', 'Surface'],
      ['text', 'Text'],
      ['accent', 'Accent'],
      ['border', 'Border'],
      ['success', 'Success'],
      ['error', 'Error'],
    ];
    for (const [key, label] of slotEntries) {
      const row = div('wcset__builder-row');
      const lbl = document.createElement('label');
      lbl.textContent = label;
      const input = document.createElement('input');
      input.type = 'color';
      input.value = slots[key];
      input.addEventListener('input', () => {
        slots[key] = input.value;
        livePreview();
      });
      row.append(lbl, input);
      builder.append(row);
    }

    // Advanced toggle
    const advBtn = document.createElement('button');
    advBtn.className = 'wcset__advanced-toggle';
    advBtn.textContent = showAdvanced ? 'Hide advanced' : 'Show advanced';
    advBtn.addEventListener('click', () => {
      showAdvanced = !showAdvanced;
      renderBuilder();
    });
    builder.append(advBtn);

    // Advanced grid
    if (showAdvanced) {
      const derived = deriveTokens(slots, base);
      for (const [group, tokens] of Object.entries(TOKEN_GROUPS)) {
        builder.append(div('wcset__section-label', group));
        const grid = div('wcset__advanced-grid');
        for (const token of tokens) {
          const item = div('wcset__advanced-token');
          const input = document.createElement('input');
          input.type = 'color';
          input.value = manualOverrides[token] || derived[token] || '#000000';
          input.addEventListener('input', () => {
            manualOverrides[token] = input.value;
            livePreview();
          });
          const label = document.createElement('span');
          label.textContent = token.replace('--s2-', '').replace('--slicc-', '');
          item.append(input, label);
          grid.append(item);
        }
        builder.append(grid);
      }
    }

    // Save / Cancel
    const actions = div('');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    actions.append(
      button('wcset__btn wcset__btn--primary', 'Save', () => {
        const name = nameInput.value.trim();
        if (!name) {
          deps.setStatus('Name is required.', true);
          return;
        }
        const derived = deriveTokens(slots, base);
        const tokens = { ...derived, ...manualOverrides };
        const id = existing?.id ?? generateId();
        const theme: SliccTheme = { id, name, base, tokens };
        // Remove preview
        deleteCustomTheme('__preview');
        saveCustomTheme(theme);
        setActiveTheme(id);
        applyTheme();
        deps.setStatus(`Saved "${name}".`);
        onDone();
      })
    );
    actions.append(
      button('wcset__btn', 'Cancel', () => {
        deleteCustomTheme('__preview');
        // Restore previous theme
        if (existing) setActiveTheme(existing.id);
        else clearActiveTheme();
        applyTheme();
        onDone();
      })
    );
    builder.append(actions);
  }

  renderBuilder();
  livePreview();
  return builder;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Manual test — run dev server**

Run: `npm run dev`

Open the settings dialog in the browser and verify:

1. The preset grid renders with colored swatches
2. Clicking a preset applies the theme immediately
3. "Create Custom Theme" opens the builder
4. Color pickers update the UI in real time
5. "Advanced" toggle reveals per-token controls
6. Save persists the theme and it appears in "My Themes"
7. Export downloads a JSON file
8. Import loads a JSON file

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/ui/wc/wc-settings.ts
git commit -m "feat(theme): add custom theme builder with tiered controls"
```

---

### Task 9: Final Integration Test and Cleanup

**Files:**

- All theme files (verify no lint/type errors)
- Modify: `packages/webapp/tests/ui/theme-engine.test.ts` (add integration test)

- [ ] **Step 1: Add integration test for full flow**

Add to `packages/webapp/tests/ui/theme-engine.test.ts`:

```typescript
describe('full theme flow integration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('preset → apply → switch to custom → export → import → delete flow', () => {
    // Apply a preset
    setActiveTheme('midnight-scoop');
    applyThemeOverrides();
    let style = document.getElementById('slicc-theme-overrides');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('--s2-gray-25');

    // Create and save a custom theme
    const custom: SliccTheme = {
      id: 'my-custom',
      name: 'My Custom',
      base: 'dark',
      tokens: deriveTokens(
        {
          background: '#1a1a2e',
          surface: '#25254a',
          text: '#e8e8e8',
          accent: '#ff6600',
          border: '#3a3a5a',
          success: '#00ff00',
          error: '#ff0000',
        },
        'dark'
      ),
    };
    saveCustomTheme(custom);
    setActiveTheme('my-custom');
    applyThemeOverrides();
    style = document.getElementById('slicc-theme-overrides');
    expect(style!.textContent).toContain('--s2-accent: #ff6600');

    // Export and reimport
    const json = exportTheme(custom);
    const reimported = importTheme(json);
    expect(reimported.id).toBe('my-custom');
    expect(reimported.tokens['--s2-accent']).toBe('#ff6600');

    // Delete
    deleteCustomTheme('my-custom');
    expect(getCustomThemes()).toEqual([]);
    expect(getActiveThemeId()).toBeNull();
    applyThemeOverrides();
    expect(document.getElementById('slicc-theme-overrides')).toBeNull();
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm run test -- --run packages/webapp/tests/ui/theme-engine.test.ts packages/webapp/tests/ui/theme-presets.test.ts packages/webapp/tests/ui/theme-wc.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run full verification**

Run: `npm run typecheck && npm run test`
Expected: PASS — no regressions

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/tests/ui/theme-engine.test.ts
git commit -m "test(theme): add integration test for full theme lifecycle"
```

---

### Task 10: Documentation

**Files:**

- The theme-builder.css file (created in Task 7, ensure committed)
- Verify all files are committed

- [ ] **Step 1: Verify all new/modified files are tracked**

Run: `git status`
Expected: Clean working tree (all changes committed)

- [ ] **Step 2: Run the full pre-push verification**

Run: `npm run typecheck && npm run test && npm run build -w @slicc/webapp`
Expected: ALL PASS

- [ ] **Step 3: Final commit if any fixups needed**

If any lint/type/test fixes were needed, commit them:

```bash
git add -A
git commit -m "fix(theme): address lint and type issues"
```
