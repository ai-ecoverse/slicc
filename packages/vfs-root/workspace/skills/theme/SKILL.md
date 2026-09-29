---
name: theme
description: |
  Use this when the user wants to change the SLICC UI appearance — switch
  preset themes, create custom themes, adjust colors, toggle the animated
  background, or export/import theme files. Covers the theme shell command,
  full token reference, and the JSON format for programmatic theming.
allowed-tools: bash, read_file, write_file, edit
---

# Theme

`theme` shell command or avatar → Theme settings. Dialog: pick two themes — darker applies in Dark, brighter in Light. One active always; third pick replaces older.

## Shell command

```bash
theme list
theme apply <id>
theme apply <path>
theme reset
theme export <id> <path>
```

Unknown flags exit non-zero (`theme <sub>: unknown flag: …`).

### Agent workflow

1. Write theme JSON to VFS
2. `theme apply <path>`

```bash
cat > /shared/my-theme.slicc-theme.json << 'EOF'
{
  "id": "my-theme",
  "name": "My Theme",
  "base": "dark",
  "disableShader": true,
  "tokens": {
    "--canvas": "#0f0f1a", "--bg": "#0a0a12", "--ghost": "#1a1a2e", "--desk": "#1a1a2e",
    "--ink": "#e8e8f0", "--deep": "#e8e8f0", "--txt-2": "#9898b0", "--txt-3": "#686888",
    "--line": "#2a2a40", "--ctx": "#6c5ce7", "--waffle": "#6c5ce7", "--shaderbg": "#0f0f1a",
    "--s2-gray-25": "#0f0f1a", "--s2-gray-50": "#141422", "--s2-gray-75": "#1a1a2e",
    "--s2-gray-100": "#20203a", "--s2-gray-200": "#2a2a45", "--s2-gray-300": "#3a3a55",
    "--s2-gray-900": "#e8e8f0", "--s2-gray-1000": "#ffffff",
    "--s2-bg-base": "#0f0f1a", "--s2-bg-layer-1": "#141422", "--s2-bg-layer-2": "#1a1a2e",
    "--s2-bg-elevated": "#20203a", "--s2-bg-sunken": "#0a0a12",
    "--s2-content-default": "#e8e8f0", "--s2-content-secondary": "#b8b8d0", "--s2-content-tertiary": "#8888a0",
    "--s2-accent": "#6c5ce7", "--s2-accent-hover": "#8577ed", "--s2-accent-down": "#5a4bd4",
    "--s2-border-default": "#2a2a40", "--s2-border-subtle": "#222238",
    "--s2-positive": "#2d9d78", "--s2-negative": "#e34850"
  }
}
EOF
theme apply /shared/my-theme.slicc-theme.json
```

## Presets

| ID               | Name           | Base  |
| ---------------- | -------------- | ----- |
| `vanilla`        | Vanilla        | light |
| `midnight-scoop` | Midnight Scoop | dark  |
| `matcha-float`   | Matcha Float   | dark  |
| `berry-cone`     | Berry Cone     | dark  |
| `caramel-swirl`  | Caramel Swirl  | light |
| `sorbet`         | Sorbet         | light |

All presets disable shader.

## JSON format

```typescript
interface SliccTheme {
  id: string;
  name: string;
  base: 'dark' | 'light';
  disableShader?: boolean;
  tokens: Record<string, string>;
  css?: string;
  components?: Record<string, ThemeComponent>;
}
```

`tokens` overrides any CSS custom property. `css` injects rules after tokens. `components` per-part styling.

### WC shell tokens

| Token                | Purpose                 |
| -------------------- | ----------------------- |
| `--canvas`           | Page bg                 |
| `--bg`               | Sunken bg               |
| `--ghost`, `--desk`  | Hover / panel           |
| `--ink`, `--deep`    | Primary / emphatic text |
| `--txt-2`, `--txt-3` | Secondary / muted       |
| `--line`             | Borders                 |
| `--ctx`, `--waffle`  | Accent / nav tint       |
| `--shaderbg`         | Shader base             |

### S2 tokens

`--s2-gray-25`…`--s2-gray-1000`, `--s2-bg-base`, `--s2-bg-layer-1/2`, `--s2-bg-elevated`, `--s2-bg-sunken`, `--s2-content-default/secondary/tertiary/disabled`, `--s2-accent/hover/down`, `--s2-border-default/subtle/focus`, `--s2-positive/negative/informative/notice`.

**Set both WC and S2** for full coverage.

### Components

`userBubble`, `assistantMessage`, `codeBlock`, `nav`, `composer`, `sidebar`, `dialog` — each accepts `background`, `text`, `border`, `radius`, `padding`, `fontSize`, `fontFamily`, `shadow`, `blur`, `height`, `opacity`.

```json
{
  "components": {
    "userBubble": { "background": "#2563eb", "text": "#ffffff", "radius": "20px 20px 4px 20px" },
    "assistantMessage": { "background": "transparent" },
    "codeBlock": {
      "background": "#0d1117",
      "text": "#c9d1d9",
      "radius": "8px",
      "border": "#30363d"
    },
    "composer": { "background": "#1c1c1e", "border": "#3a3a3c", "radius": "20px" }
  }
}
```

### Guidelines

1. Accent on links/buttons/focus/nav — not bubbles or large surfaces.
2. User bubbles neutral (shade of bg), high-contrast text.
3. `assistantMessage`: `"background": "transparent"`.
4. Backgrounds true neutrals.
5. Nav subtle — already tinted via `color-mix`.
6. Gray scale evenly spaced (dark: ~8–12% start, +3–4%; light: 98–100% start, −2–3%).
7. Code blocks recessed.

**Pairing:** `--ctx` = `--waffle`; `--canvas` = `--s2-gray-25` = `--s2-bg-base` = `--shaderbg`; `--ink` = `--deep` = `--s2-content-default` = `--s2-gray-900`; `--ghost` = `--desk`.

**Don't:** accent bubbles, colored grays, opaque nav, low contrast, split `--deep`/`--ink`, forget `disableShader`, skip `userBubble`, change fonts/spacing/layout unless asked, use `css` for layout (colors only).

### Example (dark brand)

```json
{
  "id": "adobe-brand",
  "name": "Adobe Brand",
  "base": "dark",
  "disableShader": true,
  "tokens": {
    "--canvas": "#1b1b1b",
    "--bg": "#141414",
    "--ghost": "#242424",
    "--desk": "#242424",
    "--ink": "#e8e8e8",
    "--deep": "#e8e8e8",
    "--txt-2": "#999999",
    "--txt-3": "#666666",
    "--line": "#333333",
    "--ctx": "#eb1000",
    "--waffle": "#eb1000",
    "--shaderbg": "#1b1b1b",
    "--s2-gray-25": "#1b1b1b",
    "--s2-gray-50": "#1f1f1f",
    "--s2-gray-75": "#242424",
    "--s2-gray-100": "#2a2a2a",
    "--s2-gray-200": "#333333",
    "--s2-gray-300": "#3d3d3d",
    "--s2-gray-900": "#e8e8e8",
    "--s2-gray-1000": "#ffffff",
    "--s2-bg-base": "#1b1b1b",
    "--s2-bg-layer-1": "#1f1f1f",
    "--s2-bg-layer-2": "#242424",
    "--s2-bg-elevated": "#2a2a2a",
    "--s2-bg-sunken": "#141414",
    "--s2-content-default": "#e8e8e8",
    "--s2-content-secondary": "#a1a1a1",
    "--s2-content-tertiary": "#6e6e6e",
    "--s2-accent": "#eb1000",
    "--s2-accent-hover": "#ff3b2f",
    "--s2-accent-down": "#c40d00",
    "--s2-border-default": "#333333",
    "--s2-border-subtle": "#2a2a2a",
    "--s2-positive": "#2d9d78",
    "--s2-negative": "#e34850"
  },
  "components": {
    "userBubble": { "background": "#2a2a2a", "text": "#e8e8e8" },
    "assistantMessage": { "background": "transparent" },
    "codeBlock": { "background": "#141414", "text": "#cfcfcf", "border": "#333333" },
    "composer": { "background": "#1f1f1f" }
  }
}
```

Accent red only in `--ctx`/`--waffle`/`--s2-accent`; bubble neutral gray.

### Arbitrary CSS

`css` injects after tokens — color decorations, borders, gradients on specific elements:

```json
{
  "css": "slicc-agent-message .body a { color: #58a6ff; } .slicc-nav { border-bottom: 2px solid #f59e0b; }"
}
```

## Storage

- `localStorage['slicc-active-theme']`
- `localStorage['slicc-theme-pair']` — two ids
- `localStorage['slicc-themes']` — custom array
- Presets bundled in code
