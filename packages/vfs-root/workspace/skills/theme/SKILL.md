---
name: theme
description: |
  Use this when the user wants to change the SLICC UI appearance — switch
  preset themes, create custom themes, adjust colors, toggle the animated
  background, or export/import theme files. Covers the theme shell command,
  full token reference, and the JSON format for programmatic theming.
allowed-tools: bash, read_file, write_file, edit_file
---

# Theme Personalization

SLICC supports full UI theming via the `theme` shell command and the Theme settings dialog (avatar menu → "Theme settings…").

## Shell Command (preferred for agent use)

```bash
theme list                    # List all preset themes
theme apply <id>              # Apply a preset by id
theme apply <path>            # Apply a .slicc-theme.json file from the VFS
theme reset                   # Reset to default theme
theme export <id> <path>      # Export a preset to a VFS path
```

### Agent workflow

1. Write a theme JSON file to the VFS
2. Apply it with `theme apply <path>`

```bash
cat > /shared/my-theme.slicc-theme.json << 'EOF'
{
  "id": "my-theme",
  "name": "My Theme",
  "base": "dark",
  "disableShader": true,
  "tokens": {
    "--canvas": "#0f0f1a",
    "--bg": "#0a0a12",
    "--ghost": "#1a1a2e",
    "--desk": "#1a1a2e",
    "--ink": "#e8e8f0",
    "--deep": "#e8e8f0",
    "--txt-2": "#9898b0",
    "--txt-3": "#6868880",
    "--line": "#2a2a40",
    "--ctx": "#6c5ce7",
    "--waffle": "#6c5ce7",
    "--shaderbg": "#0f0f1a",
    "--s2-gray-25": "#0f0f1a",
    "--s2-gray-50": "#141422",
    "--s2-gray-75": "#1a1a2e",
    "--s2-gray-100": "#20203a",
    "--s2-gray-200": "#2a2a45",
    "--s2-gray-300": "#3a3a55",
    "--s2-gray-900": "#e8e8f0",
    "--s2-gray-1000": "#ffffff",
    "--s2-bg-base": "#0f0f1a",
    "--s2-bg-layer-1": "#141422",
    "--s2-bg-layer-2": "#1a1a2e",
    "--s2-bg-elevated": "#20203a",
    "--s2-bg-sunken": "#0a0a12",
    "--s2-content-default": "#e8e8f0",
    "--s2-content-secondary": "#b8b8d0",
    "--s2-content-tertiary": "#8888a0",
    "--s2-accent": "#6c5ce7",
    "--s2-accent-hover": "#8577ed",
    "--s2-accent-down": "#5a4bd4",
    "--s2-border-default": "#2a2a40",
    "--s2-border-subtle": "#222238",
    "--s2-positive": "#2d9d78",
    "--s2-negative": "#e34850"
  }
}
EOF
theme apply /shared/my-theme.slicc-theme.json
```

## Preset Themes

| ID               | Name           | Base  | Vibe                                |
| ---------------- | -------------- | ----- | ----------------------------------- |
| `vanilla`        | Vanilla        | light | Warm cream, soft browns             |
| `midnight-scoop` | Midnight Scoop | dark  | Deep navy/indigo, cool blue accents |
| `matcha-float`   | Matcha Float   | dark  | Dark greens, mint accents           |
| `berry-cone`     | Berry Cone     | dark  | Deep purple, magenta/pink accents   |
| `caramel-swirl`  | Caramel Swirl  | light | Warm amber/tan, golden accents      |
| `sorbet`         | Sorbet         | light | Pastel pink/peach, coral accents    |

All presets disable the animated shader background.

## Theme JSON Format

```typescript
interface SliccTheme {
  id: string; // unique kebab-case slug
  name: string; // display name
  base: 'dark' | 'light'; // fallback for unspecified tokens
  disableShader?: boolean; // hide the WebGL animated background
  tokens: Record<string, string>; // CSS custom property overrides (ANY property)
  css?: string; // arbitrary CSS injected after tokens (selectors, rules, anything)
}
```

The `tokens` map can override ANY CSS custom property — not just colors. Typography, spacing, radii, shadows, transitions, layout dimensions are all fair game. The `css` field allows arbitrary CSS rules for anything tokens can't reach (element selectors, pseudo-elements, animations, media queries).

## Full Token Reference

The UI has two token systems. **Both must be set** for complete coverage:

### WC Shell Tokens (visible UI — chat, nav, panels)

| Token        | Purpose                             | Example (dark) |
| ------------ | ----------------------------------- | -------------- |
| `--canvas`   | Page/main background                | `#161618`      |
| `--bg`       | Sunken/recessed background          | `#0e0e10`      |
| `--ghost`    | Hover/subtle background             | `#1f1f22`      |
| `--desk`     | Secondary panel bg                  | `#1f1f22`      |
| `--ink`      | Primary text                        | `#f5f5f2`      |
| `--deep`     | Emphatic/bold text                  | `#f5f5f2`      |
| `--txt-2`    | Secondary text                      | `#9b9ba1`      |
| `--txt-3`    | Muted/tertiary text                 | `#6c6c72`      |
| `--line`     | Borders, dividers                   | `#2a2a2e`      |
| `--ctx`      | Accent (buttons, links, highlights) | `#f59e0b`      |
| `--waffle`   | Nav bar tint (overrides nav --ctx)  | `#f59e0b`      |
| `--shaderbg` | WebGL shader base color             | `#171410`      |

### S2 Design Tokens (Spectrum 2 layer)

| Token                     | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `--s2-gray-25` to `-1000` | Gray scale (25=darkest bg in dark mode, 1000=lightest) |
| `--s2-bg-base`            | `:root` background                                     |
| `--s2-bg-layer-1`         | First elevated layer                                   |
| `--s2-bg-layer-2`         | Second elevated layer                                  |
| `--s2-bg-elevated`        | Cards, modals                                          |
| `--s2-bg-sunken`          | Recessed areas                                         |
| `--s2-content-default`    | Primary text                                           |
| `--s2-content-secondary`  | Secondary text                                         |
| `--s2-content-tertiary`   | Muted text                                             |
| `--s2-content-disabled`   | Disabled text                                          |
| `--s2-accent`             | Primary accent                                         |
| `--s2-accent-hover`       | Accent hover state                                     |
| `--s2-accent-down`        | Accent pressed state                                   |
| `--s2-border-default`     | Default borders                                        |
| `--s2-border-subtle`      | Subtle borders                                         |
| `--s2-border-focus`       | Focus ring color                                       |
| `--s2-positive`           | Success/green                                          |
| `--s2-negative`           | Error/red                                              |
| `--s2-informative`        | Info/blue                                              |
| `--s2-notice`             | Warning/orange                                         |

### Component-Level Styling

The `components` field gives semantic control over individual UI parts. Each component accepts:

```typescript
interface ThemeComponent {
  background?: string; // CSS background (color, gradient, image)
  text?: string; // CSS color
  border?: string; // Border color (renders as 1px solid)
  radius?: string; // Border radius
  padding?: string; // Padding
  fontSize?: string; // Font size
  fontFamily?: string; // Font family
  shadow?: string; // Box shadow
  blur?: string; // Backdrop blur amount (e.g. "18px")
  height?: string; // Element height
  opacity?: string; // Opacity (0-1)
}
```

Available components:

| Key                | What it styles                            |
| ------------------ | ----------------------------------------- |
| `userBubble`       | User chat message bubble (iMessage-style) |
| `assistantMessage` | Assistant response body                   |
| `codeBlock`        | Code blocks and inline code in messages   |
| `nav`              | Top navigation bar                        |
| `composer`         | Chat input card (where user types)        |
| `sidebar`          | Side rail / sidebar panel                 |
| `dialog`           | Modal dialogs (settings, theme picker)    |

Example:

```json
{
  "components": {
    "userBubble": {
      "background": "#2563eb",
      "text": "#ffffff",
      "radius": "20px 20px 4px 20px"
    },
    "nav": {
      "background": "rgba(0,0,0,0.8)",
      "blur": "24px",
      "height": "52px"
    },
    "codeBlock": {
      "background": "#0d1117",
      "text": "#c9d1d9",
      "radius": "8px",
      "border": "#30363d"
    },
    "composer": {
      "background": "#1c1c1e",
      "border": "#3a3a3c",
      "radius": "20px"
    }
  }
}
```

### Arbitrary CSS

The `css` field injects raw CSS after everything else — use it for things components/tokens can't reach:

```json
{
  "css": "slicc-agent-message .body a { color: #58a6ff; } .slicc-nav { border-bottom: 2px solid #f59e0b; }"
}
```

### Design Guidelines

**Core principles for good-looking themes:**

1. **Accent is a highlight, not a flood.** The accent color appears on links, buttons, focus rings, and the nav tint — NOT on user bubbles, backgrounds, or large surfaces. Overusing accent makes the UI aggressive.

2. **User bubbles should be neutral.** Use a slightly lighter/darker shade of the background — never the accent. Bubble text should be high-contrast against the bubble bg.

3. **Assistant messages should be transparent.** Always set `"assistantMessage": { "background": "transparent" }` — sliccy's responses should flow naturally on the page without a visible card background.

4. **Backgrounds should be true neutrals.** Use pure grays (equal RGB) or very slightly tinted grays. Avoid colored backgrounds unless intentional.

5. **The nav bar should be subtle.** It uses `color-mix(--ctx 12%, --canvas 68%)` with blur — a strong accent already tints it. Don't set a loud nav background.

6. **Gray scale should be evenly spaced.** Dark themes: start ~8-12% lightness, step up 3-4%. Light themes: start 98-100%, step down 2-3%.

7. **Code/output blocks should be recessed.** Slightly darker (dark) or lighter (light) than background.

**Token pairing rules:**

- `--ctx` = `--waffle` (always match)
- `--canvas` = `--s2-gray-25` = `--s2-bg-base` = `--shaderbg`
- `--ink` = `--deep` = `--s2-content-default` = `--s2-gray-900`
- `--bg` slightly darker than `--canvas` (dark) or lighter (light)
- `--ghost` = `--desk` = hover bg (one step above canvas)

**Example: Adobe-inspired brand theme (done right)**

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
    "--s2-gray-400": "#4a4a4a",
    "--s2-gray-500": "#6e6e6e",
    "--s2-gray-600": "#8a8a8a",
    "--s2-gray-700": "#a1a1a1",
    "--s2-gray-800": "#cfcfcf",
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
    "--s2-content-disabled": "#4a4a4a",
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

Note: accent red is ONLY in `--ctx`/`--waffle`/`--s2-accent`. Bubble is neutral gray, assistant messages have no background card (transparent — blends with the page), code blocks are recessed.

**Example: Light brand theme (GitHub-style)**

```json
{
  "id": "github-light",
  "name": "GitHub Light",
  "base": "light",
  "disableShader": true,
  "tokens": {
    "--canvas": "#ffffff",
    "--bg": "#f6f8fa",
    "--ghost": "#f3f4f6",
    "--desk": "#f3f4f6",
    "--ink": "#1f2328",
    "--deep": "#1f2328",
    "--txt-2": "#656d76",
    "--txt-3": "#8b949e",
    "--line": "#d1d9e0",
    "--ctx": "#0969da",
    "--waffle": "#0969da",
    "--shaderbg": "#ffffff",
    "--s2-gray-25": "#ffffff",
    "--s2-gray-50": "#f6f8fa",
    "--s2-gray-75": "#f3f4f6",
    "--s2-gray-100": "#eaeef2",
    "--s2-gray-200": "#d1d9e0",
    "--s2-gray-300": "#afb8c1",
    "--s2-gray-900": "#1f2328",
    "--s2-gray-1000": "#000000",
    "--s2-bg-base": "#ffffff",
    "--s2-bg-layer-1": "#f6f8fa",
    "--s2-bg-layer-2": "#f3f4f6",
    "--s2-bg-elevated": "#ffffff",
    "--s2-bg-sunken": "#f6f8fa",
    "--s2-content-default": "#1f2328",
    "--s2-content-secondary": "#656d76",
    "--s2-content-tertiary": "#8b949e",
    "--s2-accent": "#0969da",
    "--s2-accent-hover": "#0550ae",
    "--s2-accent-down": "#033d8b",
    "--s2-border-default": "#d1d9e0",
    "--s2-border-subtle": "#eaeef2",
    "--s2-positive": "#1a7f37",
    "--s2-negative": "#cf222e"
  },
  "components": {
    "userBubble": { "background": "#1f2328", "text": "#ffffff" },
    "assistantMessage": { "background": "transparent" },
    "codeBlock": { "background": "#f6f8fa", "text": "#24292f", "border": "#d1d9e0" },
    "composer": { "background": "#ffffff" }
  }
}
```

**Common mistakes to avoid:**

- Setting bubble background to the accent color (makes every message scream)
- Using warm/colored grays for backgrounds (looks muddy)
- Making the nav bar a solid opaque color (kills the frosted glass effect)
- Not enough contrast between text and background (aim for 7:1 minimum)
- Setting `--deep` to something different from `--ink` (causes bubble text issues)
- Forgetting `"disableShader": true` (the shader fights custom backgrounds)
- Not setting `components.userBubble` (defaults to `--deep` which is the ink color — wrong for themed looks)

## Storage

- Active theme ID: `localStorage['slicc-active-theme']`
- Custom themes: `localStorage['slicc-themes']` (JSON array)
- Presets are bundled in code
