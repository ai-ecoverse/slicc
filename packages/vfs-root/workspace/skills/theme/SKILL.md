---
name: theme
description: |
  Use this when the user wants to change the SLICC UI appearance — switch
  preset themes, create custom themes, adjust colors, toggle the animated
  background, or export/import theme files. Covers the theme settings dialog,
  preset selection, custom theme builder, and the JSON export format.
allowed-tools: bash, read_file, write_file, edit_file
---

# Theme Personalization

SLICC supports full UI theming via the **Theme settings** dialog (avatar menu → "Theme settings…").

## Preset Themes

Six built-in presets ship with SLICC:

| Name           | Base  | Vibe                                |
| -------------- | ----- | ----------------------------------- |
| Vanilla        | light | Warm cream, soft browns             |
| Midnight Scoop | dark  | Deep navy/indigo, cool blue accents |
| Matcha Float   | dark  | Dark greens, mint accents           |
| Berry Cone     | dark  | Deep purple, magenta/pink accents   |
| Caramel Swirl  | light | Warm amber/tan, golden accents      |
| Sorbet         | light | Pastel pink/peach, coral accents    |

All presets disable the animated WebGL shader background by default.

Selecting "Default" restores the original SLICC dark/light theme with the shader enabled.

## Custom Themes

Users can create custom themes with two tiers of control:

### Simplified (7 slots)

| Slot       | Controls                              |
| ---------- | ------------------------------------- |
| Background | Main canvas color                     |
| Surface    | Cards, panels, inputs                 |
| Text       | Primary text color                    |
| Accent     | Buttons, links, focus rings, nav tint |
| Border     | Dividers, separators                  |
| Success    | Positive semantic color               |
| Error      | Negative semantic color               |

These 7 values are expanded into ~40 CSS token overrides via HSL derivation.

### Advanced (per-token)

Toggle "Show advanced" to reveal individual CSS custom properties grouped by category (surfaces, text, accents, semantic, chrome). Any manually-set token overrides the derived value.

### Disable Animated Background

The "Hide animated background" checkbox removes the WebGL shader pattern and shows a solid color matching the Background slot.

## Theme File Format

Themes export as `.slicc-theme.json`:

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "base": "dark",
  "disableShader": true,
  "tokens": {
    "--canvas": "#0d1117",
    "--ink": "#e8eef5",
    "--ctx": "#58a6ff",
    "--line": "#3a4a63",
    "--s2-accent": "#58a6ff",
    ...
  }
}
```

### Key fields

- `id` — unique kebab-case slug
- `name` — display name
- `base` — `"dark"` or `"light"` (determines which unspecified tokens inherit from)
- `disableShader` — `true` to hide the animated background
- `tokens` — CSS custom property overrides (only overrides needed; unspecified tokens fall through to the base)

### Important token namespaces

The UI uses two token systems that must both be overridden:

- **S2 tokens** (`--s2-gray-*`, `--s2-bg-*`, `--s2-accent`, `--s2-content-*`, `--s2-border-*`) — used by the Spectrum 2 design layer
- **WC tokens** (`--canvas`, `--bg`, `--ink`, `--line`, `--ctx`, `--txt-2`, `--txt-3`, `--ghost`, `--shaderbg`, `--waffle`) — used by the webcomponents shell

The custom theme builder generates both automatically from the 7 simplified slots.

## Import / Export

- **Export**: "Theme settings" → My Themes → Export button → downloads `.slicc-theme.json`
- **Import**: "Theme settings" → "Import Theme…" → pick a `.json` file

## Storage

- Active theme ID: `localStorage['slicc-active-theme']`
- Custom themes: `localStorage['slicc-themes']` (JSON array)
- Presets are bundled in code (not stored)

## Shell Command

```bash
theme list                    # List all presets and custom themes
theme current                 # Show active theme id
theme apply <id>              # Apply a preset or custom theme by id
theme apply <path>            # Apply a .slicc-theme.json file from VFS
theme reset                   # Reset to default theme
theme export <id> <path>      # Export a theme to a VFS path
```

### Agent workflow for custom themes

1. Write the theme JSON to a VFS path:
   ```bash
   cat > /shared/my-theme.slicc-theme.json << 'EOF'
   {"id":"my-theme","name":"My Theme","base":"dark","disableShader":true,"tokens":{...}}
   EOF
   ```
2. Apply it:
   ```bash
   theme apply /shared/my-theme.slicc-theme.json
   ```

This avoids the native file picker — the agent reads/writes directly on the VFS.
