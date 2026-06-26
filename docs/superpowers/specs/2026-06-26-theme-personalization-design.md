# Theme Personalization System

## Overview

A theming system for the SLICC UI that lets users select from curated preset themes (SLICC-branded) or build fully custom themes with tiered granularity (simplified slots or advanced per-token control). Custom themes can be exported as JSON files and imported by others.

## Data Model

```typescript
interface SliccTheme {
  id: string; // unique slug, e.g. "midnight-scoop"
  name: string; // display name, e.g. "Midnight Scoop"
  author?: string; // for shared themes
  base: 'dark' | 'light'; // which base palette unspecified tokens inherit from
  tokens: Record<string, string>; // CSS variable overrides
}

interface SimplifiedSlots {
  background: string;
  surface: string;
  text: string;
  accent: string;
  border: string;
  success: string;
  error: string;
}
```

Presets and custom themes share the same `SliccTheme` shape. The `tokens` map only contains overrides — anything not specified falls through to the base dark/light defaults.

### Storage

- `localStorage['slicc-themes']` — JSON array of user-created `SliccTheme` objects
- `localStorage['slicc-active-theme']` — the `id` of the currently applied theme (`null` for default dark/light)

### Export Format

The `SliccTheme` JSON object saved as `<theme-name>.slicc-theme.json`.

## Preset Themes

Six SLICC-branded presets bundled in code:

| ID               | Name           | Base  | Vibe                                                |
| ---------------- | -------------- | ----- | --------------------------------------------------- |
| `vanilla`        | Vanilla        | light | Warm cream backgrounds, soft browns, classic clean  |
| `midnight-scoop` | Midnight Scoop | dark  | Deep navy/indigo, cool blue accents, starry feel    |
| `matcha-float`   | Matcha Float   | dark  | Dark greens, mint accents, earthy calm              |
| `berry-cone`     | Berry Cone     | dark  | Deep purple backgrounds, magenta/pink accents, rich |
| `caramel-swirl`  | Caramel Swirl  | light | Warm amber/tan surfaces, golden accents, cozy       |
| `sorbet`         | Sorbet         | light | Pastel pink/peach surfaces, coral accents, playful  |

The existing default dark/light modes remain as-is with no overrides. Presets are additive.

## Custom Theme Builder

### Simplified Tier (Default View)

Seven high-level slots exposed as color pickers:

| Slot       | Controls                                          | Derivation                                                  |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Background | Main canvas/page background                       | Generates surface variants via HSL lightness shifts         |
| Surface    | Cards, panels, inputs                             | ±5-10% lightness from Background                            |
| Text       | Primary text color                                | Derives secondary/muted text at lower opacity               |
| Accent     | Primary interactive color (buttons, links, focus) | Derives hover/active states via saturation/lightness shifts |
| Border     | Dividers, separators                              | Direct mapping                                              |
| Success    | Positive semantic color                           | Direct mapping                                              |
| Error      | Negative semantic color                           | Direct mapping                                              |

From these 7 values, `deriveTokens()` generates the full token override map (~30-40 tokens) using HSL math.

### Advanced Tier (Toggle to Reveal)

Exposes generated tokens grouped by category, individually editable:

- **Surfaces** (8-10 tokens): gray scale steps, canvas, elevated surface
- **Text** (4-5 tokens): primary, secondary, muted, inverse
- **Accents** (4-5 tokens): cone color, scoop colors, interactive states
- **Semantic** (4 tokens): success, error, warning, info
- **Chrome** (4-5 tokens): borders, shadows, scrollbar, selection

Toggling back to simplified and changing a slot re-derives only tokens the user hasn't manually overridden. A "Reset to derived" option clears manual overrides.

### Live Preview

Changes apply immediately to the UI behind the dialog so users see the result in real time.

## Settings UI Integration

The "Appearance" section is added as the first section in the existing `wc-settings.ts` dialog, above provider settings.

### Layout

```
┌─ Settings ──────────────────────────────┐
│                                         │
│  Appearance                             │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│  │     │ │     │ │     │ │     │ ...   │
│  │Dark │ │Vanil│ │Midnt│ │Match│       │
│  └─────┘ └─────┘ └─────┘ └─────┘      │
│                                         │
│  [+ Create Custom Theme]                │
│                                         │
│  ─────────────────────────────────      │
│  My Themes                              │
│  • "My Theme 1"  [Edit] [Export] [×]    │
│  • "My Theme 2"  [Edit] [Export] [×]    │
│                                         │
│  [Import Theme...]                      │
│                                         │
│  ─────────────────────────────────      │
│  Providers                              │
│  ...                                    │
└─────────────────────────────────────────┘
```

### Preset Grid

Small swatches showing a miniature color preview (3-4 colored stripes representing background, surface, accent, text). Clicking applies immediately. Active theme gets a ring/check indicator.

### Custom Theme Editing

"Create" or "Edit" expands an inline panel with:

- Name input field
- Base selector (dark/light toggle)
- 7 simplified slots as color pickers
- "Advanced" toggle revealing per-token overrides
- "Save" / "Cancel" buttons

### Import/Export

- **Import:** File picker accepting `.json`, validates `SliccTheme` shape, adds to "My Themes"
- **Export:** Downloads as `<theme-name>.slicc-theme.json`

## Implementation Architecture

### New Files

| Path                                              | Purpose                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/webapp/src/ui/theme-engine.ts`          | Core logic: apply/remove overrides, derive tokens from simplified slots, load/save/export/import |
| `packages/webapp/src/ui/theme-presets.ts`         | Static preset `SliccTheme` objects                                                               |
| `packages/webapp/src/ui/styles/theme-builder.css` | Styles for the builder UI within settings dialog                                                 |

### Modified Files

| Path                                       | Change                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `packages/webapp/src/ui/theme.ts`          | Hook into theme-engine on init — apply overrides after base dark/light class is set |
| `packages/webapp/src/ui/wc/wc-settings.ts` | Add Appearance section (preset grid, custom theme list, builder panel)              |

### Application Flow

```
initTheme() [existing]
  → applyTheme() sets base dark/light class on <html>
  → applyThemeOverrides() [new]
    → reads active theme id from localStorage['slicc-active-theme']
    → looks up theme in presets or localStorage['slicc-themes']
    → injects/updates <style id="slicc-theme-overrides"> on :root with token overrides
    → broadcasts overrides to sprinkle iframes via existing theme broadcast mechanism
```

### Token Derivation

Pure function `deriveTokens(slots: SimplifiedSlots, base: 'dark' | 'light'): Record<string, string>`:

- Converts hex → HSL
- Generates surface variants by shifting lightness ±5-10%
- Generates text hierarchy via opacity reduction
- Generates accent hover/active states via saturation/lightness shifts
- Maps derived values to the actual CSS custom property names from `tokens.css`
- No external dependencies — native HSL math, under ~100 lines

### Sprinkle/Dip Sync

The existing `watchSprinkleThemeBroadcast()` mechanism propagates theme changes to embedded surfaces. The override `<style>` element content is included in the broadcast payload so sprinkle sandboxes receive custom theme tokens.

## Constraints

- No external color libraries — HSL math is sufficient for the derivation logic
- Presets are bundled in code, not fetched from network
- localStorage only (no VFS persistence in v1)
- Must work in both CLI and extension floats
- Custom theme file extension: `.slicc-theme.json`

## Future Considerations (Out of Scope)

- VFS-backed theme storage for persistence and git-tracking
- Shareable URLs encoding theme data
- Theme marketplace / community sharing
- Auto-contrast validation / WCAG compliance checking
